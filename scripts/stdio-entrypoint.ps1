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

$nodePathFile = Join-Path $appDataDirectory "node-path.txt"
$node = $null
if (Test-Path -LiteralPath $nodePathFile -PathType Leaf) {
    $configuredNode = (Get-Content -LiteralPath $nodePathFile -Raw).Trim()
    if (-not [string]::IsNullOrWhiteSpace($configuredNode) -and (Test-Path -LiteralPath $configuredNode -PathType Leaf)) {
        $node = $configuredNode
    }
}
if ([string]::IsNullOrWhiteSpace($node)) {
    $node = (Get-Command node -ErrorAction Stop).Source
}
$userProfile = [Environment]::GetFolderPath("UserProfile")
$rootsConfigPath = Join-Path $appDataDirectory "roots.json"
$rootsConfig = $null
if (Test-Path -LiteralPath $rootsConfigPath -PathType Leaf) {
    try {
        $rootsConfig = Get-Content -LiteralPath $rootsConfigPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "La configuración de raíces de ManuMCP no contiene JSON válido: $rootsConfigPath"
    }
}
$desktopPath = [Environment]::GetFolderPath("Desktop")
if ([string]::IsNullOrWhiteSpace($env:MANUMCP_WORKSPACE)) {
    $configuredWorkspace = [string]$rootsConfig.workspace
    if (-not [string]::IsNullOrWhiteSpace($configuredWorkspace)) {
        $env:MANUMCP_WORKSPACE = $configuredWorkspace
    }
    elseif ([string]::IsNullOrWhiteSpace($desktopPath)) {
        $desktopPath = Join-Path $userProfile "Desktop"
        $env:MANUMCP_WORKSPACE = $desktopPath
    }
    else {
        $env:MANUMCP_WORKSPACE = $desktopPath
    }
}
if ([string]::IsNullOrWhiteSpace($env:MANUMCP_DOWNLOADS)) {
    $configuredDownloads = [string]$rootsConfig.downloads
    $env:MANUMCP_DOWNLOADS = if ([string]::IsNullOrWhiteSpace($configuredDownloads)) { Join-Path $userProfile "Downloads" } else { $configuredDownloads }
}
if ([string]::IsNullOrWhiteSpace($env:MANUMCP_PC_ROOT)) {
    $configuredPcRoot = [string]$rootsConfig.pcRoot
    if ([string]::IsNullOrWhiteSpace($configuredPcRoot)) {
        $configuredPcRoot = [IO.Path]::GetPathRoot([Environment]::GetFolderPath("Windows"))
        if ([string]::IsNullOrWhiteSpace($configuredPcRoot)) {
            $configuredPcRoot = [IO.Path]::GetPathRoot($userProfile)
        }
    }
    $env:MANUMCP_PC_ROOT = $configuredPcRoot
}
& $node $entryPoint --stdio
exit $LASTEXITCODE
