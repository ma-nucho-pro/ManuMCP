[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$applicationData = [Environment]::GetFolderPath("ApplicationData")
$appDataDirectory = Join-Path $applicationData "ManuMCP"
$projectRootPath = Join-Path $appDataDirectory "project-root.txt"

if (-not (Test-Path -LiteralPath $projectRootPath -PathType Leaf)) {
    throw "No existe la configuración local de ManuMCP: $projectRootPath"
}

$projectRoot = (Get-Content -LiteralPath $projectRootPath -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($projectRoot)) {
    throw "La configuración local de ManuMCP está vacía: $projectRootPath"
}

$entryPoint = Join-Path $projectRoot "dist\app\server.js"
if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw "No existe el servidor compilado de ManuMCP: $entryPoint"
}

$node = (Get-Command node -ErrorAction Stop).Source
$desktopPath = [Environment]::GetFolderPath("Desktop")
if ([string]::IsNullOrWhiteSpace($env:MANUMCP_WORKSPACE)) {
    if ([string]::IsNullOrWhiteSpace($desktopPath)) {
        $desktopPath = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Desktop"
    }
    $env:MANUMCP_WORKSPACE = $desktopPath
}
& $node $entryPoint --stdio
exit $LASTEXITCODE
