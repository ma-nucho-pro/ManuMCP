[CmdletBinding()]
param(
    [string]$Workspace,
    [string]$Downloads,
    [string]$PcRoot
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$node = (Get-Command node -ErrorAction Stop).Source
$npm = (Get-Command npm -ErrorAction Stop).Source
$systemPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (Test-Path -LiteralPath $systemPowerShell -PathType Leaf) {
    $shellPath = $systemPowerShell
}
else {
    $shell = (Get-Command pwsh -ErrorAction SilentlyContinue)
    if ($null -eq $shell) {
        $shell = Get-Command powershell -ErrorAction Stop
    }
    $shellPath = $shell.Source
}
$entryPoint = Join-Path $projectRoot "dist\app\server.js"

Push-Location $projectRoot
try {
    & $npm ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "npm ci terminó con código $LASTEXITCODE." }
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw "La compilación de ManuMCP terminó con código $LASTEXITCODE." }
}
finally {
    Pop-Location
}

$applicationData = [Environment]::GetFolderPath("ApplicationData")
$appDataDirectory = Join-Path $applicationData "ManuMCP"
New-Item -ItemType Directory -Path $appDataDirectory -Force | Out-Null
$stdioWrapperSource = Join-Path $projectRoot "scripts\stdio-entrypoint.ps1"
$stdioWrapperPath = Join-Path $appDataDirectory "stdio-entrypoint.ps1"
$projectRootPath = Join-Path $appDataDirectory "project-root.txt"
Copy-Item -LiteralPath $stdioWrapperSource -Destination $stdioWrapperPath -Force
[IO.File]::WriteAllText($projectRootPath, $projectRoot, [Text.UTF8Encoding]::new($false))
$tokenPath = Join-Path $appDataDirectory "local-token.txt"
if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    $token = (& $node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))").Trim()
    if ($LASTEXITCODE -ne 0 -or $token.Length -lt 32) { throw "No se pudo generar el token local de ManuMCP." }
    [IO.File]::WriteAllText($tokenPath, $token, [Text.UTF8Encoding]::new($false))
}
if ([string]::IsNullOrWhiteSpace($Workspace)) {
    $Workspace = [Environment]::GetFolderPath("Desktop")
    if ([string]::IsNullOrWhiteSpace($Workspace)) {
        $Workspace = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Desktop"
    }
}
if ([string]::IsNullOrWhiteSpace($Downloads)) {
    $Downloads = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Downloads"
}
if ([string]::IsNullOrWhiteSpace($PcRoot)) {
    $PcRoot = [Environment]::GetFolderPath("UserProfile")
}
$resolvedWorkspace = [IO.Path]::GetFullPath($Workspace)
$resolvedDownloads = [IO.Path]::GetFullPath($Downloads)
$resolvedPcRoot = [IO.Path]::GetFullPath($PcRoot)
New-Item -ItemType Directory -Path $resolvedWorkspace -Force | Out-Null
New-Item -ItemType Directory -Path $resolvedDownloads, $resolvedPcRoot -Force | Out-Null
$rootsConfiguration = [ordered]@{
    workspace = $resolvedWorkspace
    downloads = $resolvedDownloads
    pcRoot = $resolvedPcRoot
} | ConvertTo-Json -Compress
$rootsConfigPath = Join-Path $appDataDirectory "roots.json"
[IO.File]::WriteAllText($rootsConfigPath, $rootsConfiguration, [Text.UTF8Encoding]::new($false))

$taskName = "ManuMCP Agent"
$startScript = Join-Path $projectRoot "scripts\start-windows.ps1"
$quotedScript = '"' + $startScript + '"'
$quotedWorkspace = '"' + $resolvedWorkspace + '"'
$quotedDownloads = '"' + $resolvedDownloads + '"'
$quotedPcRoot = '"' + $resolvedPcRoot + '"'
$quotedNode = '"' + $node + '"'
$action = New-ScheduledTaskAction -Execute $shellPath -Argument "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $quotedScript -Workspace $quotedWorkspace -Downloads $quotedDownloads -PcRoot $quotedPcRoot -NodePath $quotedNode"
$userId = "$env:USERDOMAIN\$env:USERNAME"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask -and $existingTask.State -eq "Running") {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $state = (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue).State
        if ($state -ne "Running") { break }
        Start-Sleep -Milliseconds 250
    }
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "ManuMCP local MCP agent; Desktop, Downloads and the configured user profile roots are exposed." -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
$healthUri = "http://127.0.0.1:8787/healthz"
$ready = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri $healthUri -Method Get -TimeoutSec 2
        if ($health.ok -eq $true) { $ready = $true; break }
    }
    catch {
    }
    Start-Sleep -Milliseconds 500
}

if (-not $ready) {
    $logPath = Join-Path $appDataDirectory "logs\agent.log"
    throw "La tarea se instaló, pero el agente aún no responde en $healthUri. Revisa $logPath."
}

Write-Output "ManuMCP instalado como tarea '$taskName'."
Write-Output "Escritorio autorizado: $resolvedWorkspace"
Write-Output "Descargas autorizadas: $resolvedDownloads"
Write-Output "Perfil de usuario autorizado: $resolvedPcRoot"
Write-Output "Endpoint local: http://127.0.0.1:8787/mcp"
Write-Output "Modo seguro recomendado para ChatGPT: túnel privado por stdio."
Write-Output "Logs: $(Join-Path $appDataDirectory 'logs\agent.log')"
