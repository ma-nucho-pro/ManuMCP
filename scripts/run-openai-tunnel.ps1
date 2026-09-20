#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TunnelId,
    [string]$Profile = "manumcp-local",
    [string]$Workspace,
    [string]$ClientPath = "tunnel-client",
    [string]$ProfileDir = (Join-Path ([Environment]::GetFolderPath("ApplicationData")) "tunnel-client"),
    [string]$OrganizationId = $env:CONTROL_PLANE_ORGANIZATION_ID,
    [switch]$ConfigureOnly
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
    throw "Define CONTROL_PLANE_API_KEY solo en esta sesión antes de iniciar el túnel. No lo guardes en el repositorio."
}
if (-not [string]::IsNullOrWhiteSpace($OrganizationId) -and $OrganizationId -notmatch '^org-[A-Za-z0-9_-]+$') {
    throw "OrganizationId debe tener formato org-... y pertenecer a la misma organización que el túnel y la runtime key."
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$node = (Get-Command node -ErrorAction Stop).Source
$client = Get-Command $ClientPath -ErrorAction SilentlyContinue
if ($null -eq $client -and (Test-Path -LiteralPath $ClientPath -PathType Leaf)) {
    $client = Get-Item -LiteralPath $ClientPath
}
if ($null -eq $client) {
    throw "No se encontró tunnel-client. Descárgalo desde Platform tunnel settings o desde su release oficial y pasa -ClientPath si no está en PATH."
}
$clientExecutable = if ([string]::IsNullOrWhiteSpace($client.Source)) { $client.FullName } else { $client.Source }

$entryPoint = Join-Path $projectRoot "dist\app\server.js"
if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw "No existe $entryPoint. Ejecuta scripts\install-windows.ps1 primero."
}
$userProfile = [Environment]::GetFolderPath("UserProfile")
$rootsConfigPath = Join-Path ([Environment]::GetFolderPath("ApplicationData")) "ManuMCP\roots.json"
$rootsConfig = $null
if (Test-Path -LiteralPath $rootsConfigPath -PathType Leaf) {
    try {
        $rootsConfig = Get-Content -LiteralPath $rootsConfigPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "La configuración de raíces de ManuMCP no contiene JSON válido: $rootsConfigPath"
    }
}
if ([string]::IsNullOrWhiteSpace($Workspace)) {
    $Workspace = [string]$rootsConfig.workspace
    if ([string]::IsNullOrWhiteSpace($Workspace)) {
        $Workspace = [Environment]::GetFolderPath("Desktop")
        if ([string]::IsNullOrWhiteSpace($Workspace)) {
            $Workspace = Join-Path $userProfile "Desktop"
        }
    }
}
$env:MANUMCP_WORKSPACE = [IO.Path]::GetFullPath($Workspace)
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
$applicationData = [Environment]::GetFolderPath("ApplicationData")
$stdioWrapperPath = Join-Path $applicationData "ManuMCP\stdio-entrypoint.ps1"
if (Test-Path -LiteralPath $stdioWrapperPath -PathType Leaf) {
    $systemPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path -LiteralPath $systemPowerShell -PathType Leaf)) {
        $systemPowerShell = (Get-Command powershell -ErrorAction Stop).Source
    }
    # tunnel-client tokenizes this command as a POSIX-like string. Forward slashes
    # keep Windows paths intact when the command is launched by its Go runtime.
    $commandShellPath = $systemPowerShell -replace '\\', '/'
    $commandWrapperPath = $stdioWrapperPath -replace '\\', '/'
    $mcpCommand = '"' + $commandShellPath + '" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $commandWrapperPath + '"'
}
else {
    $mcpCommand = '"' + ($node -replace '\\', '/') + '" "' + ($entryPoint -replace '\\', '/') + '" --stdio'
}

$existingProfile = Join-Path $ProfileDir "$Profile.yaml"
if (Test-Path -LiteralPath $existingProfile -PathType Leaf) {
    if ((Get-Content -LiteralPath $existingProfile -Raw) -notmatch [regex]::Escape($TunnelId)) {
        throw "El perfil existente pertenece a otro túnel. Elige un nombre de perfil distinto."
    }
}
else {
& $clientExecutable init --profile-dir $ProfileDir --sample sample_mcp_stdio_local --profile $Profile --tunnel-id $TunnelId --mcp-command $mcpCommand
if ($LASTEXITCODE -ne 0) { throw "tunnel-client init terminó con código $LASTEXITCODE." }
}

if (-not [string]::IsNullOrWhiteSpace($OrganizationId)) {
    $profileText = Get-Content -LiteralPath $existingProfile -Raw
    $organizationLine = '  organization_id: "' + $OrganizationId + '"'
    if ($profileText -match '(?m)^[ \t]*organization_id:[ \t]*') {
        $updatedProfileText = [regex]::Replace($profileText, '(?m)^[ \t]*organization_id:[ \t]*[^\r\n#]*(?:#.*)?$', $organizationLine)
    }
    else {
        $updatedProfileText = [regex]::Replace($profileText, '(?m)^(  base_url:\s*[^\r\n]*\r?\n)', ('$1' + $organizationLine + [Environment]::NewLine), 1)
    }
    if ($updatedProfileText -ne $profileText) {
        [IO.File]::WriteAllText($existingProfile, $updatedProfileText, (New-Object System.Text.UTF8Encoding($false)))
    }
}
& $clientExecutable doctor --profile-dir $ProfileDir --profile $Profile --explain
if ($LASTEXITCODE -ne 0) { throw "tunnel-client doctor terminó con código $LASTEXITCODE." }
Write-Output "ManuMCP quedó preparado para el túnel '$TunnelId'."
Write-Output "Mantén este proceso activo para que ChatGPT pueda descubrir y llamar las herramientas."
if ($ConfigureOnly) { return }
& $clientExecutable run --profile-dir $ProfileDir --profile $Profile
if ($LASTEXITCODE -ne 0) { throw "tunnel-client run terminó con código $LASTEXITCODE." }
