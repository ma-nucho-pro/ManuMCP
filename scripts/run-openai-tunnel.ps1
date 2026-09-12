[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TunnelId,
    [string]$Profile = "manumcp-local",
    [string]$Workspace,
    [string]$ClientPath = "tunnel-client"
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
    throw "Define CONTROL_PLANE_API_KEY solo en esta sesión antes de iniciar el túnel. No lo guardes en el repositorio."
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
if ([string]::IsNullOrWhiteSpace($Workspace)) {
    $Workspace = Join-Path ([Environment]::GetFolderPath("UserProfile")) "ManuMCP-Workspace"
}
$env:MANUMCP_WORKSPACE = [IO.Path]::GetFullPath($Workspace)
$mcpCommand = "$node `"$entryPoint`" --stdio"

& $clientExecutable init --sample sample_mcp_stdio_local --profile $Profile --tunnel-id $TunnelId --mcp-command $mcpCommand
if ($LASTEXITCODE -ne 0) { throw "tunnel-client init terminó con código $LASTEXITCODE." }
& $clientExecutable doctor --profile $Profile --explain
if ($LASTEXITCODE -ne 0) { throw "tunnel-client doctor terminó con código $LASTEXITCODE." }
Write-Output "ManuMCP quedó preparado para el túnel '$TunnelId'."
Write-Output "Mantén este proceso activo para que ChatGPT pueda descubrir y llamar las herramientas."
& $clientExecutable run --profile $Profile
if ($LASTEXITCODE -ne 0) { throw "tunnel-client run terminó con código $LASTEXITCODE." }
