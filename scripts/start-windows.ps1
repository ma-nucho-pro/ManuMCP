#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Workspace,
    [string]$Downloads,
    [string]$PcRoot,
    [string]$NodePath,
    [string]$ProjectRoot,
    [string]$DataRoot,
    [ValidateRange(0, 65535)]
    [int]$Port = 8787,
    [string]$MutexNamespace = "Global\ManuMCP",
    [switch]$RunOnce,
    [switch]$Foreground
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
else {
    $ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
}
if ([string]::IsNullOrWhiteSpace($DataRoot)) {
    $DataRoot = Join-Path ([Environment]::GetFolderPath("ApplicationData")) "ManuMCP"
}
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
$helperPath = Join-Path $PSScriptRoot "windows-lifecycle.ps1"
if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
    throw "No existe el runtime de ciclo de vida de ManuMCP: $helperPath"
}
. $helperPath

$entryPoint = Join-Path $ProjectRoot "dist\app\server.js"
$manifestPath = Join-Path $DataRoot "installation-manifest.json"
$projectRootPath = Join-Path $DataRoot "project-root.txt"
$profilePath = Join-Path $DataRoot "profile.txt"
$logDirectory = Join-Path $DataRoot "logs"
$logPath = Join-Path $logDirectory "agent.log"
$stdoutPath = Join-Path $logDirectory "agent.stdout.log"
$stderrPath = Join-Path $logDirectory "agent.stderr.log"
$pidPath = Join-Path $DataRoot "agent.pid.json"
New-Item -ItemType Directory -Path $DataRoot, $logDirectory -Force | Out-Null
trap {
    try { Write-ManuMcpLifecycleLog -Path $logPath -Message ("Error fatal del supervisor: {0}" -f $_.Exception.Message) -Level ERROR } catch { }
    exit 1
}

if (-not (Test-Path -LiteralPath $projectRootPath -PathType Leaf)) {
    throw "No existe la autoridad de instalación de ManuMCP: $projectRootPath"
}
$authorizedRoot = (Get-Content -LiteralPath $projectRootPath -Raw).Trim()
if ((Get-ManuMcpNormalizedPath $authorizedRoot) -ne (Get-ManuMcpNormalizedPath $ProjectRoot)) {
    throw "La tarea de ManuMCP apunta a una raíz distinta de project-root.txt. Reinstala desde la copia canónica."
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "No existe el manifest de instalación de ManuMCP: $manifestPath"
}
try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { throw "El manifest de instalación de ManuMCP no contiene JSON válido: $manifestPath" }
if ($manifest.schema -ne 1 -or (Get-ManuMcpNormalizedPath ([string]$manifest.projectRoot)) -ne (Get-ManuMcpNormalizedPath $ProjectRoot) -or (Get-ManuMcpNormalizedPath ([string]$manifest.entryPoint)) -ne (Get-ManuMcpNormalizedPath $entryPoint)) {
    throw "El manifest de ManuMCP no coincide con la raíz o el entrypoint de la tarea."
}
if ((Get-ManuMcpFileSha256 $entryPoint) -ne ([string]$manifest.entryPointSha256).ToUpperInvariant()) {
    throw "El entrypoint de ManuMCP no coincide con su hash de instalación."
}
if ($manifest.startWrapperSha256 -and (Get-ManuMcpFileSha256 $MyInvocation.MyCommand.Path) -ne ([string]$manifest.startWrapperSha256).ToUpperInvariant()) {
    throw "El supervisor de ManuMCP no coincide con el wrapper instalado."
}
foreach ($critical in @($manifest.criticalFiles)) {
    $criticalPath = Join-Path $ProjectRoot ([string]$critical.path)
    if ((Get-ManuMcpFileSha256 $criticalPath) -ne ([string]$critical.sha256).ToUpperInvariant()) {
        throw "El archivo crítico de ManuMCP no coincide con el manifest: $criticalPath"
    }
}

$node = if ([string]::IsNullOrWhiteSpace($NodePath)) { (Get-Command node -ErrorAction Stop).Source } else { [IO.Path]::GetFullPath($NodePath) }
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "No existe el ejecutable de Node indicado: $node" }
if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) { throw "No existe $entryPoint." }

if (Test-Path -LiteralPath $profilePath -PathType Leaf) {
    $persistedProfile = (Get-Content -LiteralPath $profilePath -Raw).Trim()
    if (-not [string]::IsNullOrWhiteSpace($persistedProfile)) { $env:MANUMCP_PROFILE = $persistedProfile }
}

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (Test-Path -LiteralPath $Path -PathType Leaf) { throw "La raíz autorizada no es un directorio: $Path" }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
}
if ([string]::IsNullOrWhiteSpace($Workspace)) { $Workspace = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Desktop" }
if ([string]::IsNullOrWhiteSpace($Downloads)) { $Downloads = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Downloads" }
if ([string]::IsNullOrWhiteSpace($PcRoot)) { $PcRoot = [IO.Path]::GetPathRoot([Environment]::GetFolderPath("UserProfile")) }
$resolvedWorkspace = [IO.Path]::GetFullPath($Workspace)
$resolvedDownloads = [IO.Path]::GetFullPath($Downloads)
$resolvedPcRoot = [IO.Path]::GetFullPath($PcRoot)
Ensure-Directory $resolvedWorkspace
Ensure-Directory $resolvedDownloads
Ensure-Directory $resolvedPcRoot
$env:MANUMCP_WORKSPACE = $resolvedWorkspace
$env:MANUMCP_DOWNLOADS = $resolvedDownloads
$env:MANUMCP_PC_ROOT = $resolvedPcRoot
$env:MANUMCP_LOCAL_TOKEN_FILE = Join-Path $DataRoot "local-token.txt"
$env:MANUMCP_PORT = [string]$Port

if (Test-ManuMcpActiveStopRequest -DataRoot $DataRoot -Component Agent) {
    Write-ManuMcpLifecycleLog -Path $logPath -Message "Se solicitó una detención durante una actualización; no se inició el agente." -Level WARN
    exit 32
}

$instanceMutex = New-ManuMcpMutex -Name ("{0}.Agent" -f $MutexNamespace)
if (-not (Enter-ManuMcpMutex -Mutex $instanceMutex)) { exit 0 }
$finalExitCode = 0
$backoffSeconds = 2
$maxBackoffSeconds = 60
$stableSeconds = 60
try {
    while ($true) {
        if (Test-ManuMcpActiveStopRequest -DataRoot $DataRoot -Component Agent) {
            Write-ManuMcpLifecycleLog -Path $logPath -Message "La actualización solicitó detener el supervisor." -Level WARN
            break
        }
        $launchMutex = New-ManuMcpMutex -Name ("{0}.Agent.Launch" -f $MutexNamespace)
        if (-not (Enter-ManuMcpMutex -Mutex $launchMutex)) {
            Write-ManuMcpLifecycleLog -Path $logPath -Message "Otra instalación está actualizando el agente; el supervisor termina sin lanzar un segundo proceso." -Level WARN
            Exit-ManuMcpMutex -Mutex $launchMutex
            break
        }
        $child = $null
        try {
            if (Test-ManuMcpActiveStopRequest -DataRoot $DataRoot -Component Agent) { break }
            $quotedEntryPoint = '"' + $entryPoint.Replace('"', '\"') + '"'
            $windowStyle = if ($Foreground) { "Normal" } else { "Hidden" }
            Write-ManuMcpLifecycleLog -Path $logPath -Message ("Iniciando Node para {0} (puerto {1})." -f $entryPoint, $Port)
            $child = Start-Process -FilePath $node -ArgumentList $quotedEntryPoint -WorkingDirectory $ProjectRoot -WindowStyle $windowStyle -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
            $pidInfo = [ordered]@{
                schema = 1
                component = "Agent"
                pid = $child.Id
                startTime = $child.StartTime.ToUniversalTime().ToString('o')
                executable = $node
                entryPoint = $entryPoint
                dataRoot = (Get-ManuMcpNormalizedPath $DataRoot)
            } | ConvertTo-Json -Compress
            Write-ManuMcpAtomicText -Path $pidPath -Text $pidInfo
        }
        catch {
            Write-ManuMcpLifecycleLog -Path $logPath -Message ("No se pudo iniciar el agente: {0}" -f $_.Exception.Message) -Level ERROR
            if ($RunOnce) { $finalExitCode = 1; break }
        }
        finally {
            Exit-ManuMcpMutex -Mutex $launchMutex
        }
        if ($null -eq $child) {
            if ($RunOnce) { break }
            Start-Sleep -Seconds $backoffSeconds
            $backoffSeconds = [Math]::Min($maxBackoffSeconds, $backoffSeconds * 2)
            continue
        }
        $startedAt = Get-Date
        $child.WaitForExit()
        $runtimeSeconds = ((Get-Date) - $startedAt).TotalSeconds
        $exitCode = if ($null -eq $child.ExitCode) { -1 } else { [int]$child.ExitCode }
        if (Test-Path -LiteralPath $pidPath -PathType Leaf) { Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue }
        $child.Dispose()
        $level = if ($exitCode -eq 0) { "INFO" } else { "ERROR" }
        Write-ManuMcpLifecycleLog -Path $logPath -Message ("El proceso del agente terminó con código {0} después de {1:N0}s." -f $exitCode, $runtimeSeconds) -Level $level
        if ($RunOnce) { $finalExitCode = $exitCode; break }
        if (Test-ManuMcpActiveStopRequest -DataRoot $DataRoot -Component Agent) { break }
        if ($runtimeSeconds -ge $stableSeconds) { $backoffSeconds = 2 }
        else { $backoffSeconds = [Math]::Min($maxBackoffSeconds, $backoffSeconds * 2) }
        Start-Sleep -Seconds $backoffSeconds
    }
}
finally {
    if (Test-Path -LiteralPath $pidPath -PathType Leaf) { Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue }
    Exit-ManuMcpMutex -Mutex $instanceMutex
}
exit $finalExitCode
