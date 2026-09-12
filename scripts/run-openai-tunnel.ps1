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
    $Workspace = [Environment]::GetFolderPath("Desktop")
    if ([string]::IsNullOrWhiteSpace($Workspace)) {
        $Workspace = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Desktop"
    }
}
$env:MANUMCP_WORKSPACE = [IO.Path]::GetFullPath($Workspace)
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
    $mcpCommand = "$commandShellPath -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $commandWrapperPath"
}
else {
    $mcpCommand = "node $entryPoint --stdio"
}

& $clientExecutable init --sample sample_mcp_stdio_local --profile $Profile --tunnel-id $TunnelId --mcp-command $mcpCommand
if ($LASTEXITCODE -ne 0) { throw "tunnel-client init terminó con código $LASTEXITCODE." }
& $clientExecutable doctor --profile $Profile --explain
if ($LASTEXITCODE -ne 0) { throw "tunnel-client doctor terminó con código $LASTEXITCODE." }
Write-Output "ManuMCP quedó preparado para el túnel '$TunnelId'."
Write-Output "Mantén este proceso activo para que ChatGPT pueda descubrir y llamar las herramientas."
& $clientExecutable run --profile $Profile
if ($LASTEXITCODE -ne 0) { throw "tunnel-client run terminó con código $LASTEXITCODE." }
