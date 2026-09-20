#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^tunnel_[0-9a-f]{32}$')]
    [string]$TunnelId,
    [string]$Profile = "manumcp-final",
    [Parameter(Mandatory = $true)]
    [string]$ClientPath,
    [Parameter(Mandatory = $true)]
    [string]$KeyPath,
    [string]$ProfileDir,
    [string]$DataRoot,
    [string]$ProjectRoot,
    [string]$HealthUrl,
    [string]$MutexNamespace = "Global\ManuMCP",
    [switch]$RunOnce
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($DataRoot)) { $DataRoot = Join-Path ([Environment]::GetFolderPath("ApplicationData")) "ManuMCP" }
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
if ([string]::IsNullOrWhiteSpace($ProfileDir)) { $ProfileDir = Join-Path ([Environment]::GetFolderPath("ApplicationData")) "tunnel-client" }
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$helperPath = Join-Path $PSScriptRoot "windows-lifecycle.ps1"
if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) { throw "No existe el runtime de ciclo de vida de ManuMCP: $helperPath" }
. $helperPath

$logDirectory = Join-Path $DataRoot "logs"
$logPath = Join-Path $logDirectory "tunnel.log"
$stdoutPath = Join-Path $logDirectory "tunnel.stdout.log"
$stderrPath = Join-Path $logDirectory "tunnel.stderr.log"
$pidPath = Join-Path $DataRoot "tunnel.pid.json"
$tunnelManifestPath = Join-Path $DataRoot "tunnel-install-manifest.json"
New-Item -ItemType Directory -Path $DataRoot, $logDirectory -Force | Out-Null
trap {
    try { Write-ManuMcpLifecycleLog -Path $logPath -Message ("Error fatal del supervisor del túnel: {0}" -f $_.Exception.Message) -Level ERROR } catch { }
    exit 1
}
if (-not (Test-Path -LiteralPath $ClientPath -PathType Leaf)) { throw "No se encontró tunnel-client: $ClientPath" }
if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) { throw "No se encontró la credencial local protegida: $KeyPath" }
if (-not (Test-Path -LiteralPath $tunnelManifestPath -PathType Leaf)) { throw "No existe el manifest del túnel: $tunnelManifestPath" }
try { $tunnelManifest = Get-Content -LiteralPath $tunnelManifestPath -Raw | ConvertFrom-Json } catch { throw "El manifest del túnel no contiene JSON válido: $tunnelManifestPath" }
if ($tunnelManifest.schema -ne 1 -or $tunnelManifest.tunnelId -ne $TunnelId -or $tunnelManifest.profile -ne $Profile) { throw "La tarea del túnel no coincide con su manifest." }
if ((Get-ManuMcpNormalizedPath ([string]$tunnelManifest.clientPath)) -ne (Get-ManuMcpNormalizedPath $ClientPath)) { throw "La tarea del túnel apunta a otro tunnel-client." }
if ($tunnelManifest.wrapperSha256 -and (Get-ManuMcpFileSha256 $MyInvocation.MyCommand.Path) -ne ([string]$tunnelManifest.wrapperSha256).ToUpperInvariant()) { throw "El supervisor del túnel no coincide con el wrapper instalado." }
$HealthUrl = Assert-ManuMcpHealthUrl -Url $HealthUrl

$profilePath = Join-Path $ProfileDir "$Profile.yaml"
if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) { throw "No se encontró el perfil del túnel: $profilePath" }
$profileText = Get-Content -LiteralPath $profilePath -Raw
if ($profileText -notmatch [regex]::Escape($TunnelId)) { throw "El perfil '$Profile' no corresponde al túnel indicado." }

# The stdio child inherits these values. Keep the default aligned with the
# installed agent so the tunnel exposes the configured roots, not a stale copy.
$userProfile = [Environment]::GetFolderPath("UserProfile")
$rootsConfigPath = Join-Path $DataRoot "roots.json"
$rootsConfig = $null
if (Test-Path -LiteralPath $rootsConfigPath -PathType Leaf) {
    try { $rootsConfig = Get-Content -LiteralPath $rootsConfigPath -Raw | ConvertFrom-Json } catch { throw "La configuración de raíces no contiene JSON válido: $rootsConfigPath" }
}
if ([string]::IsNullOrWhiteSpace($env:MANUMCP_WORKSPACE)) {
    $env:MANUMCP_WORKSPACE = [string]$rootsConfig.workspace
    if ([string]::IsNullOrWhiteSpace($env:MANUMCP_WORKSPACE)) { $env:MANUMCP_WORKSPACE = Join-Path $userProfile "Desktop" }
}
if ([string]::IsNullOrWhiteSpace($env:MANUMCP_DOWNLOADS)) {
    $env:MANUMCP_DOWNLOADS = [string]$rootsConfig.downloads
    if ([string]::IsNullOrWhiteSpace($env:MANUMCP_DOWNLOADS)) { $env:MANUMCP_DOWNLOADS = Join-Path $userProfile "Downloads" }
}
if ([string]::IsNullOrWhiteSpace($env:MANUMCP_PC_ROOT)) {
    $env:MANUMCP_PC_ROOT = [string]$rootsConfig.pcRoot
    if ([string]::IsNullOrWhiteSpace($env:MANUMCP_PC_ROOT)) { $env:MANUMCP_PC_ROOT = [IO.Path]::GetPathRoot($userProfile) }
}

$encryptedKey = (Get-Content -LiteralPath $KeyPath -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($encryptedKey)) { throw "La credencial local protegida está vacía." }
$secureKey = ConvertTo-SecureString -String $encryptedKey
$keyPointer = [IntPtr]::Zero
$instanceMutex = New-ManuMcpMutex -Name "$MutexNamespace.Tunnel"
if (-not (Enter-ManuMcpMutex -Mutex $instanceMutex)) { exit 0 }
$finalExitCode = 0
$backoffSeconds = 2
$maxBackoffSeconds = 60
$stableSeconds = 60
try {
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) { throw "No se pudo descifrar la credencial local de ManuMCP." }
    while ($true) {
        if (Test-ManuMcpActiveStopRequest -DataRoot $DataRoot -Component Tunnel) { break }
        $launchMutex = New-ManuMcpMutex -Name "$MutexNamespace.Tunnel.Launch"
        if (-not (Enter-ManuMcpMutex -Mutex $launchMutex)) {
            Write-ManuMcpLifecycleLog -Path $logPath -Message "Otra instalación está actualizando el túnel; el supervisor termina sin lanzar otro cliente." -Level WARN
            Exit-ManuMcpMutex -Mutex $launchMutex
            break
        }
        $child = $null
        try {
            if (Test-ManuMcpActiveStopRequest -DataRoot $DataRoot -Component Tunnel) { break }
            $quotedProfileDir = '"' + $ProfileDir.Replace('"', '\"') + '"'
            $quotedProfile = '"' + $Profile.Replace('"', '\"') + '"'
            $arguments = "run --profile-dir $quotedProfileDir --profile $quotedProfile"
            Write-ManuMcpLifecycleLog -Path $logPath -Message ("Iniciando tunnel-client {0} con HealthUrl {1}." -f $ClientPath, ([Uri]$HealthUrl).GetLeftPart([UriPartial]::Authority))
            $child = Start-Process -FilePath $ClientPath -ArgumentList $arguments -WorkingDirectory $ProfileDir -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
            $pidInfo = [ordered]@{
                schema = 1
                component = "Tunnel"
                pid = $child.Id
                startTime = $child.StartTime.ToUniversalTime().ToString('o')
                executable = $ClientPath
                profile = $Profile
                tunnelId = $TunnelId
                dataRoot = (Get-ManuMcpNormalizedPath $DataRoot)
            } | ConvertTo-Json -Compress
            Write-ManuMcpAtomicText -Path $pidPath -Text $pidInfo
        }
        catch {
            Write-ManuMcpLifecycleLog -Path $logPath -Message ("No se pudo iniciar tunnel-client: {0}" -f $_.Exception.Message) -Level ERROR
            if ($RunOnce) { $finalExitCode = 1; break }
        }
        finally { Exit-ManuMcpMutex -Mutex $launchMutex }
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
        Write-ManuMcpLifecycleLog -Path $logPath -Message ("tunnel-client terminó con código {0} después de {1:N0}s." -f $exitCode, $runtimeSeconds) -Level $level
        if ($RunOnce) { $finalExitCode = $exitCode; break }
        if (Test-ManuMcpActiveStopRequest -DataRoot $DataRoot -Component Tunnel) { break }
        if ($runtimeSeconds -ge $stableSeconds) { $backoffSeconds = 2 } else { $backoffSeconds = [Math]::Min($maxBackoffSeconds, $backoffSeconds * 2) }
        Start-Sleep -Seconds $backoffSeconds
    }
}
finally {
    if (Test-Path -LiteralPath $pidPath -PathType Leaf) { Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue }
    $env:CONTROL_PLANE_API_KEY = $null
    if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
    if ($null -ne $secureKey) { $secureKey.Dispose() }
    Exit-ManuMcpMutex -Mutex $instanceMutex
}
exit $finalExitCode
