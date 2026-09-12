[CmdletBinding()]
param(
    [string]$Workspace,
    [string]$NodePath,
    [ValidateRange(0, 65535)]
    [int]$Port = 8787,
    [switch]$Foreground
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $node = (Get-Command node -ErrorAction Stop).Source
}
else {
    $node = [IO.Path]::GetFullPath($NodePath)
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
        throw "No existe el ejecutable de Node indicado: $node"
    }
}
$entryPoint = Join-Path $projectRoot "dist\app\server.js"
if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw "No existe $entryPoint. Ejecuta scripts\install-windows.ps1 primero."
}
$applicationData = [Environment]::GetFolderPath("ApplicationData")
$appDataDirectory = Join-Path $applicationData "ManuMCP"
$logDirectory = Join-Path $appDataDirectory "logs"
New-Item -ItemType Directory -Path $appDataDirectory, $logDirectory -Force | Out-Null
$tokenPath = Join-Path $appDataDirectory "local-token.txt"
if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    $token = (& $node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))").Trim()
    if ($LASTEXITCODE -ne 0 -or $token.Length -lt 32) {
        throw "No se pudo generar el token local de ManuMCP."
    }
    [IO.File]::WriteAllText($tokenPath, $token, [Text.UTF8Encoding]::new($false))
}

if ([string]::IsNullOrWhiteSpace($Workspace)) {
    $Workspace = [Environment]::GetFolderPath("Desktop")
    if ([string]::IsNullOrWhiteSpace($Workspace)) {
        $Workspace = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Desktop"
    }
}
$resolvedWorkspace = [IO.Path]::GetFullPath($Workspace)
New-Item -ItemType Directory -Path $resolvedWorkspace -Force | Out-Null

$env:MANUMCP_WORKSPACE = $resolvedWorkspace
$env:MANUMCP_LOCAL_TOKEN_FILE = $tokenPath
$env:MANUMCP_PORT = [string]$Port
if ([string]::IsNullOrWhiteSpace($env:MANUMCP_PROFILE)) {
    $env:MANUMCP_PROFILE = "edit_safe"
}

$logPath = Join-Path $logDirectory "agent.log"
Push-Location $projectRoot
try {
    if ($Foreground) {
        & $node $entryPoint
    }
    else {
        & $node $entryPoint *>> $logPath
    }
    if ($LASTEXITCODE -ne 0) {
        throw "ManuMCP terminó con código $LASTEXITCODE. Revisa $logPath."
    }
}
finally {
    Pop-Location
}
