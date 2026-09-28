[CmdletBinding()]
param(
    [switch]$ValidateOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$CentralRoot = if ($env:CPE_HOME) { [IO.Path]::GetFullPath($env:CPE_HOME) } else { [IO.Path]::GetFullPath((Join-Path $ScriptRoot '..\..')) }
$CentralRoutesPath = Join-Path $CentralRoot 'configuracion\rutas.json'
if (Test-Path -LiteralPath $CentralRoutesPath -PathType Leaf) {
    $PlatformRoot = $CentralRoot
    $RuntimeConfig = Get-Content -LiteralPath $CentralRoutesPath -Raw -Encoding UTF8 | ConvertFrom-Json
}
else {
    # Distribucion portatil para laptops: config y cola viven junto al script.
    $PlatformRoot = $ScriptRoot
    $RuntimeConfig = [pscustomobject]@{
        catalogos = 'config'
        cargadorConfig = 'config'
        programaciones = '.'
    }
}
$CatalogPath = Join-Path (Join-Path $PlatformRoot $RuntimeConfig.catalogos) 'catalogo-clientes.json'
$PilotPath = Join-Path (Join-Path $PlatformRoot $RuntimeConfig.cargadorConfig) 'piloto.json'

if (-not (Test-Path -LiteralPath $PilotPath)) {
    [System.Windows.Forms.MessageBox]::Show(
        "No se encontro la configuracion:`n$PilotPath",
        'Cargador TMO',
        'OK',
        'Error'
    ) | Out-Null
    exit 1
}

$Pilot = Get-Content -LiteralPath $PilotPath -Raw -Encoding UTF8 | ConvertFrom-Json
$DashboardUrl = if (
    $Pilot.PSObject.Properties.Name -contains 'dashboardUrl' -and
    -not [string]::IsNullOrWhiteSpace([string]$Pilot.dashboardUrl)
) { ([string]$Pilot.dashboardUrl).TrimEnd('/') } else { 'http://192.168.15.219:8787' }
if (
    $Pilot.PSObject.Properties.Name -contains 'driveCatalogPath' -and
    (Test-Path -LiteralPath $Pilot.driveCatalogPath -PathType Leaf)
) {
    $CatalogPath = $Pilot.driveCatalogPath
}

if (-not (Test-Path -LiteralPath $CatalogPath)) {
    [System.Windows.Forms.MessageBox]::Show(
        "No se encontro el catalogo:`n$CatalogPath",
        'Cargador TMO',
        'OK',
        'Error'
    ) | Out-Null
    exit 1
}

$Catalog = Get-Content -LiteralPath $CatalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
$PilotRucs = @($Catalog.structuredClients)
$AllPilotClients = @(
    $Catalog.clients |
        Where-Object { $_.estado -eq 'ACTIVO' -and $PilotRucs -contains $_.ruc } |
        Sort-Object codigoCarpeta
)

if ($ValidateOnly) {
    [pscustomobject]@{
        CatalogVersion = $Catalog.version
        CatalogClients = $Catalog.clients.Count
        PilotClients = $AllPilotClients.Count
        Technician = $Pilot.technician.name
        Initials = $Pilot.technician.initials
        ConfigPath = $PilotPath
        CatalogPath = $CatalogPath
        QueuePath = Join-Path (Join-Path $PlatformRoot $RuntimeConfig.programaciones) $Pilot.localQueue
        DashboardUrl = $DashboardUrl
    }
    exit 0
}

function Normalize-FolderName {
    param([string]$Value)

    $normalized = if ($null -eq $Value) { '' } else { $Value.Trim().ToUpperInvariant() }
    $normalized = $normalized -replace '[<>:"/\\|?*]', ' '
    $normalized = $normalized -replace '\s+', ' '
    return $normalized.Trim(' ', '.')
}

function New-Label {
    param(
        [string]$Text,
        [int]$X,
        [int]$Y,
        [int]$Width = 180
    )

    $label = New-Object System.Windows.Forms.Label
    $label.Text = $Text
    $label.Location = New-Object System.Drawing.Point($X, $Y)
    $label.Size = New-Object System.Drawing.Size($Width, 22)
    $label.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#172326')
    return $label
}

function New-ComboBox {
    param(
        [int]$X,
        [int]$Y,
        [int]$Width
    )

    $combo = New-Object System.Windows.Forms.ComboBox
    $combo.Location = New-Object System.Drawing.Point($X, $Y)
    $combo.Size = New-Object System.Drawing.Size($Width, 28)
    $combo.DropDownStyle = 'DropDownList'
    $combo.IntegralHeight = $false
    $combo.DropDownHeight = 180
    return $combo
}

function Get-SelectedClient {
    if ($ClientCombo.SelectedIndex -lt 0) {
        return $null
    }
    return $ClientCombo.SelectedItem
}

function Get-SelectedUnit {
    if ($UnitCombo.SelectedIndex -le 0) {
        return $null
    }
    return $UnitCombo.SelectedItem
}

function Get-SelectedContractor {
    if ($ContractorCombo.SelectedIndex -le 0) {
        return $null
    }
    return $ContractorCombo.SelectedItem
}

function Set-ClientItems {
    param([object[]]$Clients)

    $ClientCombo.BeginUpdate()
    try {
        $ClientCombo.Items.Clear()
        foreach ($client in $Clients) {
            [void]$ClientCombo.Items.Add($client)
        }
    }
    finally {
        $ClientCombo.EndUpdate()
    }

    if ($ClientCombo.Items.Count -eq 1) {
        $ClientCombo.SelectedIndex = 0
    }
}

function Update-Contractors {
    $client = Get-SelectedClient
    $unit = Get-SelectedUnit

    $ContractorCombo.BeginUpdate()
    try {
        $ContractorCombo.Items.Clear()
        [void]$ContractorCombo.Items.Add([pscustomobject]@{
            display = '(SIN CONTRATISTA)'
            nombreHistorico = ''
            contratistaRuc = ''
        })

        if ($null -ne $client) {
            $unitId = if ($null -eq $unit) { '' } else { [string]$unit.id }
            $relations = @(
                $client.contratistas |
                    Where-Object {
                        $_.estado -eq 'ACTIVO' -and
                        ([string]::IsNullOrWhiteSpace($_.unidadId) -or $_.unidadId -eq $unitId)
                    } |
                    Sort-Object nombreHistorico
            )

            foreach ($relation in $relations) {
                $name = Normalize-FolderName $relation.nombreHistorico
                $legalName = [string]$relation.contratistaNombrePropuesto
                $rucText = if ([string]::IsNullOrWhiteSpace($relation.contratistaRuc)) {
                    'RUC PENDIENTE'
                }
                else {
                    "RUC $($relation.contratistaRuc)"
                }
                $relation | Add-Member -NotePropertyName display -NotePropertyValue (
                    "$name - $legalName - $rucText"
                ) -Force
                [void]$ContractorCombo.Items.Add($relation)
            }
        }
    }
    finally {
        $ContractorCombo.EndUpdate()
    }

    $ContractorCombo.SelectedIndex = 0
}

function Update-ClientDetails {
    $client = Get-SelectedClient

    $UnitCombo.BeginUpdate()
    try {
        $UnitCombo.Items.Clear()
        [void]$UnitCombo.Items.Add([pscustomobject]@{ nombre = '(SIN UNIDAD)'; id = '' })

        if ($null -ne $client) {
            foreach ($unit in @($client.unidades | Where-Object { $_.activo -ne $false } | Sort-Object nombre)) {
                [void]$UnitCombo.Items.Add($unit)
            }
            $ClientInfo.Text = "RUC $($client.ruc)  |  Carpeta: $($client.codigoCarpeta)"
        }
        else {
            $ClientInfo.Text = 'Seleccione un cliente del piloto.'
        }
    }
    finally {
        $UnitCombo.EndUpdate()
    }

    $UnitCombo.SelectedIndex = 0
    Update-Contractors
    Update-Preview
}

function Update-Preview {
    try {
        $client = Get-SelectedClient
        if ($null -eq $client) {
            $PreviewBox.Text = 'Seleccione un cliente para ver la ruta.'
            return
        }

        $unit = Get-SelectedUnit
        $contractor = Get-SelectedContractor
        $formNumber = ($FormNumberBox.Text -replace '\D', '')
        $programmingType = if ($ProgrammingTypeCombo.SelectedIndex -ge 0) {
            [string]$ProgrammingTypeCombo.SelectedItem
        }
        else {
            '[TIPO]'
        }

        $category = if ($null -ne $contractor) {
            $Pilot.folderCategories.privateWithContractors
        }
        elseif ($client.tipoEntidad -eq 'PUBLICO') {
            $Pilot.folderCategories.public
        }
        else {
            $Pilot.folderCategories.private
        }

        $segments = @(
            ($Pilot.destinationRoot -replace '\{year\}', $ProgrammingDate.Value.Year),
            $category,
            (Normalize-FolderName $client.codigoCarpeta)
        )

        if ($null -ne $unit) {
            $segments += Normalize-FolderName $unit.nombre
        }
        if ($null -ne $contractor) {
            $segments += 'CONTRATISTAS'
            $segments += Normalize-FolderName $contractor.nombreHistorico
        }

        $segments += $programmingType
        $segments += if ($formNumber) { "$($Pilot.formPrefix)$formNumber" } else { 'FORM [NUMERO]' }
        $segments += "$($ProgrammingDate.Value.ToString('yyyyMMdd'))_$($Pilot.technician.initials)"
        $segments += $Pilot.finalFolder

        $PreviewBox.Text = $segments -join '\'
    }
    catch {
        $PreviewBox.Text = "No se pudo construir la vista previa: $($_.Exception.Message)"
    }
}

function Validate-Preview {
    $client = Get-SelectedClient
    if ($null -eq $client) {
        throw 'Seleccione un cliente.'
    }
    if ([string]::IsNullOrWhiteSpace($client.codigoCarpeta)) {
        throw 'El cliente no tiene un codigo de carpeta aprobado.'
    }
    if ($client.modoUnidad -eq 'CON_UNIDADES' -and $null -eq (Get-SelectedUnit)) {
        throw 'Seleccione una unidad para este cliente.'
    }
    if ($ProgrammingTypeCombo.SelectedIndex -lt 0) {
        throw 'Seleccione el tipo de programacion.'
    }
    if ($FormNumberBox.Text -notmatch '^\d+$') {
        throw 'Ingrese solamente el numero del formulario.'
    }
    if ($SelectedFiles.Items.Count -eq 0) {
        throw 'Seleccione al menos un archivo .cpe.'
    }
    if ($ProjectCodeBox.Text.Trim().ToUpperInvariant() -notmatch '^CPE-\d{8}-\d{3}$') {
        throw 'Ingrese el codigo del Proyecto CPE con formato CPE-AAAAMMDD-000.'
    }

    $StatusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#2A9D8F')
    $StatusLabel.Text = 'Datos completos. La vista previa es valida para el piloto.'
}

function Get-SelectedFileHashes {
    return @(
        $SelectedFiles.Items |
            ForEach-Object { (Get-FileHash -LiteralPath ([string]$_) -Algorithm SHA256).Hash } |
            Sort-Object
    )
}

function Reset-ProjectApproval {
    $script:ApprovedProjectCode = ''
    $script:ApprovedFileHashes = @()
    $script:LastValidationResults = @()
    if ($null -ne $CreatePackageButton) {
        $CreatePackageButton.Enabled = $false
    }
    if ($null -ne $SendDriveButton) {
        $SendDriveButton.Enabled = $false
    }
}

function Invoke-DashboardRadioValidation {
    param(
        [string]$ProjectCode,
        [string]$FilePath
    )

    $payload = [ordered]@{
        projectCode = $ProjectCode
        programmer = [string]$Pilot.technician.name
        source = 'CARGADOR_TMO'
        fileName = [IO.Path]::GetFileName($FilePath)
        fileBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($FilePath))
    }
    $json = $payload | ConvertTo-Json -Depth 6 -Compress
    $body = [Text.Encoding]::UTF8.GetBytes($json)
    try {
        return Invoke-RestMethod `
            -Uri "$DashboardUrl/api/cpe-projects/radio-validation" `
            -Method Post `
            -ContentType 'application/json; charset=utf-8' `
            -Body $body `
            -TimeoutSec 90
    }
    catch {
        $message = $_.Exception.Message
        if ($_.ErrorDetails.Message) {
            try {
                $details = $_.ErrorDetails.Message | ConvertFrom-Json
                if ($details.error) { $message = [string]$details.error }
            }
            catch {}
        }
        throw "No se pudo validar $([IO.Path]::GetFileName($FilePath)): $message"
    }
}

function Validate-SelectedProjectFiles {
    Validate-Preview
    Reset-ProjectApproval
    $projectCode = $ProjectCodeBox.Text.Trim().ToUpperInvariant()
    $files = @($SelectedFiles.Items | ForEach-Object { [string]$_ })
    $results = @()
    $failed = @()

    for ($index = 0; $index -lt $files.Count; $index++) {
        $filePath = $files[$index]
        $StatusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#5B6970')
        $StatusLabel.Text = "Validando $($index + 1) de $($files.Count): $([IO.Path]::GetFileName($filePath))"
        [System.Windows.Forms.Application]::DoEvents()
        $response = Invoke-DashboardRadioValidation -ProjectCode $projectCode -FilePath $filePath
        $results += $response.validation
        if ($response.validation.status -ne 'APROBADO') {
            $checks = @($response.validation.result.checks | Where-Object { -not $_.passed })
            $detail = @($checks | ForEach-Object { $_.label }) -join ', '
            $failed += "$([IO.Path]::GetFileName($filePath)): $detail"
        }
    }

    $script:LastValidationResults = $results
    if ($failed.Count -gt 0) {
        throw "Hay $($failed.Count) radio(s) no aprobada(s): $($failed -join ' | ')"
    }
    $script:ApprovedProjectCode = $projectCode
    $script:ApprovedFileHashes = @(Get-SelectedFileHashes)
    $CreatePackageButton.Enabled = $true
    return $results
}

function New-SubmissionPackage {
    Validate-Preview
    Update-Preview

    $projectCode = $ProjectCodeBox.Text.Trim().ToUpperInvariant()
    $currentHashes = @(Get-SelectedFileHashes)
    if ($script:ApprovedProjectCode -ne $projectCode) {
        throw 'Valide primero estas radios con el Proyecto CPE.'
    }
    if (($currentHashes -join '|') -ne (@($script:ApprovedFileHashes) -join '|')) {
        throw 'Los archivos seleccionados cambiaron. Vuelva a validarlos antes de crear el paquete.'
    }

    $client = Get-SelectedClient
    $unit = Get-SelectedUnit
    $contractor = Get-SelectedContractor
    $selectedPaths = @($SelectedFiles.Items | ForEach-Object { [string]$_ })
    $duplicateNames = @(
        $selectedPaths |
            ForEach-Object { [System.IO.Path]::GetFileName($_).ToUpperInvariant() } |
            Group-Object |
            Where-Object Count -gt 1 |
            ForEach-Object Name
    )

    if ($duplicateNames.Count -gt 0) {
        throw "Hay archivos con nombres repetidos: $($duplicateNames -join ', ')."
    }

    $submissionId = 'ENVIO_{0}_{1}_{2}' -f (
        (Get-Date).ToString('yyyyMMdd_HHmmss'),
        $Pilot.technician.initials,
        ([guid]::NewGuid().ToString('N').Substring(0, 8).ToUpperInvariant())
    )
    $queueRoot = Join-Path (Join-Path $PlatformRoot $RuntimeConfig.programaciones) $Pilot.localQueue
    $temporaryDirectory = Join-Path $queueRoot (".$submissionId.partial")
    $finalDirectory = Join-Path $queueRoot $submissionId

    New-Item -ItemType Directory -Path $queueRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null

    try {
        $fileRecords = @()
        foreach ($sourcePath in $selectedPaths) {
            if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
                throw "No se encontro el archivo: $sourcePath"
            }
            if ([System.IO.Path]::GetExtension($sourcePath) -ine '.cpe') {
                throw "El archivo no tiene extension .cpe: $sourcePath"
            }

            $sourceFile = Get-Item -LiteralPath $sourcePath
            $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
            $destinationFile = Join-Path $temporaryDirectory $sourceFile.Name
            Copy-Item -LiteralPath $sourcePath -Destination $destinationFile
            $destinationHash = (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash

            if ($sourceHash -ne $destinationHash) {
                throw "La copia local no coincide con el archivo original: $($sourceFile.Name)"
            }

            $fileRecords += [ordered]@{
                fileName = $sourceFile.Name
                size = $sourceFile.Length
                sha256 = $sourceHash
                lastWriteTime = $sourceFile.LastWriteTime.ToString('o')
            }
        }

        $unitRecord = if ($null -eq $unit) {
            $null
        }
        else {
            [ordered]@{
                id = $unit.id
                name = $unit.nombre
            }
        }
        $contractorRecord = if ($null -eq $contractor) {
            $null
        }
        else {
            [ordered]@{
                id = $contractor.id
                folderName = $contractor.nombreHistorico
                ruc = $contractor.contratistaRuc
                legalName = $contractor.contratistaNombrePropuesto
            }
        }

        $manifest = [ordered]@{
            schemaVersion = '2.0'
            submissionId = $submissionId
            createdAt = (Get-Date).ToString('o')
            status = 'READY'
            catalogVersion = $Catalog.version
            technician = [ordered]@{
                name = $Pilot.technician.name
                initials = $Pilot.technician.initials
            }
            client = [ordered]@{
                ruc = $client.ruc
                legalName = $client.razonSocial
                folderCode = $client.codigoCarpeta
                entityType = $client.tipoEntidad
            }
            unit = $unitRecord
            contractor = $contractorRecord
            programming = [ordered]@{
                type = [string]$ProgrammingTypeCombo.SelectedItem
                formNumber = [int]$FormNumberBox.Text
                date = $ProgrammingDate.Value.ToString('yyyy-MM-dd')
                destinationRelativePath = $PreviewBox.Text
            }
            projectCpe = [ordered]@{
                code = $projectCode
                validationStatus = 'APROBADO'
                validatedAt = (Get-Date).ToString('o')
                dashboardUrl = $DashboardUrl
                radios = @($script:LastValidationResults | ForEach-Object {
                    [ordered]@{
                        expectedIssi = $_.expectedIssi
                        actualIssi = $_.actualIssi
                        status = $_.status
                        fileSha256 = $_.fileSha256
                    }
                })
            }
            files = $fileRecords
        }

        $manifestPath = Join-Path $temporaryDirectory 'manifest.json'
        $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
        $manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash

        $readyMarker = [ordered]@{
            schemaVersion = '1.0'
            submissionId = $submissionId
            readyAt = (Get-Date).ToString('o')
            manifestFile = 'manifest.json'
            manifestSha256 = $manifestHash
            fileCount = $fileRecords.Count
        }
        $readyMarker |
            ConvertTo-Json -Depth 5 |
            Set-Content -LiteralPath (Join-Path $temporaryDirectory $Pilot.readyMarker) -Encoding UTF8

        Move-Item -LiteralPath $temporaryDirectory -Destination $finalDirectory
        return $finalDirectory
    }
    catch {
        if (Test-Path -LiteralPath $temporaryDirectory) {
            Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
        }
        throw
    }
}

function Send-PackageToGoogleDrive {
    param([string]$LocalPackagePath)

    if ([string]::IsNullOrWhiteSpace($LocalPackagePath)) {
        throw 'Primero cree un paquete local.'
    }
    if (-not (Test-Path -LiteralPath $LocalPackagePath -PathType Container)) {
        throw "No se encontro el paquete local: $LocalPackagePath"
    }
    if (
        $Pilot.PSObject.Properties.Name -notcontains 'driveInboxPath' -or
        [string]::IsNullOrWhiteSpace($Pilot.driveInboxPath)
    ) {
        throw 'No se configuro la ruta de ENTRADA de Google Drive.'
    }
    if (-not (Test-Path -LiteralPath $Pilot.driveInboxPath -PathType Container)) {
        throw "Google Drive no esta disponible en: $($Pilot.driveInboxPath)"
    }

    $packageName = Split-Path -Leaf $LocalPackagePath
    $destinationPackage = Join-Path $Pilot.driveInboxPath $packageName
    $markerName = [string]$Pilot.readyMarker
    $sourceMarker = Join-Path $LocalPackagePath $markerName

    if (-not (Test-Path -LiteralPath $sourceMarker -PathType Leaf)) {
        throw "El paquete no contiene $markerName."
    }

    New-Item -ItemType Directory -Path $destinationPackage -Force | Out-Null
    $payloadFiles = @(
        Get-ChildItem -LiteralPath $LocalPackagePath -File |
            Where-Object { $_.Name -ne $markerName } |
            Sort-Object Name
    )

    foreach ($sourceFile in $payloadFiles) {
        $destinationFile = Join-Path $destinationPackage $sourceFile.Name
        $sourceHash = (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash

        if (Test-Path -LiteralPath $destinationFile -PathType Leaf) {
            $destinationHash = (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash
            if ($sourceHash -ne $destinationHash) {
                throw "COLISION EN DRIVE: Ya existe un archivo diferente: $($sourceFile.Name)"
            }
            continue
        }

        Copy-Item -LiteralPath $sourceFile.FullName -Destination $destinationFile
        $destinationHash = (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash
        if ($sourceHash -ne $destinationHash) {
            throw "La copia a Google Drive no coincide: $($sourceFile.Name)"
        }
    }

    $destinationMarker = Join-Path $destinationPackage $markerName
    $sourceMarkerHash = (Get-FileHash -LiteralPath $sourceMarker -Algorithm SHA256).Hash
    if (Test-Path -LiteralPath $destinationMarker -PathType Leaf) {
        $destinationMarkerHash = (Get-FileHash -LiteralPath $destinationMarker -Algorithm SHA256).Hash
        if ($sourceMarkerHash -ne $destinationMarkerHash) {
            throw "COLISION EN DRIVE: El marcador existente es diferente."
        }
    }
    else {
        Copy-Item -LiteralPath $sourceMarker -Destination $destinationMarker
        $destinationMarkerHash = (Get-FileHash -LiteralPath $destinationMarker -Algorithm SHA256).Hash
        if ($sourceMarkerHash -ne $destinationMarkerHash) {
            throw 'El marcador copiado a Google Drive no coincide.'
        }
    }

    return $destinationPackage
}

$Form = New-Object System.Windows.Forms.Form
$Form.Text = 'Cargador TMO - Piloto'
$Form.StartPosition = 'CenterScreen'
$Form.Size = New-Object System.Drawing.Size(1020, 850)
$Form.MinimumSize = New-Object System.Drawing.Size(1020, 850)
$Form.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#F4F7F8')
$Form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

$Header = New-Object System.Windows.Forms.Panel
$Header.Dock = 'Top'
$Header.Height = 88
$Header.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#005F73')
$Form.Controls.Add($Header)

$Title = New-Object System.Windows.Forms.Label
$Title.Text = 'Cargador TMO'
$Title.Location = New-Object System.Drawing.Point(28, 16)
$Title.Size = New-Object System.Drawing.Size(500, 32)
$Title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 20)
$Title.ForeColor = [System.Drawing.Color]::White
$Header.Controls.Add($Title)

$Subtitle = New-Object System.Windows.Forms.Label
$Subtitle.Text = 'Preparacion ordenada de codeplugs para FleetMap'
$Subtitle.Location = New-Object System.Drawing.Point(31, 51)
$Subtitle.Size = New-Object System.Drawing.Size(580, 24)
$Subtitle.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#E9F1F3')
$Header.Controls.Add($Subtitle)

$TechnicianBadge = New-Object System.Windows.Forms.Label
$TechnicianBadge.Text = "TECNICO: $($Pilot.technician.name) ($($Pilot.technician.initials))"
$TechnicianBadge.Location = New-Object System.Drawing.Point(690, 28)
$TechnicianBadge.Size = New-Object System.Drawing.Size(285, 30)
$TechnicianBadge.TextAlign = 'MiddleCenter'
$TechnicianBadge.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#E9F1F3')
$TechnicianBadge.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#005F73')
$Header.Controls.Add($TechnicianBadge)

$Panel = New-Object System.Windows.Forms.Panel
$Panel.Location = New-Object System.Drawing.Point(24, 108)
$Panel.Size = New-Object System.Drawing.Size(950, 680)
$Panel.BackColor = [System.Drawing.Color]::White
$Panel.BorderStyle = 'FixedSingle'
$Form.Controls.Add($Panel)

$Panel.Controls.Add((New-Label 'Buscar cliente por nombre o RUC' 24 20 260))
$SearchBox = New-Object System.Windows.Forms.TextBox
$SearchBox.Location = New-Object System.Drawing.Point(24, 45)
$SearchBox.Size = New-Object System.Drawing.Size(430, 28)
$Panel.Controls.Add($SearchBox)

$PilotNote = New-Object System.Windows.Forms.Label
$PilotNote.Text = "$($AllPilotClients.Count) clientes aprobados y disponibles"
$PilotNote.Location = New-Object System.Drawing.Point(480, 48)
$PilotNote.Size = New-Object System.Drawing.Size(420, 24)
$PilotNote.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#5B6970')
$Panel.Controls.Add($PilotNote)

$Panel.Controls.Add((New-Label 'Cliente' 24 83))
$ClientCombo = New-ComboBox 24 106 875
$ClientCombo.DisplayMember = 'nombreMostrar'
$Panel.Controls.Add($ClientCombo)

$ClientInfo = New-Object System.Windows.Forms.Label
$ClientInfo.Location = New-Object System.Drawing.Point(25, 139)
$ClientInfo.Size = New-Object System.Drawing.Size(875, 22)
$ClientInfo.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#5B6970')
$Panel.Controls.Add($ClientInfo)

$Panel.Controls.Add((New-Label 'Unidad' 24 174))
$UnitCombo = New-ComboBox 24 198 420
$UnitCombo.DisplayMember = 'nombre'
$Panel.Controls.Add($UnitCombo)

$Panel.Controls.Add((New-Label 'Contratista (opcional)' 479 174 220))
$ContractorCombo = New-ComboBox 479 198 420
$ContractorCombo.DisplayMember = 'display'
$Panel.Controls.Add($ContractorCombo)

$Panel.Controls.Add((New-Label 'Tipo de programacion' 24 240 210))
$ProgrammingTypeCombo = New-ComboBox 24 264 260
foreach ($type in $Pilot.programmingTypes) {
    [void]$ProgrammingTypeCombo.Items.Add([string]$type)
}
$Panel.Controls.Add($ProgrammingTypeCombo)

$Panel.Controls.Add((New-Label 'Numero de formulario' 310 240 200))
$FormNumberBox = New-Object System.Windows.Forms.TextBox
$FormNumberBox.Location = New-Object System.Drawing.Point(310, 264)
$FormNumberBox.Size = New-Object System.Drawing.Size(190, 28)
$Panel.Controls.Add($FormNumberBox)

$Panel.Controls.Add((New-Label 'Fecha de programacion' 526 240 200))
$ProgrammingDate = New-Object System.Windows.Forms.DateTimePicker
$ProgrammingDate.Location = New-Object System.Drawing.Point(526, 264)
$ProgrammingDate.Size = New-Object System.Drawing.Size(220, 28)
$ProgrammingDate.Format = 'Short'
$Panel.Controls.Add($ProgrammingDate)

$Panel.Controls.Add((New-Label 'Iniciales' 772 240 100))
$InitialsBox = New-Object System.Windows.Forms.TextBox
$InitialsBox.Location = New-Object System.Drawing.Point(772, 264)
$InitialsBox.Size = New-Object System.Drawing.Size(127, 28)
$InitialsBox.ReadOnly = $true
$InitialsBox.Text = $Pilot.technician.initials
$InitialsBox.TextAlign = 'Center'
$Panel.Controls.Add($InitialsBox)

$Panel.Controls.Add((New-Label 'Codigo del Proyecto CPE' 24 307 220))
$ProjectCodeBox = New-Object System.Windows.Forms.TextBox
$ProjectCodeBox.Location = New-Object System.Drawing.Point(24, 331)
$ProjectCodeBox.Size = New-Object System.Drawing.Size(270, 28)
$ProjectCodeBox.CharacterCasing = 'Upper'
$ProjectCodeBox.MaxLength = 16
$Panel.Controls.Add($ProjectCodeBox)

$DashboardInfo = New-Object System.Windows.Forms.Label
$DashboardInfo.Text = "Filtro central: $DashboardUrl"
$DashboardInfo.Location = New-Object System.Drawing.Point(320, 334)
$DashboardInfo.Size = New-Object System.Drawing.Size(579, 24)
$DashboardInfo.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#5B6970')
$Panel.Controls.Add($DashboardInfo)

$SelectFilesButton = New-Object System.Windows.Forms.Button
$SelectFilesButton.Text = 'Seleccionar archivos .cpe'
$SelectFilesButton.Location = New-Object System.Drawing.Point(24, 378)
$SelectFilesButton.Size = New-Object System.Drawing.Size(225, 36)
$SelectFilesButton.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#005F73')
$SelectFilesButton.ForeColor = [System.Drawing.Color]::White
$SelectFilesButton.FlatStyle = 'Flat'
$Panel.Controls.Add($SelectFilesButton)

$SelectedFiles = New-Object System.Windows.Forms.ListBox
$SelectedFiles.Location = New-Object System.Drawing.Point(270, 374)
$SelectedFiles.Size = New-Object System.Drawing.Size(629, 70)
$Panel.Controls.Add($SelectedFiles)

$Panel.Controls.Add((New-Label 'Ruta que se generara' 24 457 220))
$PreviewBox = New-Object System.Windows.Forms.TextBox
$PreviewBox.Location = New-Object System.Drawing.Point(24, 482)
$PreviewBox.Size = New-Object System.Drawing.Size(875, 62)
$PreviewBox.Multiline = $true
$PreviewBox.ReadOnly = $true
$PreviewBox.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#E9F1F3')
$Panel.Controls.Add($PreviewBox)

$ValidateButton = New-Object System.Windows.Forms.Button
$ValidateButton.Text = 'Validar con Dashboard'
$ValidateButton.Location = New-Object System.Drawing.Point(236, 565)
$ValidateButton.Size = New-Object System.Drawing.Size(200, 40)
$ValidateButton.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#EE9B00')
$ValidateButton.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#172326')
$ValidateButton.FlatStyle = 'Flat'
$Panel.Controls.Add($ValidateButton)

$CreatePackageButton = New-Object System.Windows.Forms.Button
$CreatePackageButton.Text = 'Crear paquete local'
$CreatePackageButton.Location = New-Object System.Drawing.Point(455, 565)
$CreatePackageButton.Size = New-Object System.Drawing.Size(200, 40)
$CreatePackageButton.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#2A9D8F')
$CreatePackageButton.ForeColor = [System.Drawing.Color]::White
$CreatePackageButton.FlatStyle = 'Flat'
$CreatePackageButton.Enabled = $false
$Panel.Controls.Add($CreatePackageButton)

$SendDriveButton = New-Object System.Windows.Forms.Button
$SendDriveButton.Text = 'Enviar a Google Drive'
$SendDriveButton.Location = New-Object System.Drawing.Point(674, 565)
$SendDriveButton.Size = New-Object System.Drawing.Size(225, 40)
$SendDriveButton.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#005F73')
$SendDriveButton.ForeColor = [System.Drawing.Color]::White
$SendDriveButton.FlatStyle = 'Flat'
$SendDriveButton.Enabled = $false
$Panel.Controls.Add($SendDriveButton)

$StatusLabel = New-Object System.Windows.Forms.Label
$StatusLabel.Text = 'Complete los datos y valide todas las radios con el Proyecto CPE.'
$StatusLabel.Location = New-Object System.Drawing.Point(24, 612)
$StatusLabel.Size = New-Object System.Drawing.Size(875, 48)
$StatusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#CA6702')
$Panel.Controls.Add($StatusLabel)

$SearchBox.Add_TextChanged({
    $query = $SearchBox.Text.Trim().ToUpperInvariant()
    if ([string]::IsNullOrWhiteSpace($query)) {
        Set-ClientItems $AllPilotClients
        return
    }

    $filtered = @(
        $AllPilotClients | Where-Object {
            $terms = @($_.terminosBusqueda) + @($_.nombreMostrar, $_.codigoCarpeta, $_.ruc)
            (($terms -join ' ').ToUpperInvariant()).Contains($query)
        }
    )
    Set-ClientItems $filtered
})

$ClientCombo.Add_SelectedIndexChanged({ Update-ClientDetails })
$UnitCombo.Add_SelectedIndexChanged({ Update-Contractors; Update-Preview })
$ContractorCombo.Add_SelectedIndexChanged({ Update-Preview })
$ProgrammingTypeCombo.Add_SelectedIndexChanged({ Update-Preview })
$FormNumberBox.Add_TextChanged({ Update-Preview })
$ProgrammingDate.Add_ValueChanged({ Update-Preview })
$ProjectCodeBox.Add_TextChanged({ Reset-ProjectApproval })

$SelectFilesButton.Add_Click({
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = 'Seleccione uno o varios archivos CPE'
    $dialog.Filter = 'Codeplugs CPE (*.cpe)|*.cpe'
    $dialog.Multiselect = $true

    if ($dialog.ShowDialog() -eq 'OK') {
        $SelectedFiles.Items.Clear()
        foreach ($file in $dialog.FileNames) {
            [void]$SelectedFiles.Items.Add($file)
        }
        Reset-ProjectApproval
        $StatusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#5B6970')
        $StatusLabel.Text = "$($dialog.FileNames.Count) archivo(s) seleccionado(s)."
    }
})

$ValidateButton.Add_Click({
    try {
        $ValidateButton.Enabled = $false
        $results = @(Validate-SelectedProjectFiles)
        $StatusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#2A9D8F')
        $StatusLabel.Text = "$($results.Count) radio(s) aprobada(s). Ya puede crear el paquete local."
        [System.Windows.Forms.MessageBox]::Show(
            "Todas las radios fueron aprobadas por el Proyecto CPE $($ProjectCodeBox.Text.Trim().ToUpperInvariant()).",
            'Validacion aprobada',
            'OK',
            'Information'
        ) | Out-Null
    }
    catch {
        $StatusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#BB3E03')
        $StatusLabel.Text = $_.Exception.Message
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'Radios no aprobadas',
            'OK',
            'Error'
        ) | Out-Null
    }
    finally {
        $ValidateButton.Enabled = $true
    }
})

$CreatePackageButton.Add_Click({
    try {
        $packagePath = New-SubmissionPackage
        $StatusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#2A9D8F')
        $StatusLabel.Text = "Paquete creado: $([System.IO.Path]::GetFileName($packagePath))"
        $script:LastPackagePath = $packagePath
        $SendDriveButton.Enabled = $true
        [System.Windows.Forms.MessageBox]::Show(
            "El paquete local se creo correctamente.`n`n$packagePath`n`nLos archivos originales no fueron movidos.",
            'Cargador TMO',
            'OK',
            'Information'
        ) | Out-Null
    }
    catch {
        $StatusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#BB3E03')
        $StatusLabel.Text = $_.Exception.Message
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'No se pudo crear el paquete',
            'OK',
            'Error'
        ) | Out-Null
    }
})

$SendDriveButton.Add_Click({
    try {
        $drivePath = Send-PackageToGoogleDrive -LocalPackagePath $script:LastPackagePath
        $StatusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#2A9D8F')
        $StatusLabel.Text = 'Paquete entregado a Google Drive. La sincronizacion continuara en segundo plano.'
        $SendDriveButton.Enabled = $false
        [System.Windows.Forms.MessageBox]::Show(
            "El paquete fue copiado a Google Drive:`n`n$drivePath`n`nPuede cerrar el cargador. Google Drive terminara la sincronizacion.",
            'Envio preparado',
            'OK',
            'Information'
        ) | Out-Null
    }
    catch {
        $StatusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#BB3E03')
        $StatusLabel.Text = $_.Exception.Message
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'No se pudo enviar a Google Drive',
            'OK',
            'Error'
        ) | Out-Null
    }
})

Set-ClientItems $AllPilotClients
$script:LastPackagePath = $null
$script:ApprovedProjectCode = ''
$script:ApprovedFileHashes = @()
$script:LastValidationResults = @()
$ProgrammingTypeCombo.SelectedIndex = 0
Update-ClientDetails

[void]$Form.ShowDialog()
