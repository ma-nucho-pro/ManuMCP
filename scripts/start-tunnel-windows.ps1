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
    [string]$ProfileDir = (Join-Path ([Environment]::GetFolderPath("ApplicationData")) "tunnel-client")
)

$ErrorActionPreference = "Stop"

# The stdio child inherits this value. Keep the default aligned with the
# Windows agent so the OpenAI tunnel exposes the user's actual roots too.
$userProfile = [Environment]::GetFolderPath("UserProfile")
$appDataDirectory = Join-Path ([Environment]::GetFolderPath("ApplicationData")) "ManuMCP"
$rootsConfigPath = Join-Path $appDataDirectory "roots.json"
$rootsConfig = $null
if (Test-Path -LiteralPath $rootsConfigPath -PathType Leaf) {
    try {
        $rootsConfig = Get-Content -LiteralPath $rootsConfigPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "La configuración de raíces de ManuMCP no contiene JSON válido: $rootsConfigPath"
    }
}
if ([string]::IsNullOrWhiteSpace($env:MANUMCP_WORKSPACE)) {
    $configuredWorkspace = [string]$rootsConfig.workspace
    if (-not [string]::IsNullOrWhiteSpace($configuredWorkspace)) {
        $env:MANUMCP_WORKSPACE = $configuredWorkspace
    }
    $desktopPath = [Environment]::GetFolderPath("Desktop")
    if ([string]::IsNullOrWhiteSpace($env:MANUMCP_WORKSPACE)) {
        if ([string]::IsNullOrWhiteSpace($desktopPath)) {
            $desktopPath = Join-Path $userProfile "Desktop"
        }
        $env:MANUMCP_WORKSPACE = $desktopPath
    }
}
if ([string]::IsNullOrWhiteSpace($env:MANUMCP_DOWNLOADS)) {
    $configuredDownloads = [string]$rootsConfig.downloads
    $env:MANUMCP_DOWNLOADS = if ([string]::IsNullOrWhiteSpace($configuredDownloads)) { Join-Path $userProfile "Downloads" } else { $configuredDownloads }
}
if ([string]::IsNullOrWhiteSpace($env:MANUMCP_PC_ROOT)) {
    $configuredPcRoot = [string]$rootsConfig.pcRoot
    if ([string]::IsNullOrWhiteSpace($configuredPcRoot)) {
        $configuredPcRoot = [IO.Path]::GetPathRoot([Environment]::GetFolderPath("Windows"))
        if ([string]::IsNullOrWhiteSpace($configuredPcRoot)) {
            $configuredPcRoot = [IO.Path]::GetPathRoot($userProfile)
        }
    }
    $env:MANUMCP_PC_ROOT = $configuredPcRoot
}

if (-not (Test-Path -LiteralPath $ClientPath -PathType Leaf)) {
    throw "No se encontró tunnel-client: $ClientPath"
}
if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
    throw "No se encontró la credencial local protegida: $KeyPath"
}

$profilePath = Join-Path $ProfileDir "$Profile.yaml"
if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) {
    throw "No se encontró el perfil del túnel: $profilePath"
}
$profileText = Get-Content -LiteralPath $profilePath -Raw
if ($profileText -notmatch [regex]::Escape($TunnelId)) {
    throw "El perfil '$Profile' no corresponde al túnel indicado."
}

$encryptedKey = (Get-Content -LiteralPath $KeyPath -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($encryptedKey)) {
    throw "La credencial local protegida está vacía."
}

$secureKey = ConvertTo-SecureString -String $encryptedKey
$keyPointer = [IntPtr]::Zero
try {
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
        throw "No se pudo descifrar la credencial local de ManuMCP."
    }

    & $ClientPath run --profile-dir $ProfileDir --profile $Profile
    $exitCode = $LASTEXITCODE
}
finally {
    if ($keyPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    }
    $env:CONTROL_PLANE_API_KEY = $null
    if ($null -ne $secureKey) {
        $secureKey.Dispose()
    }
}

exit $exitCode
