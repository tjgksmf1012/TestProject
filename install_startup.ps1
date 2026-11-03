[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ws = New-Object -ComObject WScript.Shell
$target = Join-Path $PSScriptRoot "start_live.bat"
$startupFolder = [Environment]::GetFolderPath('Startup')
$scPath = Join-Path $startupFolder "TeamFlow-AutoLive.lnk"

$s = $ws.CreateShortcut($scPath)
$s.TargetPath = $target
$s.WorkingDirectory = $PSScriptRoot
$s.WindowStyle = 7 # Minimized
$s.Description = "TeamFlow AI Auto Recovery Live Server"
$s.Save()

Write-Host "===================================================================" -ForegroundColor Cyan
Write-Host " [성공] Windows 시작 프로그램에 자동 실행이 정상 등록되었습니다!" -ForegroundColor Green
Write-Host " 바로가기 위치: $scPath" -ForegroundColor DarkGray
Write-Host " 이제 컴퓨터를 껐다 켜도 서버와 Cloudflare 터널이 자동으로 켜지고," -ForegroundColor Yellow
Write-Host " 서버가 꺼지더라도 워치독이 스스로 감지하여 무한 복구합니다." -ForegroundColor Yellow
Write-Host "===================================================================" -ForegroundColor Cyan