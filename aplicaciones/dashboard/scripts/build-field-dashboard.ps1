param(
  [string]$Version = (Get-Date -Format 'yyyyMMdd-HHmm'),
  [string]$CentralUrl = 'http://192.168.15.219:8787'
)

$ErrorActionPreference = 'Stop'
$dashboardSource = Split-Path -Parent $PSScriptRoot
$platformRoot = (Resolve-Path (Join-Path $dashboardSource '..\..')).Path
$distributionRoot = Join-Path $platformRoot 'distribuciones\dashboard-cpe-campo'
$packageName = "Dashboard_CPE_Campo_$Version"
$packageRoot = Join-Path $distributionRoot $packageName

if (Test-Path -LiteralPath $packageRoot) {
  throw "La distribucion ya existe: $packageRoot. Usa otra version."
}

$appTarget = Join-Path $packageRoot 'aplicaciones\dashboard'
$configTarget = Join-Path $packageRoot 'configuracion\publicacion'
$runtimeTarget = Join-Path $packageRoot 'runtime'
New-Item -ItemType Directory -Force -Path $appTarget, $configTarget, $runtimeTarget | Out-Null

Copy-Item -LiteralPath (Join-Path $dashboardSource 'server.js') -Destination $appTarget
Copy-Item -LiteralPath (Join-Path $dashboardSource 'package.json') -Destination $appTarget
Copy-Item -LiteralPath (Join-Path $dashboardSource 'package-lock.json') -Destination $appTarget
Copy-Item -LiteralPath (Join-Path $dashboardSource 'lib') -Destination $appTarget -Recurse
Copy-Item -LiteralPath (Join-Path $dashboardSource 'public') -Destination $appTarget -Recurse
Copy-Item -LiteralPath (Join-Path $dashboardSource 'node_modules') -Destination $appTarget -Recurse
Copy-Item -LiteralPath (Get-Command node).Source -Destination (Join-Path $runtimeTarget 'node.exe')

$routes = @{
  version = 1
  bases = 'datos/bases'
  programaciones = 'datos/programaciones'
  temporales = 'datos/temporales'
  catalogos = 'configuracion/catalogos'
  cargadorConfig = 'configuracion/cargador-tmo'
  reglas = 'configuracion/reglas-validacion'
  registros = 'registros'
  reportes = 'reportes'
  entregas = 'datos/entregas'
  publicacion = 'configuracion/publicacion'
  documentacion = 'documentacion'
  respaldos = 'respaldos/historicos'
}
$routes | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packageRoot 'configuracion\rutas.json') -Encoding UTF8

$publication = @{
  version = 1
  nas = @{ enabled = $false; root = '' }
  googleDrive = @{ enabled = $false; folderId = ''; serviceAccountFile = 'service-account.json' }
  field = @{ centralUrl = $CentralUrl; syncIntervalSeconds = 60 }
}
$publication | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $configTarget 'publicacion.json') -Encoding UTF8

@'
@echo off
set "CPE_HOME=%~dp0"
set "CPE_NODE_MODE=field"
set "HOST=127.0.0.1"
set "PORT=8787"
"%~dp0runtime\node.exe" "%~dp0aplicaciones\dashboard\server.js"
'@ | Set-Content -LiteralPath (Join-Path $packageRoot 'Dashboard-CPE-Campo.bat') -Encoding ASCII

@'
Set shell = CreateObject("WScript.Shell")
root = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run Chr(34) & root & "\Dashboard-CPE-Campo.bat" & Chr(34), 0, False
WScript.Sleep 1800
shell.Run "http://127.0.0.1:8787/#project", 1, False
'@ | Set-Content -LiteralPath (Join-Path $packageRoot 'Abrir Dashboard CPE Campo.vbs') -Encoding ASCII

@'
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
startup = shell.SpecialFolders("Startup")
Set shortcut = shell.CreateShortcut(startup & "\Dashboard CPE Campo.lnk")
shortcut.TargetPath = root & "\Abrir Dashboard CPE Campo.vbs"
shortcut.WorkingDirectory = root
shortcut.WindowStyle = 7
shortcut.Description = "Dashboard CPE local con sincronizacion automatica"
shortcut.Save
MsgBox "Inicio automatico instalado. No muevas esta carpeta despues de instalarlo.", 64, "Dashboard CPE Campo"
'@ | Set-Content -LiteralPath (Join-Path $packageRoot 'Instalar inicio automatico.vbs') -Encoding ASCII

@"
DASHBOARD CPE CAMPO

Esta es la edicion local del mismo Dashboard CPE. No es el Cargador TMO.

ANTES DE SALIR A CAMPO (con red/VPN):
1. Copia esta carpeta completa a una ubicacion permanente de la laptop.
2. Ejecuta "Instalar inicio automatico.vbs" una sola vez.
3. Abre "Abrir Dashboard CPE Campo.vbs".
4. En Proyecto CPE, escribe el codigo y pulsa "Guardar proyecto para campo".

EN CAMPO SIN INTERNET:
1. Abre el dashboard local en http://127.0.0.1:8787.
2. Selecciona la carpeta completa con las lecturas CPE posteriores.
3. Valida normalmente. Los CPE aprobados quedan protegidos en la cola local.

AL RECUPERAR INTERNET Y VPN:
- El dashboard intenta conectarse a $CentralUrl cada 60 segundos.
- Envia automaticamente los CPE aprobados a la VM.
- La VM publica la entrega en Google Drive y TIC NAS cuando todas las radios
  del proyecto estan aprobadas.

No guardes credenciales de Google Drive en esta laptop. Las credenciales solo
pertenecen a la VM central.
"@ | Set-Content -LiteralPath (Join-Path $packageRoot 'LEEME.txt') -Encoding UTF8

$zipPath = Join-Path $distributionRoot "$packageName.zip"
Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal
Write-Output $packageRoot
Write-Output $zipPath
