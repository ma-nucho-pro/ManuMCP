#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Workspace,
    [string]$Downloads,
    [string]$PcRoot,
    [ValidateSet("read_only", "edit_safe", "full_access")]
    [string]$Profile = "full_access",
    [ValidateRange(1, 65535)]
    [int]$Port = 8787
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$helperPath = Join-Path $PSScriptRoot "windows-lifecycle.ps1"
. $helperPath
$node = (Get-Command node -ErrorAction Stop).Source
$npm = (Get-Command npm -ErrorAction Stop).Source
$nodeVersion = [version]((& $node --version).TrimStart("v"))
if ($nodeVersion -lt [version]"22.12.0") { throw "ManuMCP necesita Node.js 22.12 o posterior. Versión encontrada: $(& $node --version)." }
$systemPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $systemPowerShell -PathType Leaf)) { $systemPowerShell = (Get-Command powershell -ErrorAction Stop).Source }

$applicationData = [Environment]::GetFolderPath("ApplicationData")
$appDataDirectory = Join-Path $applicationData "ManuMCP"
New-Item -ItemType Directory -Path $appDataDirectory -Force | Out-Null
$taskName = "ManuMCP Agent"
$userId = "$env:USERDOMAIN\$env:USERNAME"
$userSid = Get-ManuMcpCurrentSid
$mutexNamespace = "Global\ManuMCP"
$launchMutex = New-ManuMcpMutex -Name "$mutexNamespace.Agent.Launch"
$launchHeld = $false
$operationId = [guid]::NewGuid().ToString("N")
$stopRequestPath = Get-ManuMcpStopRequestPath -DataRoot $appDataDirectory -Component Agent

function Quote-TaskArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    return ('"' + $Value.Replace('"', '\"') + '"')
}

function Get-TaskArgumentsText {
    param($Task)
    if ($null -eq $Task -or $null -eq $Task.Actions) { return "" }
    return (($Task.Actions | ForEach-Object { "{0} {1}" -f $_.Execute, $_.Arguments }) -join " | ")
}

function Assert-ExistingTaskIdentity {
    param($Task)
    if ($null -eq $Task) { return }
    $existingUser = [string]$Task.Principal.UserId
    $shortExistingUser = if ($existingUser.Contains('\')) { $existingUser.Split('\')[-1] } else { $existingUser }
    if (-not [string]::IsNullOrWhiteSpace($existingUser) -and $existingUser -ne $userId -and $shortExistingUser -ine $env:USERNAME) {
        throw "La tarea '$taskName' pertenece a otra identidad ($existingUser); no se detendrá ni reemplazará."
    }
}

function Get-ListeningPids {
    param([int]$LocalPort)
    if ($null -eq (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { return @() }
    return @(Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
}

function Stop-ExistingAgent {
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -eq $existingTask) { return }
    Assert-ExistingTaskIdentity -Task $existingTask
    Write-ManuMcpInstallState -DataRoot $appDataDirectory -Component Agent -OperationId $operationId -Phase Stopping -Extra @{ taskName = $taskName; userId = $userId; dataRoot = (Get-ManuMcpNormalizedPath $appDataDirectory) }
    Write-ManuMcpStopRequest -DataRoot $appDataDirectory -Component Agent -OperationId $operationId | Out-Null
    if ($existingTask.State -eq "Running") { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
    for ($attempt = 0; $attempt -lt 80; $attempt++) {
        $current = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        $running = $null -ne $current -and $current.State -eq "Running"
        $pidAlive = $false
        $pidPath = Join-Path $appDataDirectory "agent.pid.json"
        if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
            try {
                $pidInfo = Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json
                $process = Get-Process -Id ([int]$pidInfo.pid) -ErrorAction SilentlyContinue
                if ($null -ne $process) {
                    $sameStart = $true
                    if (-not [string]::IsNullOrWhiteSpace([string]$pidInfo.startTime)) { $sameStart = $process.StartTime.ToUniversalTime().ToString('o') -eq [string]$pidInfo.startTime }
                    $pidAlive = $sameStart -and ((Get-ManuMcpNormalizedPath ([string]$pidInfo.entryPoint)) -eq (Get-ManuMcpNormalizedPath (Join-Path $projectRoot "dist\app\server.js")))
                }
            }
            catch { throw "El PID registrado del agente no se puede verificar; se abortó sin matar procesos: $pidPath" }
        }
        $listeners = @(Get-ListeningPids -LocalPort $Port)
        if (-not $running -and -not $pidAlive -and $listeners.Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    }
    $remaining = @(Get-ListeningPids -LocalPort $Port)
    foreach ($ownerPid in $remaining) {
        $processInfo = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f [int]$ownerPid) -ErrorAction SilentlyContinue
        $owner = $null
        if ($null -ne $processInfo) { $owner = Invoke-CimMethod -InputObject $processInfo -MethodName GetOwner -ErrorAction SilentlyContinue }
        $ownerName = if ($null -ne $owner) { [string]$owner.User } else { "" }
        $expectedEntryPoint = Join-Path $projectRoot "dist\app\server.js"
        $sameUser = $ownerName -ieq $env:USERNAME
        $sameExecutable = $null -ne $processInfo -and (Get-ManuMcpNormalizedPath ([string]$processInfo.ExecutablePath)) -eq (Get-ManuMcpNormalizedPath $node)
        $sameEntryPoint = $null -ne $processInfo -and ([string]$processInfo.CommandLine -match [regex]::Escape($expectedEntryPoint))
        if ($sameUser -and $sameExecutable -and $sameEntryPoint) {
            # This is the exact orphaned child from the task we just stopped:
            # PID, user, executable and canonical entrypoint all match. Never
            # terminate a listener that fails any of these checks.
            Stop-Process -Id ([int]$ownerPid) -Force -ErrorAction Stop
        }
        else {
            throw "El puerto $Port sigue ocupado por un proceso no identificable como ManuMCP; no se terminó ningún proceso ajeno."
        }
    }
    Start-Sleep -Milliseconds 500
    $remaining = @(Get-ListeningPids -LocalPort $Port)
    if ($remaining.Count -eq 0) { return }
    throw "No se pudo detener de forma segura la instancia anterior de ManuMCP. Listener/PID restante: $($remaining -join ', '). No se terminó ningún proceso ajeno."
}

if (-not (Enter-ManuMcpMutex -Mutex $launchMutex)) { throw "Otra instalación de ManuMCP ya está actualizando el agente." }
$launchHeld = $true
try {
    $oldJournal = Read-ManuMcpInstallState -DataRoot $appDataDirectory
    if ($null -ne $oldJournal -and $oldJournal.phase -ne "Started") {
        # A stopped task is recoverable. A running/unknown listener is not.
        $oldTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Assert-ExistingTaskIdentity -Task $oldTask
        $oldListeners = @(Get-ListeningPids -LocalPort $Port)
        if ($null -ne $oldTask -and $oldTask.State -eq "Running" -or $oldListeners.Count -gt 0) {
            throw "Existe una operación de instalación incompleta con una instancia activa; se requiere apagado verificable antes de continuar."
        }
    }

    Stop-ExistingAgent
    Write-ManuMcpInstallState -DataRoot $appDataDirectory -Component Agent -OperationId $operationId -Phase Prepared -Extra @{ taskName = $taskName; userId = $userId; userSid = $userSid; projectRoot = (Get-ManuMcpNormalizedPath $projectRoot); port = $Port }

    Push-Location $projectRoot
    try {
        & $npm ci --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw "npm ci terminó con código $LASTEXITCODE." }
        & $npm run build
        if ($LASTEXITCODE -ne 0) { throw "La compilación de ManuMCP terminó con código $LASTEXITCODE." }
    }
    finally { Pop-Location }

    if ([string]::IsNullOrWhiteSpace($Workspace)) { $Workspace = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Desktop" }
    if ([string]::IsNullOrWhiteSpace($Downloads)) { $Downloads = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Downloads" }
    if ([string]::IsNullOrWhiteSpace($PcRoot)) { $PcRoot = [IO.Path]::GetPathRoot([Environment]::GetFolderPath("UserProfile")) }
    $resolvedWorkspace = [IO.Path]::GetFullPath($Workspace)
    $resolvedDownloads = [IO.Path]::GetFullPath($Downloads)
    $resolvedPcRoot = [IO.Path]::GetFullPath($PcRoot)
    foreach ($root in @($resolvedWorkspace, $resolvedDownloads, $resolvedPcRoot)) {
        if (Test-Path -LiteralPath $root -PathType Leaf) { throw "La raíz autorizada no es un directorio: $root" }
        New-Item -ItemType Directory -Path $root -Force | Out-Null
    }

    $utf8 = [Text.UTF8Encoding]::new($false)
    Write-ManuMcpAtomicText -Path (Join-Path $appDataDirectory "profile.txt") -Text $Profile
    Write-ManuMcpAtomicText -Path (Join-Path $appDataDirectory "node-path.txt") -Text $node
    Write-ManuMcpAtomicText -Path (Join-Path $appDataDirectory "project-root.txt") -Text $projectRoot
    $tokenPath = Join-Path $appDataDirectory "local-token.txt"
    if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
        $token = (& $node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))").Trim()
        if ($LASTEXITCODE -ne 0 -or $token.Length -lt 32) { throw "No se pudo generar el token local de ManuMCP." }
        Write-ManuMcpAtomicText -Path $tokenPath -Text $token
    }
    $rootsConfig = [ordered]@{ workspace = $resolvedWorkspace; downloads = $resolvedDownloads; pcRoot = $resolvedPcRoot } | ConvertTo-Json -Compress
    Write-ManuMcpAtomicText -Path (Join-Path $appDataDirectory "roots.json") -Text $rootsConfig

    $stdioWrapperSource = Join-Path $projectRoot "scripts\stdio-entrypoint.ps1"
    $stdioWrapperPath = Join-Path $appDataDirectory "stdio-entrypoint.ps1"
    $startSource = Join-Path $projectRoot "scripts\start-windows.ps1"
    $startPath = Join-Path $appDataDirectory "start-windows.ps1"
    $helperSource = Join-Path $projectRoot "scripts\windows-lifecycle.ps1"
    $helperDestination = Join-Path $appDataDirectory "windows-lifecycle.ps1"
    Copy-Item -LiteralPath $stdioWrapperSource -Destination $stdioWrapperPath -Force
    Copy-Item -LiteralPath $startSource -Destination $startPath -Force
    Copy-Item -LiteralPath $helperSource -Destination $helperDestination -Force

    $entryPoint = Join-Path $projectRoot "dist\app\server.js"
    $package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
    $criticalFiles = @(
        [ordered]@{ path = "dist\app\server.js"; sha256 = (Get-ManuMcpFileSha256 $entryPoint) },
        [ordered]@{ path = "package.json"; sha256 = (Get-ManuMcpFileSha256 (Join-Path $projectRoot "package.json")) },
        [ordered]@{ path = "scripts\start-windows.ps1"; sha256 = (Get-ManuMcpFileSha256 $startSource) },
        [ordered]@{ path = "scripts\stdio-entrypoint.ps1"; sha256 = (Get-ManuMcpFileSha256 $stdioWrapperSource) },
        [ordered]@{ path = "scripts\windows-lifecycle.ps1"; sha256 = (Get-ManuMcpFileSha256 $helperSource) }
    )
    $manifest = [ordered]@{
        schema = 1
        component = "Agent"
        version = [string]$package.version
        projectRoot = (Get-ManuMcpNormalizedPath $projectRoot)
        entryPoint = (Get-ManuMcpNormalizedPath $entryPoint)
        entryPointSha256 = (Get-ManuMcpFileSha256 $entryPoint)
        criticalFiles = $criticalFiles
        stdioWrapperSha256 = (Get-ManuMcpFileSha256 $stdioWrapperPath)
        startWrapperSha256 = (Get-ManuMcpFileSha256 $startPath)
        userSid = $userSid
        dataRoot = (Get-ManuMcpNormalizedPath $appDataDirectory)
        port = $Port
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json -Depth 8
    Write-ManuMcpAtomicText -Path (Join-Path $appDataDirectory "installation-manifest.json") -Text $manifest
    Write-ManuMcpInstallState -DataRoot $appDataDirectory -Component Agent -OperationId $operationId -Phase Staged -Extra @{ projectRoot = (Get-ManuMcpNormalizedPath $projectRoot); entryPoint = (Get-ManuMcpNormalizedPath $entryPoint); version = [string]$package.version; port = $Port }

    $quotedStart = Quote-TaskArgument $startPath
    # Forward slashes avoid the Windows command-line ambiguity of a quoted
    # root such as "C:\\" in Windows PowerShell 5.1.
    $taskPcRoot = $resolvedPcRoot.Replace('\', '/')
    $arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $quotedStart -ProjectRoot $(Quote-TaskArgument $projectRoot) -DataRoot $(Quote-TaskArgument $appDataDirectory) -NodePath $(Quote-TaskArgument $node) -Workspace $(Quote-TaskArgument $resolvedWorkspace) -Downloads $(Quote-TaskArgument $resolvedDownloads) -PcRoot $(Quote-TaskArgument $taskPcRoot) -Port $Port -MutexNamespace $(Quote-TaskArgument $mutexNamespace)"
    $action = New-ScheduledTaskAction -Execute $systemPowerShell -Argument $arguments -WorkingDirectory $appDataDirectory
    # The agent uses the user's interactive logon deliberately. It must have
    # the same Windows profile that owns the DPAPI configuration and the
    # desktop session used by the graphical tools. StartWhenAvailable below
    # makes the task catch up after boot/logon delays; no reinstall is needed
    # after a shutdown or restart.
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    # Windows PowerShell 5.1 exposes this logon mode as Interactive.
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 0 -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "ManuMCP local MCP agent with a supervised child and canonical installation manifest." -Force | Out-Null
    Write-ManuMcpInstallState -DataRoot $appDataDirectory -Component Agent -OperationId $operationId -Phase TaskRegistered -Extra @{ taskName = $taskName; taskUser = $userId; action = (Get-TaskArgumentsText (Get-ScheduledTask -TaskName $taskName)); projectRoot = (Get-ManuMcpNormalizedPath $projectRoot); port = $Port }
    $stopPath = Get-ManuMcpStopRequestPath -DataRoot $appDataDirectory -Component Agent
    if (Test-Path -LiteralPath $stopPath -PathType Leaf) { Remove-Item -LiteralPath $stopPath -Force }
    Write-ManuMcpInstallState -DataRoot $appDataDirectory -Component Agent -OperationId $operationId -Phase Committed -Extra @{ taskName = $taskName; taskUser = $userId; projectRoot = (Get-ManuMcpNormalizedPath $projectRoot); port = $Port }
    Exit-ManuMcpMutex -Mutex $launchMutex
    $launchHeld = $false

    Start-ScheduledTask -TaskName $taskName
    $healthyConsecutive = 0
    $healthUri = "http://127.0.0.1:$Port/healthz"
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try {
            $health = Invoke-RestMethod -Uri $healthUri -Method Get -TimeoutSec 2
            $versionOk = [string]$health.version -eq [string]$package.version
            if ($health.ok -eq $true -and $health.name -eq "ManuMCP" -and $health.profile -eq $Profile -and $versionOk) { $healthyConsecutive++ } else { $healthyConsecutive = 0 }
            if ($healthyConsecutive -ge 4) { $ready = $true; break }
        }
        catch { $healthyConsecutive = 0 }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) {
        $logPath = Join-Path $appDataDirectory "logs\agent.log"
        throw "La tarea se registró, pero el agente no alcanzó cuatro comprobaciones estables en $healthUri. Revisa $logPath."
    }
    Write-ManuMcpInstallState -DataRoot $appDataDirectory -Component Agent -OperationId $operationId -Phase Started -Extra @{ taskName = $taskName; taskUser = $userId; version = [string]$package.version; healthUrl = $healthUri; projectRoot = (Get-ManuMcpNormalizedPath $projectRoot); port = $Port }
}
finally {
    if ($launchHeld) { Exit-ManuMcpMutex -Mutex $launchMutex }
}

Write-Output "Perfil persistente: $Profile."
Write-Output "ManuMCP instalado como tarea '$taskName' bajo $userId."
Write-Output "Raíz canónica: $projectRoot"
Write-Output "Endpoint local: http://127.0.0.1:$Port/mcp"
Write-Output "Proceso supervisado por el wrapper; la tarea no tiene reinicio duplicado."
Write-Output "Se reanuda automáticamente después de cada apagado o reinicio al iniciar la sesión del usuario; no requiere reinstalación."
Write-Output "Logs: $(Join-Path $appDataDirectory 'logs\agent.log')"
