#requires -Version 5.1
# Shared Windows lifecycle helpers. This file is dot-sourced by the installers
# and by the copied runtime wrappers. Keep it compatible with Windows
# PowerShell 5.1: the wrappers run before Node is available to the caller.

function Get-ManuMcpNormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $full = [IO.Path]::GetFullPath($Path)
    if ($full.Length -gt 3) {
        $full = $full.TrimEnd('\')
    }
    return $full.ToLowerInvariant()
}

function Get-ManuMcpCurrentSid {
    return ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
}

function Write-ManuMcpAtomicText {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text
    )

    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporaryPath = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporaryPath, $Text, [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            try {
                [IO.File]::Replace($temporaryPath, $Path, $null, $true)
            }
            catch {
                Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
            }
        }
        else {
            [IO.File]::Move($temporaryPath, $Path)
        }
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-ManuMcpFileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "No existe el archivo requerido para verificar ManuMCP: $Path"
    }
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToUpperInvariant()
    }
    finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
}

function New-ManuMcpMutex {
    param([Parameter(Mandatory = $true)][string]$Name)

    return New-Object -TypeName System.Threading.Mutex -ArgumentList @($false, $Name)
}

function Enter-ManuMcpMutex {
    param([Parameter(Mandatory = $true)]$Mutex)

    try {
        return $Mutex.WaitOne(0)
    }
    catch [Threading.AbandonedMutexException] {
        return $true
    }
}

function Exit-ManuMcpMutex {
    param([Parameter(Mandatory = $true)]$Mutex)

    try { $Mutex.ReleaseMutex() } catch { }
    try { $Mutex.Dispose() } catch { }
}

function Get-ManuMcpStopRequestPath {
    param(
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [Parameter(Mandatory = $true)][ValidateSet('Agent', 'Tunnel')][string]$Component
    )

    return (Join-Path $DataRoot ("{0}.stop-request.json" -f $Component.ToLowerInvariant()))
}

function Get-ManuMcpJournalPath {
    param(
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [ValidateSet('Agent', 'Tunnel')][string]$Component = 'Agent'
    )

    return (Join-Path $DataRoot ("{0}-install-state.json" -f $Component.ToLowerInvariant()))
}

function Write-ManuMcpStopRequest {
    param(
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [Parameter(Mandatory = $true)][ValidateSet('Agent', 'Tunnel')][string]$Component,
        [Parameter(Mandatory = $true)][string]$OperationId
    )

    $path = Get-ManuMcpStopRequestPath -DataRoot $DataRoot -Component $Component
    $process = Get-Process -Id $PID -ErrorAction SilentlyContinue
    $startTime = $null
    if ($null -ne $process) {
        try { $startTime = $process.StartTime.ToUniversalTime().ToString('o') } catch { }
    }
    $request = [ordered]@{
        schema = 1
        component = $Component
        operationId = $OperationId
        installerPid = $PID
        installerStartTime = $startTime
        dataRoot = (Get-ManuMcpNormalizedPath $DataRoot)
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json -Compress
    Write-ManuMcpAtomicText -Path $path -Text $request
    return $path
}

function Read-ManuMcpStopRequest {
    param(
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [Parameter(Mandatory = $true)][ValidateSet('Agent', 'Tunnel')][string]$Component
    )

    $path = Get-ManuMcpStopRequestPath -DataRoot $DataRoot -Component $Component
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        $request = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    }
    catch {
        throw "El stop-request de $Component está corrupto y se bloqueó el arranque: $path"
    }
    if ($request.schema -ne 1 -or $request.component -ne $Component -or [string]::IsNullOrWhiteSpace([string]$request.operationId) -or [string]::IsNullOrWhiteSpace([string]$request.dataRoot)) {
        throw "El stop-request de $Component tiene un esquema desconocido y se bloqueó el arranque: $path"
    }
    if ((Get-ManuMcpNormalizedPath ([string]$request.dataRoot)) -ne (Get-ManuMcpNormalizedPath $DataRoot)) {
        throw "El stop-request de $Component pertenece a otra instalación: $path"
    }
    return $request
}

function Test-ManuMcpInstallerStillRunning {
    param([Parameter(Mandatory = $true)]$Request)

    $process = Get-Process -Id ([int]$Request.installerPid) -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $false }
    if ([string]::IsNullOrWhiteSpace([string]$Request.installerStartTime)) { return $true }
    try {
        return $process.StartTime.ToUniversalTime().ToString('o') -eq [string]$Request.installerStartTime
    }
    catch {
        return $true
    }
}

function Test-ManuMcpActiveStopRequest {
    param(
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [Parameter(Mandatory = $true)][ValidateSet('Agent', 'Tunnel')][string]$Component
    )

    $path = Get-ManuMcpStopRequestPath -DataRoot $DataRoot -Component $Component
    $request = Read-ManuMcpStopRequest -DataRoot $DataRoot -Component $Component
    if ($null -eq $request) { return $false }
    if (Test-ManuMcpInstallerStillRunning -Request $request) { return $true }

    # The launch mutex is held by an active installer while it changes files.
    # Once it is free and the installer PID has disappeared/reused, the request
    # is stale and can be removed safely by the next wrapper.
    Remove-Item -LiteralPath $path -Force
    return $false
}

function Write-ManuMcpInstallState {
    param(
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [Parameter(Mandatory = $true)][string]$Component,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [Parameter(Mandatory = $true)][ValidateSet('Prepared', 'Stopping', 'Staged', 'TaskRegistered', 'Committed', 'Started')][string]$Phase,
        [hashtable]$Extra
    )

    $state = [ordered]@{
        schema = 1
        component = $Component
        operationId = $OperationId
        phase = $Phase
        dataRoot = (Get-ManuMcpNormalizedPath $DataRoot)
        updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    if ($null -ne $Extra) {
        foreach ($key in $Extra.Keys) { $state[$key] = $Extra[$key] }
    }
    Write-ManuMcpAtomicText -Path (Get-ManuMcpJournalPath -DataRoot $DataRoot -Component $Component) -Text ($state | ConvertTo-Json -Depth 8 -Compress)
}

function Read-ManuMcpInstallState {
    param(
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [ValidateSet('Agent', 'Tunnel')][string]$Component = 'Agent'
    )

    $path = Get-ManuMcpJournalPath -DataRoot $DataRoot -Component $Component
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try { $state = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json }
    catch { throw "El journal de instalación está corrupto y se bloqueó la reparación: $path" }
    if ($state.schema -ne 1 -or [string]::IsNullOrWhiteSpace([string]$state.operationId) -or [string]::IsNullOrWhiteSpace([string]$state.phase)) {
        throw "El journal de instalación tiene un esquema desconocido: $path"
    }
    return $state
}

function Remove-ManuMcpInstallState {
    param(
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [ValidateSet('Agent', 'Tunnel')][string]$Component = 'Agent'
    )

    $path = Get-ManuMcpJournalPath -DataRoot $DataRoot -Component $Component
    if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
}

function Write-ManuMcpLifecycleLog {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR')][string]$Level = 'INFO',
        [int64]$MaxBytes = 5MB
    )

    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $length = (Get-Item -LiteralPath $Path).Length
        if ($length -ge $MaxBytes) {
            $rotated = "$Path.1"
            if (Test-Path -LiteralPath $rotated -PathType Leaf) { Remove-Item -LiteralPath $rotated -Force }
            Move-Item -LiteralPath $Path -Destination $rotated -Force
        }
    }
    $safeMessage = $Message -replace '(?i)(api[_-]?key|authorization|token|password)\s*[:=]\s*\S+', '$1=[redacted]'
    Add-Content -LiteralPath $Path -Value ("{0} [{1}] {2}" -f (Get-Date).ToUniversalTime().ToString('o'), $Level, $safeMessage)
}

function Assert-ManuMcpHealthUrl {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [switch]$RequireLoopback
    )

    try { $uri = New-Object System.Uri($Url) } catch { throw "HealthUrl no es una URL absoluta válida: $Url" }
    if (-not $uri.IsAbsoluteUri -or @('http', 'https') -notcontains $uri.Scheme.ToLowerInvariant()) {
        throw "HealthUrl solo admite URLs absolutas http/https."
    }
    if (-not [string]::IsNullOrWhiteSpace($uri.UserInfo) -or -not [string]::IsNullOrWhiteSpace($uri.Query) -or -not [string]::IsNullOrWhiteSpace($uri.Fragment)) {
        throw "HealthUrl no puede contener credenciales, query ni fragmento."
    }
    if ($RequireLoopback -and -not ($uri.IsLoopback)) {
        throw "El health del agente debe permanecer en loopback."
    }
    return $uri.AbsoluteUri.TrimEnd('/')
}
