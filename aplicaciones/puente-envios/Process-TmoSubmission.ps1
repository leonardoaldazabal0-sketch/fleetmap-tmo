[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SubmissionId,

    [string]$NasRoot = '\\192.168.7.252\tic\002 Programacion',
    [string]$RclonePath = 'C:\ProgramacionBackup\bin\rclone.exe',
    [string]$RcloneConfig = 'C:\ProgramacionBackup\config\rclone.conf',
    [string]$SqlitePath = 'C:\ProgramacionBackup\bin\sqlite3.exe',
    [string]$DatabasePath = 'C:\ProgramacionBackup\operacion\data\ingestion.sqlite',
    [string]$AtomicCopyScript = 'C:\ProgramacionBackup\operacion\scripts\Copy-TmoPackageAtomic.ps1',
    [string]$ProcessedRemoteRoot = 'gdrive_operacion:PROCESADOS',

    [switch]$CommitNas
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function ConvertTo-SqlValue {
    param([AllowNull()]$Value)

    if ($null -eq $Value) {
        return 'NULL'
    }

    return "'" + ([string]$Value).Replace("'", "''") + "'"
}

function Invoke-SqlScript {
    param(
        [string[]]$Statements,
        [string]$Name
    )

    $dataDirectory = Split-Path -Parent $DatabasePath
    $sqlPath = Join-Path $dataDirectory ("$Name.sql")
    $Statements | Set-Content -LiteralPath $sqlPath -Encoding UTF8
    $sqliteReadPath = $sqlPath.Replace('\', '/')
    $output = @(& $SqlitePath -bail $DatabasePath ".read '$sqliteReadPath'" 2>&1)

    if ($LASTEXITCODE -ne 0) {
        throw "SQLite devolvio un error: $($output -join ' ')"
    }
}

foreach ($requiredFile in @($RclonePath, $RcloneConfig, $SqlitePath, $DatabasePath, $AtomicCopyScript)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "No se encontro el archivo requerido: $requiredFile"
    }
}

$lockDirectory = 'C:\ProgramacionBackup\operacion\logs'
New-Item -ItemType Directory -Path $lockDirectory -Force | Out-Null
$lockPath = Join-Path $lockDirectory 'proceso-nas.lock'
$lockStream = $null
$quotedSubmissionId = ConvertTo-SqlValue $SubmissionId

try {
    try {
        $lockStream = [System.IO.File]::Open(
            $lockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    }
    catch {
        throw 'Ya existe otro procesamiento hacia el NAS en ejecucion.'
    }

    $query = (
        'SELECT submissionId,status,localPath,sourceRemotePath,technicianInitials ' +
        "FROM submissions WHERE submissionId=$quotedSubmissionId LIMIT 1;"
    )
    $jsonOutput = @(& $SqlitePath -json $DatabasePath $query)
    if ($LASTEXITCODE -ne 0) {
        throw 'No se pudo consultar ingestion.sqlite.'
    }
    if ($jsonOutput.Count -eq 0 -or [string]::IsNullOrWhiteSpace(($jsonOutput -join ''))) {
        throw "No existe el envio en ingestion.sqlite: $SubmissionId"
    }

    $records = @(($jsonOutput -join [Environment]::NewLine) | ConvertFrom-Json)
    $submission = $records[0]

    if ($submission.status -notin @('VALIDATED', 'COPY_ERROR', 'COPIED')) {
        throw "El estado no permite copiar al NAS: $($submission.status)"
    }
    if (-not (Test-Path -LiteralPath $submission.localPath -PathType Container)) {
        throw "No existe el paquete local: $($submission.localPath)"
    }

    if (-not $CommitNas) {
        & $AtomicCopyScript `
            -PackagePath $submission.localPath `
            -DestinationRoot $NasRoot
        exit $LASTEXITCODE
    }

    if ($submission.sourceRemotePath -notlike 'gdrive_operacion:ENTRADA/*') {
        throw "La ruta remota no pertenece a ENTRADA: $($submission.sourceRemotePath)"
    }

    $now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Invoke-SqlScript -Name "inicio-$SubmissionId" -Statements @(
        'BEGIN IMMEDIATE;'
        (
            "UPDATE submissions SET status='COPYING',lastAttemptAt=$(ConvertTo-SqlValue $now)," +
            "errorType=NULL,errorMessage=NULL WHERE submissionId=$quotedSubmissionId;"
        )
        (
            'INSERT INTO ingestion_events(submissionDbId,eventType,message) ' +
            "SELECT id,'COPYING','Inicio de copia atomica al NAS.' FROM submissions " +
            "WHERE submissionId=$quotedSubmissionId;"
        )
        'COMMIT;'
    )

    try {
        $copyOutput = @(
            & $AtomicCopyScript `
                -PackagePath $submission.localPath `
                -DestinationRoot $NasRoot `
                -Commit
        )

        $fileResults = @(
            $copyOutput | Where-Object {
                $null -ne $_ -and $_.PSObject.Properties.Name -contains 'FileName'
            }
        )
        if ($fileResults.Count -eq 0) {
            throw 'El motor de copia no devolvio resultados por archivo.'
        }
        if (@($fileResults | Where-Object { -not $_.HashVerified }).Count -gt 0) {
            throw 'Uno o mas archivos no superaron la verificacion final.'
        }

        $copySql = @('BEGIN IMMEDIATE;')
        foreach ($fileResult in $fileResults) {
            $copySql += (
                'UPDATE ingestion_files SET ' +
                "status=$(ConvertTo-SqlValue $fileResult.Action)," +
                "destinationPath=$(ConvertTo-SqlValue $fileResult.Destination)," +
                "verifiedAt=$(ConvertTo-SqlValue $now) " +
                "WHERE submissionDbId=(SELECT id FROM submissions WHERE submissionId=$quotedSubmissionId) " +
                "AND fileName=$(ConvertTo-SqlValue $fileResult.FileName);"
            )
        }
        $copySql += (
            "UPDATE submissions SET status='COPIED',copiedAt=COALESCE(copiedAt,$(ConvertTo-SqlValue $now))," +
            "errorType=NULL,errorMessage=NULL WHERE submissionId=$quotedSubmissionId;"
        )
        $copySql += (
            'INSERT INTO ingestion_events(submissionDbId,eventType,message) ' +
            "SELECT id,'COPIED','Archivos copiados y verificados en el NAS.' FROM submissions " +
            "WHERE submissionId=$quotedSubmissionId;"
        )
        $copySql += 'COMMIT;'
        Invoke-SqlScript -Name "copiado-$SubmissionId" -Statements $copySql

        $processedRemotePath = "$ProcessedRemoteRoot/$($submission.technicianInitials)/$SubmissionId"
        $moveOutput = @(
            & $RclonePath moveto `
                $submission.sourceRemotePath `
                $processedRemotePath `
                --config $RcloneConfig `
                --log-level ERROR 2>&1
        )
        if ($LASTEXITCODE -ne 0) {
            throw "Los archivos estan seguros en el NAS, pero Drive no pudo mover el envio: $($moveOutput -join ' ')"
        }

        $processedAt = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Invoke-SqlScript -Name "procesado-$SubmissionId" -Statements @(
            'BEGIN IMMEDIATE;'
            (
                "UPDATE submissions SET status='PROCESSED',sourceRemotePath=$(ConvertTo-SqlValue $processedRemotePath)," +
                "processedAt=$(ConvertTo-SqlValue $processedAt),errorType=NULL,errorMessage=NULL " +
                "WHERE submissionId=$quotedSubmissionId;"
            )
            (
                'INSERT INTO ingestion_events(submissionDbId,eventType,message) ' +
                "SELECT id,'PROCESSED','Envio archivado en PROCESADOS.' FROM submissions " +
                "WHERE submissionId=$quotedSubmissionId;"
            )
            'COMMIT;'
        )

        [pscustomobject]@{
            SubmissionId = $SubmissionId
            Status = 'PROCESSED'
            Files = $fileResults.Count
            NasRoot = $NasRoot
            DrivePath = $processedRemotePath
            CompletedAt = $processedAt
        }
        $fileResults
    }
    catch {
        $errorMessage = $_.Exception.Message
        $currentStatusOutput = @(& $SqlitePath $DatabasePath "SELECT status FROM submissions WHERE submissionId=$quotedSubmissionId;")
        $currentStatus = ($currentStatusOutput -join '').Trim()
        $errorStatus = if ($currentStatus -eq 'COPIED') { 'COPIED' } else { 'COPY_ERROR' }
        $errorAt = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

        Invoke-SqlScript -Name "error-$SubmissionId" -Statements @(
            'BEGIN IMMEDIATE;'
            (
                "UPDATE submissions SET status=$(ConvertTo-SqlValue $errorStatus)," +
                "retryCount=retryCount+1,lastAttemptAt=$(ConvertTo-SqlValue $errorAt)," +
                "errorType='PROCESSING_ERROR',errorMessage=$(ConvertTo-SqlValue $errorMessage) " +
                "WHERE submissionId=$quotedSubmissionId;"
            )
            (
                'INSERT INTO ingestion_events(submissionDbId,eventType,message) ' +
                "SELECT id,'PROCESSING_ERROR',$(ConvertTo-SqlValue $errorMessage) FROM submissions " +
                "WHERE submissionId=$quotedSubmissionId;"
            )
            'COMMIT;'
        )
        throw
    }
}
finally {
    if ($null -ne $lockStream) {
        $lockStream.Dispose()
    }
}
