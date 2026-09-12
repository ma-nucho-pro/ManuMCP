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
