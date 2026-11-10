@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((Get-Content -LiteralPath '%~f0' -Encoding UTF8 | Select-Object -Skip 5) -join [char]10)"
pause
exit /b
# Trace Helper: проверяет версию и ставит последнюю, если у тебя старая
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$exe = Join-Path $env:LOCALAPPDATA 'Trace Helper\Trace Helper.exe'
try {
  Write-Host 'Проверяю последнюю версию...'
  $j = Invoke-RestMethod 'https://github.com/demidsev3-byte/TraceHelper/releases/latest/download/latest.json' -UseBasicParsing
  $latest = [version]$j.version
  $url = $j.platforms.'windows-x86_64'.url
  $cur = $null
  if (Test-Path $exe) { $cur = [version](Get-Item $exe).VersionInfo.ProductVersion }
  Write-Host ("Последняя: {0}   У тебя: {1}" -f $latest, $(if ($cur) { $cur } else { 'не установлен' }))
  if ($cur -and $cur -ge $latest) { Write-Host 'У тебя последняя версия, ничего делать не надо.' -ForegroundColor Green; return }
  $tmp = Join-Path $env:TEMP "TraceHelper_$($j.version)_setup.exe"
  Write-Host 'Скачиваю...'
  Invoke-WebRequest $url -OutFile $tmp -UseBasicParsing
  Get-Process 'Trace Helper' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 1
  Write-Host 'Ставлю...'
  Start-Process $tmp -ArgumentList '/S' -Wait
  Remove-Item $tmp -ErrorAction SilentlyContinue
  if (Test-Path $exe) { Start-Process $exe }
  Write-Host ("Готово: стоит Trace Helper {0}" -f $j.version) -ForegroundColor Green
} catch {
  Write-Host ("Ошибка: {0}" -f $_.Exception.Message) -ForegroundColor Red
  Write-Host 'Скачай вручную: https://github.com/demidsev3-byte/TraceHelper/releases/latest'
}
