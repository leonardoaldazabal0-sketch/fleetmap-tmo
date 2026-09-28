[CmdletBinding()]
param(
    [string]$RclonePath = 'C:\ProgramacionBackup\bin\rclone.exe',
    [string]$RcloneConfig = 'C:\ProgramacionBackup\config\rclone.conf',
    [string]$SqlitePath = 'C:\ProgramacionBackup\bin\sqlite3.exe',
    [string]$DatabasePath = 'C:\ProgramacionBackup\operacion\data\ingestion.sqlite',
    [string]$RegisterScript = 'C:\ProgramacionBackup\operacion\scripts\Register-TmoSubmission.ps1',
    [string]$RemoteInbox = 'gdrive_operacion:ENTRADA',
    [string]$LocalRoot = 'C:\ProgramacionBackup\operacion\recepcion',
    [string]$LogRoot = 'C:\ProgramacionBackup\operacion\logs'
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

foreach ($requiredFile in @($RclonePath, $RcloneConfig, $SqlitePath, $DatabasePath, $RegisterScript)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "No se encontro el archivo requerido: $requiredFile"
    }
}

New-Item -ItemType Directory -Path $LocalRoot -Force | Out-Null
New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null

$runId = Get-Date -Format 'yyyyMMdd_HHmmss'
$logPath = Join-Path $LogRoot "recepcion-$runId.log"
$lockPath = Join-Path $LogRoot 'recepcion.lock'
$lockStream = $null

function Write-RunLog {
    param([string]$Message)

    $line = '{0} | {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function ConvertTo-SqlValue {
    param([AllowNull()]$Value)

    if ($null -eq $Value) {
        return 'NULL'
    }

    return "'" + ([string]$Value).Replace("'", "''") + "'"
}

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
        throw 'Ya existe otra recepcion en ejecucion.'
    }

    Write-RunLog "Inicio. Bandeja: $RemoteInbox"

    $markerOutput = @(
        & $RclonePath lsf $RemoteInbox `
            --config $RcloneConfig `
            --files-only `
            --recursive `
            --include '_ENVIO_LISTO.json' `
            --log-level ERROR 2>&1
    )
    $rcloneExitCode = $LASTEXITCODE

    if ($rcloneExitCode -ne 0) {
        throw "No se pudo listar ENTRADA: $($markerOutput -join ' ')"
    }

    $markerPaths = @(
        $markerOutput |
            ForEach-Object { ([string]$_).Trim().Replace('\', '/') } |
            Where-Object { $_ -match '/_ENVIO_LISTO\.json$' } |
            Sort-Object -Unique
    )

    $downloaded = 0
    $cached = 0
    $errors = 0

    foreach ($markerPath in $markerPaths) {
        $relativePackage = $markerPath.Substring(0, $markerPath.Length - '/_ENVIO_LISTO.json'.Length)
        $parts = @($relativePackage.Split('/') | Where-Object { $_ })

        if ($parts.Count -lt 2) {
            Write-RunLog "IGNORADO: Ruta no reconocida: $relativePackage"
            continue
        }

        $technicianInitials = $parts[0]
        $submissionId = $parts[-1]

        if ($technicianInitials -notmatch '^[A-Z0-9]{2,10}$' -or $submissionId -notmatch '^ENVIO_[A-Z0-9_]+$') {
            Write-RunLog "IGNORADO: Nombre no permitido: $relativePackage"
            continue
        }

        try {
            $quotedSubmissionId = ConvertTo-SqlValue $submissionId
            $existingStatusOutput = @(
                & $SqlitePath $DatabasePath "SELECT status FROM submissions WHERE submissionId=$quotedSubmissionId LIMIT 1;"
            )
            if ($LASTEXITCODE -ne 0) {
                throw 'No se pudo consultar ingestion.sqlite.'
            }

            $existingStatus = ($existingStatusOutput -join '').Trim()
            if ($existingStatus -in @('VALIDATED', 'COPYING', 'COPIED', 'PROCESSED', 'DUPLICATE')) {
                $cached++
                Write-RunLog "REUTILIZADO: $submissionId ($existingStatus)"
                continue
            }

            $remotePackage = "$RemoteInbox/$relativePackage"
            $localPackage = Join-Path $LocalRoot $submissionId
            New-Item -ItemType Directory -Path $localPackage -Force | Out-Null

            Write-RunLog "DESCARGANDO: $remotePackage"
            $copyOutput = @(
                & $RclonePath copy $remotePackage $localPackage `
                    --config $RcloneConfig `
                    --transfers 2 `
                    --checkers 2 `
                    --retries 5 `
                    --low-level-retries 10 `
                    --log-level ERROR 2>&1
            )
            if ($LASTEXITCODE -ne 0) {
                throw "Fallo la descarga: $($copyOutput -join ' ')"
            }

            $registerOutput = @(
                & powershell.exe `
                    -NoProfile `
                    -NonInteractive `
                    -ExecutionPolicy Bypass `
                    -File $RegisterScript `
                    -PackagePath $localPackage `
                    -RemotePath $remotePackage `
                    -DatabasePath $DatabasePath `
                    -SqlitePath $SqlitePath 2>&1
            )
            if ($LASTEXITCODE -ne 0) {
                throw "Fallo la validacion: $($registerOutput -join ' ')"
            }

            $downloaded++
            Write-RunLog "VALIDADO: $submissionId"
        }
        catch {
            $errors++
            Write-RunLog "ERROR: $submissionId - $($_.Exception.Message)"
        }
    }

    Write-RunLog "Fin. Encontrados: $($markerPaths.Count). Nuevos: $downloaded. Reutilizados: $cached. Errores: $errors."

    [pscustomobject]@{
        Found = $markerPaths.Count
        DownloadedAndValidated = $downloaded
        Reused = $cached
        Errors = $errors
        LogPath = $logPath
    }
}
finally {
    if ($null -ne $lockStream) {
        $lockStream.Dispose()
    }
}
