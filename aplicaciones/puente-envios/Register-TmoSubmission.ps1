[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,

    [Parameter(Mandatory = $true)]
    [string]$RemotePath,

    [string]$DatabasePath = 'C:\ProgramacionBackup\operacion\data\ingestion.sqlite',

    [string]$SqlitePath = 'C:\ProgramacionBackup\bin\sqlite3.exe'
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

function Get-OptionalProperty {
    param(
        [AllowNull()]$Object,
        [string]$PropertyName
    )

    if ($null -eq $Object) {
        return $null
    }

    $property = $Object.PSObject.Properties[$PropertyName]
    if ($null -eq $property) {
        return $null
    }

    return $property.Value
}

if (-not (Test-Path -LiteralPath $SqlitePath -PathType Leaf)) {
    throw "No se encontro sqlite3.exe: $SqlitePath"
}
if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
    throw "No se encontro ingestion.sqlite: $DatabasePath"
}
if (-not (Test-Path -LiteralPath $PackagePath -PathType Container)) {
    throw "No se encontro el paquete: $PackagePath"
}

$PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
$manifestPath = Join-Path $PackagePath 'manifest.json'
$markerPath = Join-Path $PackagePath '_ENVIO_LISTO.json'

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'El paquete no contiene manifest.json.'
}
if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    throw 'El paquete no contiene _ENVIO_LISTO.json.'
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
$manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash

if ([string]::IsNullOrWhiteSpace($manifest.submissionId)) {
    throw 'El manifiesto no contiene submissionId.'
}
if ($marker.submissionId -ne $manifest.submissionId) {
    throw 'El submissionId del marcador no coincide con el manifiesto.'
}
if ($marker.manifestSha256 -ne $manifestHash) {
    throw 'El SHA-256 de manifest.json no coincide con el marcador.'
}
if ((Split-Path -Leaf $PackagePath) -ne $manifest.submissionId) {
    throw 'El nombre de la carpeta no coincide con submissionId.'
}
if ([System.IO.Path]::IsPathRooted($manifest.programming.destinationRelativePath)) {
    throw 'La ruta de destino debe ser relativa.'
}
if ($manifest.programming.destinationRelativePath -match '(^|[\\/])\.\.([\\/]|$)') {
    throw 'La ruta de destino contiene segmentos no permitidos.'
}
if ($manifest.programming.destinationRelativePath -notmatch '^Plantillas x Clientes \d{4}\\') {
    throw 'La ruta no comienza con Plantillas x Clientes ANO.'
}

$manifestFiles = @($manifest.files)
if ($manifestFiles.Count -eq 0) {
    throw 'El manifiesto no contiene archivos.'
}

$fileRecords = @()
foreach ($file in $manifestFiles) {
    if ([string]::IsNullOrWhiteSpace($file.fileName)) {
        throw 'El manifiesto contiene un nombre de archivo vacio.'
    }
    if ([System.IO.Path]::GetFileName($file.fileName) -ne $file.fileName) {
        throw "Nombre de archivo no permitido: $($file.fileName)"
    }
    if ([System.IO.Path]::GetExtension($file.fileName) -ine '.cpe') {
        throw "Extension no permitida: $($file.fileName)"
    }

    $localFile = Join-Path $PackagePath $file.fileName
    if (-not (Test-Path -LiteralPath $localFile -PathType Leaf)) {
        throw "No se encontro el archivo: $($file.fileName)"
    }

    $fileInfo = Get-Item -LiteralPath $localFile
    if ([int64]$fileInfo.Length -ne [int64]$file.size) {
        throw "El tamano no coincide: $($file.fileName)"
    }

    $localHash = (Get-FileHash -LiteralPath $localFile -Algorithm SHA256).Hash
    if ($localHash -ne $file.sha256) {
        throw "El SHA-256 no coincide: $($file.fileName)"
    }

    $fileRecords += [pscustomobject]@{
        FileName = [string]$file.fileName
        Size = [int64]$file.size
        Sha256 = [string]$file.sha256
        LocalPath = $localFile
    }
}

$quotedSubmissionId = ConvertTo-SqlValue $manifest.submissionId
$existingOutput = @(& $SqlitePath $DatabasePath "SELECT manifestSha256 FROM submissions WHERE submissionId=$quotedSubmissionId LIMIT 1;")
$existingHash = ($existingOutput -join '').Trim()
if ($LASTEXITCODE -ne 0) {
    throw 'No se pudo consultar ingestion.sqlite.'
}
if ($existingHash -and $existingHash -ne $manifestHash) {
    throw 'Ya existe un envio con el mismo submissionId y un manifiesto diferente.'
}

$now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$unitName = Get-OptionalProperty $manifest.unit 'name'
$contractorRuc = Get-OptionalProperty $manifest.contractor 'ruc'
$contractorName = Get-OptionalProperty $manifest.contractor 'folderName'
$totalBytes = ($fileRecords | Measure-Object -Property Size -Sum).Sum

$submissionValues = @(
    ConvertTo-SqlValue $manifest.submissionId
    ConvertTo-SqlValue $RemotePath
    ConvertTo-SqlValue $PackagePath
    ConvertTo-SqlValue 'VALIDATED'
    ConvertTo-SqlValue $manifest.technician.name
    ConvertTo-SqlValue $manifest.technician.initials
    ConvertTo-SqlValue $manifest.catalogVersion
    ConvertTo-SqlValue $manifest.client.ruc
    ConvertTo-SqlValue $manifest.client.legalName
    ConvertTo-SqlValue $manifest.client.folderCode
    ConvertTo-SqlValue $unitName
    ConvertTo-SqlValue $contractorRuc
    ConvertTo-SqlValue $contractorName
    ConvertTo-SqlValue $manifest.programming.type
    ConvertTo-SqlValue $manifest.programming.formNumber
    ConvertTo-SqlValue $manifest.programming.date
    ConvertTo-SqlValue $manifest.programming.destinationRelativePath
    ConvertTo-SqlValue $manifestHash
    [string]$fileRecords.Count
    [string]$totalBytes
    ConvertTo-SqlValue $now
    ConvertTo-SqlValue $now
    ConvertTo-SqlValue $now
)

$sql = @(
    'PRAGMA foreign_keys=ON;'
    'BEGIN IMMEDIATE;'
    (
        'INSERT INTO submissions (' +
        'submissionId,sourceRemotePath,localPath,status,' +
        'technicianName,technicianInitials,catalogVersion,' +
        'clientRuc,clientName,clientFolder,unitName,' +
        'contractorRuc,contractorName,programmingType,' +
        'formNumber,programmingDate,destinationRelativePath,' +
        'manifestSha256,fileCount,totalBytes,receivedAt,validatedAt,lastAttemptAt' +
        ') VALUES (' + ($submissionValues -join ',') + ') ' +
        'ON CONFLICT(submissionId) DO UPDATE SET ' +
        'sourceRemotePath=excluded.sourceRemotePath,' +
        'localPath=excluded.localPath,' +
        "status=CASE WHEN submissions.status IN ('COPIED','PROCESSED') THEN submissions.status ELSE 'VALIDATED' END," +
        'validatedAt=excluded.validatedAt,lastAttemptAt=excluded.lastAttemptAt;'
    )
)

foreach ($file in $fileRecords) {
    $fileValues = @(
        "(SELECT id FROM submissions WHERE submissionId=$quotedSubmissionId)"
        ConvertTo-SqlValue $file.FileName
        [string]$file.Size
        ConvertTo-SqlValue $file.Sha256
        ConvertTo-SqlValue $file.LocalPath
        'NULL'
        ConvertTo-SqlValue 'VALIDATED'
        ConvertTo-SqlValue $now
    )

    $sql += (
        'INSERT INTO ingestion_files (' +
        'submissionDbId,fileName,size,sha256,localPath,destinationPath,status,verifiedAt' +
        ') VALUES (' + ($fileValues -join ',') + ') ' +
        'ON CONFLICT(submissionDbId,fileName) DO UPDATE SET ' +
        'size=excluded.size,sha256=excluded.sha256,localPath=excluded.localPath,' +
        'status=excluded.status,verifiedAt=excluded.verifiedAt;'
    )
}

$sql += (
    'INSERT INTO ingestion_events (submissionDbId,eventType,message) VALUES (' +
    "(SELECT id FROM submissions WHERE submissionId=$quotedSubmissionId)," +
    "'VALIDATED','Manifiesto, tamanos y SHA-256 validados correctamente.');"
)
$sql += 'COMMIT;'

$dataDirectory = Split-Path -Parent $DatabasePath
$sqlPath = Join-Path $dataDirectory ("registro-$($manifest.submissionId).sql")
$sql | Set-Content -LiteralPath $sqlPath -Encoding UTF8
$sqliteReadPath = $sqlPath.Replace('\', '/')
$sqliteOutput = @(& $SqlitePath -bail $DatabasePath ".read '$sqliteReadPath'" 2>&1)

if ($LASTEXITCODE -ne 0) {
    throw "SQLite no pudo registrar el envio: $($sqliteOutput -join ' ')"
}

$result = & $SqlitePath -header -column $DatabasePath (
    'SELECT submissionId,status,fileCount,totalBytes,validatedAt ' +
    "FROM submissions WHERE submissionId=$quotedSubmissionId;"
)

if ($LASTEXITCODE -ne 0) {
    throw 'El envio se registro, pero no se pudo leer el resultado.'
}

$result
