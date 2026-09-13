[CmdletBinding()]
param(
    [string]$InstallDirectory = (Join-Path ([Environment]::GetFolderPath("UserProfile")) "ManuMCP"),
    [string]$RepositoryUrl = "https://github.com/ma-nucho-pro/ManuMCP.git"
)

$ErrorActionPreference = "Stop"
$git = Get-Command git -ErrorAction Stop
if (-not (Test-Path -LiteralPath $InstallDirectory)) {
    & $git.Source clone --depth 1 $RepositoryUrl $InstallDirectory
    if ($LASTEXITCODE -ne 0) { throw "git clone terminó con código $LASTEXITCODE." }
}
elseif (-not (Test-Path -LiteralPath (Join-Path $InstallDirectory ".git") -PathType Container)) {
    throw "La ruta $InstallDirectory ya existe y no es un repositorio Git; no se sobrescribirá."
}

$installer = Join-Path $InstallDirectory "scripts\install-windows.ps1"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "No se encontró el instalador de ManuMCP: $installer"
}
& $installer
exit $LASTEXITCODE
