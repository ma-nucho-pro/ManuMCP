[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8787
)

$ErrorActionPreference = "Stop"
$ngrok = Get-Command ngrok -ErrorAction SilentlyContinue
if ($null -eq $ngrok) {
    throw "ngrok no está instalado o no está en PATH. Instálalo desde ngrok.com y vuelve a ejecutar este script."
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$applicationData = [Environment]::GetFolderPath("ApplicationData")
$appDataDirectory = Join-Path $applicationData "ManuMCP"
$tokenPath = Join-Path $appDataDirectory "local-token.txt"
$logDirectory = Join-Path $appDataDirectory "logs"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    & (Join-Path $projectRoot "scripts\install-windows.ps1") | Out-Host
}
$token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
if ($token.Length -lt 24) { throw "El token local de ManuMCP no es válido." }

$healthUri = "http://127.0.0.1:$Port/healthz"
$agent = $null
$healthy = $false
try {
    $null = Invoke-RestMethod -Uri $healthUri -Method Get -TimeoutSec 2
    $healthy = $true
}
catch {
    $shell = (Get-Command pwsh -ErrorAction SilentlyContinue)
    if ($null -eq $shell) { $shell = Get-Command powershell -ErrorAction Stop }
    $startScript = Join-Path $projectRoot "scripts\start-windows.ps1"
    $agent = Start-Process -FilePath $shell.Source -ArgumentList @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $startScript, "-Port", $Port) -WindowStyle Hidden -WorkingDirectory $projectRoot -PassThru
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try {
            $null = Invoke-RestMethod -Uri $healthUri -Method Get -TimeoutSec 2
            $healthy = $true
            break
        }
        catch { Start-Sleep -Milliseconds 500 }
    }
}
if (-not $healthy) { throw "El agente local no responde en $healthUri." }

$ngrokLog = Join-Path $logDirectory "ngrok.log"
$ngrokErrorLog = Join-Path $logDirectory "ngrok-error.log"
$arguments = @(
    "http",
    "http://127.0.0.1:$Port",
    "--host-header=rewrite"
)
$tunnel = Start-Process -FilePath $ngrok.Source -ArgumentList $arguments -WindowStyle Hidden -WorkingDirectory $projectRoot -RedirectStandardOutput $ngrokLog -RedirectStandardError $ngrokErrorLog -PassThru
try {
    $publicUrl = $null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $tunnels = (Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -Method Get -TimeoutSec 2).tunnels
            $publicUrl = ($tunnels | Where-Object { $_.public_url -like "https://*" } | Select-Object -First 1).public_url
            if (-not [string]::IsNullOrWhiteSpace($publicUrl)) { break }
        }
        catch { Start-Sleep -Milliseconds 500 }
    }
    if ([string]::IsNullOrWhiteSpace($publicUrl)) {
        throw "ngrok inició, pero no se pudo leer su URL en http://127.0.0.1:4040/api/tunnels."
    }
    Write-Output "URL pública temporal: $publicUrl/mcp"
    Write-Output "Autenticación: Bearer"
    Write-Output "Token local para configurar en ChatGPT: $token"
    Write-Output "No compartas ese token ni lo pongas en la URL."
    Write-Output "Configúrala solo como prueba; el túnel privado de OpenAI es la opción recomendada."
    Write-Output "Pulsa Ctrl+C para cerrar ngrok. El agente local seguirá instalado."
    while (-not $tunnel.HasExited) { Start-Sleep -Seconds 2 }
}
finally {
    if ($null -ne $tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
}
