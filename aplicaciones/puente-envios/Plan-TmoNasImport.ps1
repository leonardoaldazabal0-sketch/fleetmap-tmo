[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SubmissionId,

    [string]$NasRoot = '\\192.168.7.252\tic\002 Programacion',

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

if (-not (Test-Path -LiteralPath $SqlitePath -PathType Leaf)) {
    throw "No se encontro sqlite3.exe: $SqlitePath"
}
if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
    throw "No se encontro ingestion.sqlite: $DatabasePath"
}

$quotedSubmissionId = ConvertTo-SqlValue $SubmissionId
$query = (
    'SELECT submissionId,status,localPath,destinationRelativePath,fileCount,totalBytes ' +
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

if ($submission.status -notin @('VALIDATED', 'COPYING')) {
    throw "El envio no esta listo para importar. Estado: $($submission.status)"
}
if (-not (Test-Path -LiteralPath $submission.localPath -PathType Container)) {
    throw "No existe el paquete local: $($submission.localPath)"
}

$manifestPath = Join-Path $submission.localPath 'manifest.json'
$markerPath = Join-Path $submission.localPath '_ENVIO_LISTO.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'El paquete no contiene manifest.json.'
}
if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    throw 'El paquete no contiene _ENVIO_LISTO.json.'
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
$manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash

if ($manifest.submissionId -ne $SubmissionId -or $marker.submissionId -ne $SubmissionId) {
    throw 'El identificador no coincide entre la base y el paquete.'
}
if ($marker.manifestSha256 -ne $manifestHash) {
    throw 'El SHA-256 del manifiesto no coincide con el marcador.'
}
if ($manifest.programming.destinationRelativePath -ne $submission.destinationRelativePath) {
    throw 'La ruta del manifiesto no coincide con la registrada en SQLite.'
}

$relativePath = [string]$submission.destinationRelativePath
if ([System.IO.Path]::IsPathRooted($relativePath)) {
    throw 'La ruta registrada no es relativa.'
}
if ($relativePath -match '(^|[\\/])\.\.([\\/]|$)') {
    throw 'La ruta registrada contiene segmentos no permitidos.'
}
if ($relativePath -notmatch '^Plantillas x Clientes \d{4}\\') {
    throw 'La ruta no pertenece a Plantillas x Clientes ANO.'
}

$normalizedRoot = [System.IO.Path]::GetFullPath($NasRoot).TrimEnd('\')
$destinationDirectory = [System.IO.Path]::GetFullPath((Join-Path $normalizedRoot $relativePath))
$rootPrefix = "$normalizedRoot\"

if (-not $destinationDirectory.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'La ruta calculada queda fuera de la raiz autorizada del NAS.'
}

$plans = @()
foreach ($file in @($manifest.files)) {
    if ([System.IO.Path]::GetFileName($file.fileName) -ne $file.fileName) {
        throw "Nombre de archivo no permitido: $($file.fileName)"
    }

    $sourcePath = Join-Path $submission.localPath $file.fileName
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "No existe el archivo local: $($file.fileName)"
    }

    $sourceInfo = Get-Item -LiteralPath $sourcePath
    $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
    if ([int64]$sourceInfo.Length -ne [int64]$file.size -or $sourceHash -ne $file.sha256) {
        throw "El archivo local ya no coincide con el manifiesto: $($file.fileName)"
    }

    $plans += [pscustomobject]@{
        SubmissionId = $SubmissionId
        Source = $sourcePath
        Destination = Join-Path $destinationDirectory $file.fileName
        Size = [int64]$file.size
        Sha256 = [string]$file.sha256
        Action = 'PLAN_ONLY'
    }
}

[pscustomobject]@{
    SubmissionId = $SubmissionId
    CurrentStatus = $submission.status
    NasRoot = $normalizedRoot
    DestinationDirectory = $destinationDirectory
    FileCount = $plans.Count
    TotalBytes = ($plans | Measure-Object -Property Size -Sum).Sum
    NasWasAccessed = $false
}

$plans | Select-Object SubmissionId, Source, Destination, Size, Action
