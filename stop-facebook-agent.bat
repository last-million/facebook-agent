@echo off
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$conn = Get-NetTCPConnection -LocalPort 9317 -State Listen -ErrorAction SilentlyContinue; if ($conn) { Stop-Process -Id $conn.OwningProcess -Force; Write-Host 'Dashboard stopped.' } else { Write-Host 'Dashboard was not running.' }"

timeout /t 2 >nul
exit /b 0
