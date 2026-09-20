#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^tunnel_[0-9a-f]{32}$')]
    [string]$TunnelId,
    [string]$Profile = "manumcp-final",
    [string]$ClientPath,
    [string]$HealthUrl,
    [string]$OrganizationId = $env:CONTROL_PLANE_ORGANIZATION_ID
)

$ErrorActionPreference = "Stop"
$helperPath = Join-Path $PSScriptRoot "windows-lifecycle.ps1"
. $helperPath
if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY) -or $env:CONTROL_PLANE_API_KEY -notmatch '^sk-[A-Za-z0-9_-]{20,}$') {
    throw "Define CONTROL_PLANE_API_KEY solo en esta sesión antes de instalar el arranque del túnel. No lo guardes en el repositorio."
}
if (-not [string]::IsNullOrWhiteSpace($OrganizationId) -and $OrganizationId -notmatch '^org-[A-Za-z0-9_-]+$') {
    throw "OrganizationId debe tener formato org-... y pertenecer a la misma organización que el túnel y la runtime key."
}
if ([string]::IsNullOrWhiteSpace($ClientPath)) {
    $clientCommand = Get-Command tunnel-client -ErrorAction SilentlyContinue
    $ClientPath = if ($null -ne $clientCommand) { $clientCommand.Source } else { Join-Path $env:LOCALAPPDATA "ManuMCP\tunnel-client\tunnel-client.exe" }
}
if (-not (Test-Path -LiteralPath $ClientPath -PathType Leaf)) { throw "No se encontró tunnel-client: $ClientPath" }
$ClientPath = (Resolve-Path -LiteralPath $ClientPath).Path

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$applicationData = [Environment]::GetFolderPath("ApplicationData")
$appDataDirectory = Join-Path $applicationData "ManuMCP"
$profileDirectory = Join-Path $applicationData "tunnel-client"
$taskName = "ManuMCP Tunnel"
$userId = "$env:USERDOMAIN\$env:USERNAME"
$userSid = Get-ManuMcpCurrentSid
$mutexNamespace = "Global\ManuMCP"
New-Item -ItemType Directory -Path $appDataDirectory, $profileDirectory -Force | Out-Null
$launchMutex = New-ManuMcpMutex -Name "$mutexNamespace.Tunnel.Launch"
$launchHeld = $false
$operationId = [guid]::NewGuid().ToString("N")
$startSource = Join-Path $projectRoot "scripts\start-tunnel-windows.ps1"
$startPath = Join-Path $appDataDirectory "start-tunnel-windows.ps1"
$helperSource = Join-Path $projectRoot "scripts\windows-lifecycle.ps1"
$helperDestination = Join-Path $appDataDirectory "windows-lifecycle.ps1"
$keyPath = Join-Path $appDataDirectory "control-plane-key.dpapi"

function Quote-TaskArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    return ('"' + $Value.Replace('"', '\"') + '"')
}
function Get-TaskArgumentsText { param($Task); if ($null -eq $Task -or $null -eq $Task.Actions) { return "" }; return (($Task.Actions | ForEach-Object { "{0} {1}" -f $_.Execute, $_.Arguments }) -join " | ") }
function Assert-ExistingTaskIdentity {
    param($Task)
    if ($null -eq $Task) { return }
    $existingUser = [string]$Task.Principal.UserId
    $shortExistingUser = if ($existingUser.Contains('\')) { $existingUser.Split('\')[-1] } else { $existingUser }
    if (-not [string]::IsNullOrWhiteSpace($existingUser) -and $existingUser -ne $userId -and $shortExistingUser -ine $env:USERNAME) { throw "La tarea '$taskName' pertenece a otra identidad; no se detendrá ni reemplazará." }
}
function Get-ListeningPids {
    param([int]$LocalPort)
    if ($null -eq (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { return @() }
    return @(Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
}
function Get-HealthPort {
    param([string]$Url)
    return (New-Object System.Uri($Url)).Port
}
function Stop-ExistingTunnel {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -eq $task) { return }
    Assert-ExistingTaskIdentity -Task $task
    Write-ManuMcpInstallState -DataRoot $appDataDirectory -Component Tunnel -OperationId $operationId -Phase Stopping -Extra @{ taskName = $taskName; userId = $userId }
    Write-ManuMcpStopRequest -DataRoot $appDataDirectory -Component Tunnel -OperationId $operationId | Out-Null
    if ($task.State -eq "Running") { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
    $port = Get-HealthPort -Url $HealthUrl
    for ($attempt = 0; $attempt -lt 80; $attempt++) {
        $current = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        $running = $null -ne $current -and $current.State -eq "Running"
        $pidAlive = $false
        $pidPath = Join-Path $appDataDirectory "tunnel.pid.json"
        if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
            try {
                $pidInfo = Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json
                $process = Get-Process -Id ([int]$pidInfo.pid) -ErrorAction SilentlyContinue
                if ($null -ne $process) {
                    $sameStart = $true
                    if ($pidInfo.startTime) { $sameStart = $process.StartTime.ToUniversalTime().ToString('o') -eq [string]$pidInfo.startTime }
                    $pidAlive = $sameStart -and ((Get-ManuMcpNormalizedPath ([string]$pidInfo.executable)) -eq (Get-ManuMcpNormalizedPath $ClientPath))
                }
            }
            catch { throw "El PID registrado del túnel no se puede verificar; se abortó sin matar procesos." }
        }
        $listeners = @(Get-ListeningPids -LocalPort $port)
        if (-not $running -and -not $pidAlive -and $listeners.Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    }
    $remaining = @(Get-ListeningPids -LocalPort $port)
    foreach ($ownerPid in $remaining) {
        $processInfo = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f [int]$ownerPid) -ErrorAction SilentlyContinue
        $owner = $null
        if ($null -ne $processInfo) { $owner = Invoke-CimMethod -InputObject $processInfo -MethodName GetOwner -ErrorAction SilentlyContinue }
        $ownerName = if ($null -ne $owner) { [string]$owner.User } else { "" }
        $sameUser = $ownerName -ieq $env:USERNAME
        $sameExecutable = $null -ne $processInfo -and (Get-ManuMcpNormalizedPath ([string]$processInfo.ExecutablePath)) -eq (Get-ManuMcpNormalizedPath $ClientPath)
        $sameProfile = $null -ne $processInfo -and ([string]$processInfo.CommandLine -match [regex]::Escape($Profile)) -and ([string]$processInfo.CommandLine -match [regex]::Escape($profileDirectory))
        if ($sameUser -and $sameExecutable -and $sameProfile) {
            Stop-Process -Id ([int]$ownerPid) -Force -ErrorAction Stop
        }
        else {
            throw "El puerto $port del túnel sigue ocupado por un proceso no identificable; no se terminó ningún proceso ajeno."
        }
    }
    Start-Sleep -Milliseconds 500
    $remaining = @(Get-ListeningPids -LocalPort $port)
    if ($remaining.Count -eq 0) { return }
    throw "No se pudo detener de forma segura la instancia anterior del túnel. No se terminó ningún proceso ajeno."
}

if (-not (Enter-ManuMcpMutex -Mutex $launchMutex)) { throw "Otra instalación de ManuMCP ya está actualizando el túnel." }
$launchHeld = $true
try {
    $profilePath = Join-Path $profileDirectory "$Profile.yaml"
    $profileExisted = Test-Path -LiteralPath $profilePath -PathType Leaf
    if ($profileExisted) {
        # A running tunnel already owns HealthUrl. Stop that exact task/child
        # before doctor tries to reserve the health listener for this install.
        $profileText = Get-Content -LiteralPath $profilePath -Raw
        if ([string]::IsNullOrWhiteSpace($HealthUrl)) {
            $listenMatch = [regex]::Match($profileText, '(?m)^\s*listen_addr:\s*["'']?([^"''\r\n#]+)')
            if (-not $listenMatch.Success) { throw "El perfil no define listen_addr; pasa -HealthUrl explícitamente." }
            $HealthUrl = "http://$($listenMatch.Groups[1].Value.Trim())"
        }
        $HealthUrl = Assert-ManuMcpHealthUrl -Url $HealthUrl
        Stop-ExistingTunnel
    }

    # Configure/doctor uses the API key only in this process. The encrypted
    # DPAPI blob is reused byte-for-byte when it already exists.
    & (Join-Path $PSScriptRoot "run-openai-tunnel.ps1") -TunnelId $TunnelId -Profile $Profile -ClientPath $ClientPath -ProfileDir $profileDirectory -OrganizationId $OrganizationId -ConfigureOnly
    if ($LASTEXITCODE -ne 0) { throw "No se pudo preparar el perfil del túnel." }
    if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) { throw "No se creó el perfil del túnel: $profilePath" }
    $profileText = Get-Content -LiteralPath $profilePath -Raw
    if ([string]::IsNullOrWhiteSpace($HealthUrl)) {
        $listenMatch = [regex]::Match($profileText, '(?m)^\s*listen_addr:\s*["'']?([^"''\r\n#]+)')
        if (-not $listenMatch.Success) { throw "El perfil no define listen_addr; pasa -HealthUrl explícitamente." }
        $HealthUrl = "http://$($listenMatch.Groups[1].Value.Trim())"
    }
    $HealthUrl = Assert-ManuMcpHealthUrl -Url $HealthUrl
    if ([string]::IsNullOrWhiteSpace($HealthUrl)) { throw "HealthUrl no puede quedar vacío." }

    if (-not $profileExisted) { Stop-ExistingTunnel }
    Write-ManuMcpInstallState -DataRoot $appDataDirectory -Component Tunnel -OperationId $operationId -Phase Prepared -Extra @{ taskName = $taskName; userId = $userId; userSid = $userSid; tunnelId = $TunnelId; profile = $Profile; healthUrl = $HealthUrl }

    if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
        $secureKey = ConvertTo-SecureString -String $env:CONTROL_PLANE_API_KEY -AsPlainText -Force
        try { Write-ManuMcpAtomicText -Path $keyPath -Text (ConvertFrom-SecureString -SecureString $secureKey) }
        finally { $secureKey.Dispose() }
    }
    & icacls.exe $keyPath /inheritance:r | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "No se pudo limitar la credencial local (icacls $LASTEXITCODE)." }
    $grant = "$userId`:(F)"
    & icacls.exe $keyPath /grant:r $grant | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "No se pudo limitar la credencial local al usuario actual (icacls $LASTEXITCODE)." }

    Copy-Item -LiteralPath $startSource -Destination $startPath -Force
    Copy-Item -LiteralPath $helperSource -Destination $helperDestination -Force
    $tunnelManifest = [ordered]@{
        schema = 1
        component = "Tunnel"
        tunnelId = $TunnelId
        profile = $Profile
        organizationId = $OrganizationId
        clientPath = (Get-ManuMcpNormalizedPath $ClientPath)
        clientSha256 = (Get-ManuMcpFileSha256 $ClientPath)
        profileDir = (Get-ManuMcpNormalizedPath $profileDirectory)
        keyPath = (Get-ManuMcpNormalizedPath $keyPath)
        healthUrl = $HealthUrl
        wrapperSha256 = (Get-ManuMcpFileSha256 $startPath)
        userSid = $userSid
        dataRoot = (Get-ManuMcpNormalizedPath $appDataDirectory)
        clientVersion = "v0.0.14"
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json -Depth 8
    Write-ManuMcpAtomicText -Path (Join-Path $appDataDirectory "tunnel-install-manifest.json") -Text $tunnelManifest
    Write-ManuMcpInstallState -DataRoot $appDataDirectory -Component Tunnel -OperationId $operationId -Phase Staged -Extra @{ tunnelId = $TunnelId; profile = $Profile; healthUrl = $HealthUrl; clientPath = (Get-ManuMcpNormalizedPath $ClientPath) }

    $systemPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path -LiteralPath $systemPowerShell -PathType Leaf)) { $systemPowerShell = (Get-Command powershell -ErrorAction Stop).Source }
    $arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $(Quote-TaskArgument $startPath) -TunnelId $TunnelId -Profile $(Quote-TaskArgument $Profile) -ClientPath $(Quote-TaskArgument $ClientPath) -KeyPath $(Quote-TaskArgument $keyPath) -ProfileDir $(Quote-TaskArgument $profileDirectory) -DataRoot $(Quote-TaskArgument $appDataDirectory) -ProjectRoot $(Quote-TaskArgument $projectRoot) -HealthUrl $(Quote-TaskArgument $HealthUrl) -MutexNamespace $(Quote-TaskArgument $mutexNamespace)"
    $action = New-ScheduledTaskAction -Execute $systemPowerShell -Argument $arguments -WorkingDirectory $appDataDirectory
    # The tunnel key is protected with the installing user's DPAPI profile,
    # so the task must run in that user's interactive session. This is the
    # durable post-boot trigger; StartWhenAvailable below covers delayed
    # logons and a shutdown/restart never requires another installation.
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    # Windows PowerShell 5.1 exposes this logon mode as Interactive.
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 0 -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "ManuMCP secure outbound tunnel with supervised runtime and explicit health contract." -Force | Out-Null
    Write-ManuMcpInstallState -DataRoot $appDataDirectory -Component Tunnel -OperationId $operationId -Phase TaskRegistered -Extra @{ taskName = $taskName; taskUser = $userId; healthUrl = $HealthUrl; action = (Get-TaskArgumentsText (Get-ScheduledTask -TaskName $taskName)) }
    $stopPath = Get-ManuMcpStopRequestPath -DataRoot $appDataDirectory -Component Tunnel
    if (Test-Path -LiteralPath $stopPath -PathType Leaf) { Remove-Item -LiteralPath $stopPath -Force }
    Write-ManuMcpInstallState -DataRoot $appDataDirectory -Component Tunnel -OperationId $operationId -Phase Committed -Extra @{ taskName = $taskName; taskUser = $userId; healthUrl = $HealthUrl }
    Exit-ManuMcpMutex -Mutex $launchMutex
    $launchHeld = $false
    Start-ScheduledTask -TaskName $taskName

    $healthyConsecutive = 0
    $ready = $false
    $healthError = ""
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $output = (& $ClientPath health --url $HealthUrl --require-control-plane-poll --json 2>&1 | Out-String).Trim()
        $exitCode = $LASTEXITCODE
        try { $health = $output | ConvertFrom-Json } catch { $health = $null }
        $checksOk = $exitCode -eq 0 -and $null -ne $health -and $health.result -eq "ok" -and $health.healthz.ok -eq $true -and $health.readyz.ok -eq $true -and $health.control_plane_poll.ok -eq $true
        if ($checksOk) { $healthyConsecutive++ } else { $healthyConsecutive = 0; $healthError = if ([string]::IsNullOrWhiteSpace($output)) { "exit=$exitCode" } else { "exit=$exitCode result=$($health.result)" } }
        if ($healthyConsecutive -ge 4) { $ready = $true; break }
        Start-Sleep -Milliseconds 1000
    }
    if (-not $ready) {
        throw "El túnel quedó instalado localmente, pero no alcanzó cuatro comprobaciones de salud/control plane. Último estado: $healthError. Revisa $(Join-Path $appDataDirectory 'logs\tunnel.log')."
    }
    Write-ManuMcpInstallState -DataRoot $appDataDirectory -Component Tunnel -OperationId $operationId -Phase Started -Extra @{ taskName = $taskName; taskUser = $userId; tunnelId = $TunnelId; profile = $Profile; organizationId = $OrganizationId; healthUrl = $HealthUrl; clientVersion = "v0.0.14" }
}
finally {
    if ($launchHeld) { Exit-ManuMcpMutex -Mutex $launchMutex }
}

Write-Output "Arranque automático del túnel instalado como tarea '$taskName' bajo $userId."
Write-Output "Túnel: $TunnelId"
Write-Output "Perfil: $Profile"
if (-not [string]::IsNullOrWhiteSpace($OrganizationId)) { Write-Output "Organización: $OrganizationId" }
Write-Output "HealthUrl local: $HealthUrl"
Write-Output "Credencial: conservada/protegida con Windows DPAPI para el usuario actual."
Write-Output "La tarea usa supervisor propio y no añade reinicios duplicados."
Write-Output "Se reconecta automáticamente después de cada apagado o reinicio al iniciar la sesión del usuario; no requiere reinstalación."
