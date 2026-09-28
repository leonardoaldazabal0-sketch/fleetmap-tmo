[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,

    [Parameter(Mandatory = $true)]
    [string]$DestinationRoot,

    [switch]$Commit
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

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
    throw 'El identificador del marcador no coincide.'
}
if ($marker.manifestSha256 -ne $manifestHash) {
    throw 'El SHA-256 del manifiesto no coincide con el marcador.'
}

$relativePath = [string]$manifest.programming.destinationRelativePath
if ([System.IO.Path]::IsPathRooted($relativePath)) {
    throw 'La ruta de destino debe ser relativa.'
}
if ($relativePath -match '(^|[\\/])\.\.([\\/]|$)') {
    throw 'La ruta de destino contiene segmentos no permitidos.'
}
if ($relativePath -notmatch '^Plantillas x Clientes \d{4}\\') {
    throw 'La ruta no pertenece a Plantillas x Clientes ANO.'
}

$fullRoot = [System.IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\')
$destinationDirectory = [System.IO.Path]::GetFullPath((Join-Path $fullRoot $relativePath))
$rootPrefix = "$fullRoot\"

if (-not $destinationDirectory.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'La ruta calculada queda fuera de la raiz autorizada.'
}

$validatedFiles = @()
foreach ($file in @($manifest.files)) {
    if ([System.IO.Path]::GetFileName($file.fileName) -ne $file.fileName) {
        throw "Nombre de archivo no permitido: $($file.fileName)"
    }
    if ([System.IO.Path]::GetExtension($file.fileName) -ine '.cpe') {
        throw "Extension no permitida: $($file.fileName)"
    }

    $sourcePath = Join-Path $PackagePath $file.fileName
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "No existe el archivo local: $($file.fileName)"
    }

    $sourceInfo = Get-Item -LiteralPath $sourcePath
    $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
    if ([int64]$sourceInfo.Length -ne [int64]$file.size) {
        throw "El tamano no coincide: $($file.fileName)"
    }
    if ($sourceHash -ne $file.sha256) {
        throw "El SHA-256 no coincide: $($file.fileName)"
    }

    $validatedFiles += [pscustomobject]@{
        FileName = [string]$file.fileName
        SourcePath = $sourcePath
        Size = [int64]$file.size
        Sha256 = [string]$file.sha256
    }
}

if (-not $Commit) {
    [pscustomobject]@{
        SubmissionId = $manifest.submissionId
        Mode = 'PLAN_ONLY'
        DestinationDirectory = $destinationDirectory
        FileCount = $validatedFiles.Count
        TotalBytes = ($validatedFiles | Measure-Object -Property Size -Sum).Sum
        DestinationWasModified = $false
    }

    $validatedFiles | ForEach-Object {
        [pscustomobject]@{
            FileName = $_.FileName
            Destination = Join-Path $destinationDirectory $_.FileName
            Action = 'PLAN_ONLY'
        }
    }
    exit 0
}

New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
$results = @()
$destinationWasModified = $false

foreach ($file in $validatedFiles) {
    $finalPath = Join-Path $destinationDirectory $file.FileName

    if (Test-Path -LiteralPath $finalPath -PathType Leaf) {
        $existingHash = (Get-FileHash -LiteralPath $finalPath -Algorithm SHA256).Hash
        if ($existingHash -ne $file.Sha256) {
            throw "COLISION: El destino ya existe con contenido diferente: $finalPath"
        }

        $results += [pscustomobject]@{
            FileName = $file.FileName
            Destination = $finalPath
            Action = 'ALREADY_PRESENT'
            HashVerified = $true
        }
        continue
    }

    $temporaryName = '_ingest_{0}.partial' -f ([guid]::NewGuid().ToString('N'))
    $temporaryPath = Join-Path $destinationDirectory $temporaryName

    try {
        Copy-Item -LiteralPath $file.SourcePath -Destination $temporaryPath
        $temporaryInfo = Get-Item -LiteralPath $temporaryPath
        $temporaryHash = (Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256).Hash

        if ([int64]$temporaryInfo.Length -ne $file.Size -or $temporaryHash -ne $file.Sha256) {
            throw "La copia temporal no coincide: $($file.FileName)"
        }

        Move-Item -LiteralPath $temporaryPath -Destination $finalPath
        $finalHash = (Get-FileHash -LiteralPath $finalPath -Algorithm SHA256).Hash
        if ($finalHash -ne $file.Sha256) {
            throw "La copia final no coincide: $($file.FileName)"
        }

        $destinationWasModified = $true

        $results += [pscustomobject]@{
            FileName = $file.FileName
            Destination = $finalPath
            Action = 'COPIED_ATOMICALLY'
            HashVerified = $true
        }
    }
    catch {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
        throw
    }
}

[pscustomobject]@{
    SubmissionId = $manifest.submissionId
    Mode = 'COMMIT'
    DestinationDirectory = $destinationDirectory
    FileCount = $results.Count
    TotalBytes = ($validatedFiles | Measure-Object -Property Size -Sum).Sum
    DestinationWasModified = $destinationWasModified
}

$results
