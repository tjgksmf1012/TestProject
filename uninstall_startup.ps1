[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$startupFolder = [Environment]::GetFolderPath('Startup')
$scPath = Join-Path $startupFolder "TeamFlow-AutoLive.lnk"

if (Test-Path $scPath) {
    Remove-Item $scPath -Force
    Write-Host "[성공] 시작 프로그램에서 TeamFlow 자동 실행이 해제되었습니다." -ForegroundColor Green
} else {
    Write-Host "[안내] 등록된 시작 프로그램 바로가기가 없습니다." -ForegroundColor Yellow
}