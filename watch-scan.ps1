$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

while ($true) {
  $status = node scripts\db-status.js | ConvertFrom-Json
  Clear-Host
  Write-Host "CPE Dashboard - Escaneo central" -ForegroundColor Cyan
  Write-Host "Actualizado:      $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  Write-Host "Base SQLite:      $($status.databasePath)"
  Write-Host "Archivos BD:      $($status.indexedFiles)"
  Write-Host "Grupos guardados: $($status.storedGroups)"
  Write-Host "Archivos error:   $($status.errorFiles)"
  Write-Host ""

  if ($null -eq $status.latestScan) {
    Write-Host "No existe un escaneo registrado." -ForegroundColor Yellow
    break
  }

  $run = $status.latestScan
  Write-Host "Ruta central:     $($run.rootPath)"
  Write-Host "Carpeta actual:   $($status.currentFolder)" -ForegroundColor Cyan
  Write-Host "Archivo reciente: $($status.currentFile)"
  Write-Host "Inicio:           $($run.startedAt)"
  Write-Host "Encontrados:      $($run.foundCount)"
  Write-Host "Analizados:       $($run.parsedCount)"
  Write-Host "Cacheados:        $($run.cachedCount)"
  Write-Host "Errores:          $($run.errorCount)"

  if ($run.finishedAt) {
    Write-Host ""
    Write-Host "ESCANEO TERMINADO: $($run.finishedAt)" -ForegroundColor Green
    break
  }

  Write-Host ""
  Write-Host "Escaneo en curso. Actualizando cada 15 segundos..." -ForegroundColor Yellow
  Start-Sleep -Seconds 15
}

Write-Host ""
Read-Host "Presiona Enter para cerrar"
