[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^tunnel_[0-9a-f]{32}$')]
    [string]$TunnelId,
    [string]$Profile = "manumcp-final",
    [string]$ClientPath = "C:\Users\usuario\AppData\Local\ManuMCP\tunnel-client\v0.0.14\tunnel-client.exe"
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY) -or $env:CONTROL_PLANE_API_KEY -notmatch '^sk-[A-Za-z0-9_-]{20,}$') {
    throw "Define CONTROL_PLANE_API_KEY solo en esta sesión antes de instalar el arranque del túnel. No lo guardes en el repositorio."
}
if (-not (Test-Path -LiteralPath $ClientPath -PathType Leaf)) {
    throw "No se encontró tunnel-client: $ClientPath"
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$applicationData = [Environment]::GetFolderPath("ApplicationData")
$appDataDirectory = Join-Path $applicationData "ManuMCP"
$profileDirectory = Join-Path $applicationData "tunnel-client"
New-Item -ItemType Directory -Path $appDataDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null

$keyPath = Join-Path $appDataDirectory "control-plane-key.dpapi"
$secureKey = ConvertTo-SecureString -String $env:CONTROL_PLANE_API_KEY -AsPlainText -Force
$encryptedKey = ConvertFrom-SecureString -SecureString $secureKey
[IO.File]::WriteAllText($keyPath, $encryptedKey, [Text.UTF8Encoding]::new($false))
$secureKey.Dispose()

$userId = "$env:USERDOMAIN\$env:USERNAME"
& icacls.exe $keyPath /inheritance:r | Out-Null
if ($LASTEXITCODE -ne 0) { throw "No se pudo desactivar la herencia de permisos de la credencial local (icacls $LASTEXITCODE)." }
$grant = "$userId`:(F)"
& icacls.exe $keyPath /grant:r $grant | Out-Null
if ($LASTEXITCODE -ne 0) { throw "No se pudo limitar la credencial local al usuario actual (icacls $LASTEXITCODE)." }

$startSource = Join-Path $projectRoot "scripts\start-tunnel-windows.ps1"
$startPath = Join-Path $appDataDirectory "start-tunnel-windows.ps1"
Copy-Item -LiteralPath $startSource -Destination $startPath -Force

$systemPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $systemPowerShell -PathType Leaf)) {
    $systemPowerShell = (Get-Command powershell -ErrorAction Stop).Source
}
$quotedStart = '"' + $startPath + '"'
$quotedClient = '"' + [IO.Path]::GetFullPath($ClientPath) + '"'
$quotedKey = '"' + $keyPath + '"'
$arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $quotedStart -TunnelId $TunnelId -Profile $Profile -ClientPath $quotedClient -KeyPath $quotedKey"
$taskName = "ManuMCP Tunnel"
$action = New-ScheduledTaskAction -Execute $systemPowerShell -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "ManuMCP secure outbound tunnel; credential protected with Windows DPAPI." -Force | Out-Null

Write-Output "Arranque automático del túnel instalado como tarea '$taskName'."
Write-Output "Túnel: $TunnelId"
Write-Output "Perfil: $Profile"
Write-Output "Credencial: almacenada cifrada con Windows DPAPI para el usuario actual."
Write-Output "La tarea comenzará en el próximo inicio de sesión; el runtime actual puede seguir ejecutándose."
