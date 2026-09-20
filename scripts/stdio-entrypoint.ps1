#requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$applicationData = [Environment]::GetFolderPath("ApplicationData")
$appDataDirectory = Join-Path $applicationData "ManuMCP"
$helperPath = Join-Path $appDataDirectory "windows-lifecycle.ps1"
if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
    $helperPath = Join-Path $PSScriptRoot "windows-lifecycle.ps1"
}
if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
    throw "No existe el runtime de verificación de ManuMCP: $helperPath"
}
. $helperPath
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
$manifestPath = Join-Path $appDataDirectory "installation-manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "No existe el manifest de instalación de ManuMCP: $manifestPath"
}
try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { throw "El manifest de ManuMCP no contiene JSON válido: $manifestPath" }
if ($manifest.schema -ne 1 -or (Get-ManuMcpNormalizedPath ([string]$manifest.projectRoot)) -ne (Get-ManuMcpNormalizedPath $projectRoot) -or (Get-ManuMcpNormalizedPath ([string]$manifest.entryPoint)) -ne (Get-ManuMcpNormalizedPath $entryPoint)) {
    throw "La raíz o el entrypoint de stdio no coinciden con el manifest de ManuMCP."
}
if ((Get-ManuMcpFileSha256 $entryPoint) -ne ([string]$manifest.entryPointSha256).ToUpperInvariant()) {
    throw "El servidor compilado de stdio no coincide con el hash instalado."
}
foreach ($critical in @($manifest.criticalFiles)) {
    $criticalPath = Join-Path $projectRoot ([string]$critical.path)
    if ((Get-ManuMcpFileSha256 $criticalPath) -ne ([string]$critical.sha256).ToUpperInvariant()) {
        throw "El archivo crítico de stdio no coincide con el manifest: $criticalPath"
    }
}
if ($manifest.userSid -and ([string]$manifest.userSid -ne (Get-ManuMcpCurrentSid))) {
    throw "El manifest de ManuMCP fue instalado para otra identidad de Windows."
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
if (Test-Path -LiteralPath (Join-Path $appDataDirectory "profile.txt") -PathType Leaf) {
    $persistedProfile = (Get-Content -LiteralPath (Join-Path $appDataDirectory "profile.txt") -Raw).Trim()
    if (-not [string]::IsNullOrWhiteSpace($persistedProfile)) { $env:MANUMCP_PROFILE = $persistedProfile }
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
