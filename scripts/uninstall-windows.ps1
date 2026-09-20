#requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$helperPath = Join-Path $PSScriptRoot "windows-lifecycle.ps1"
. $helperPath
$applicationData = [Environment]::GetFolderPath("ApplicationData")
$dataRoot = Join-Path $applicationData "ManuMCP"
$userId = "$env:USERDOMAIN\$env:USERNAME"

function Remove-ManuMcpTask {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][ValidateSet('Agent', 'Tunnel')][string]$Component
    )
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        Write-Output "La tarea '$TaskName' no estaba instalada."
        return
    }
    $existingUser = [string]$task.Principal.UserId
    $shortExistingUser = if ($existingUser.Contains('\')) { $existingUser.Split('\')[-1] } else { $existingUser }
    if (-not [string]::IsNullOrWhiteSpace($existingUser) -and $existingUser -ne $userId -and $shortExistingUser -ine $env:USERNAME) {
        throw "La tarea '$TaskName' pertenece a otra identidad; no se eliminará."
    }
    $stopPath = Get-ManuMcpStopRequestPath -DataRoot $dataRoot -Component $Component
    if ($task.State -eq "Running") {
        $operationId = [guid]::NewGuid().ToString('N')
        Write-ManuMcpStopRequest -DataRoot $dataRoot -Component $Component -OperationId $operationId | Out-Null
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            $current = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            if ($null -eq $current -or $current.State -ne "Running") { break }
            Start-Sleep -Milliseconds 250
        }
        $current = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($null -ne $current -and $current.State -eq "Running") { throw "No se pudo detener '$TaskName' de forma verificable; no se eliminó nada." }
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    if (Test-Path -LiteralPath $stopPath -PathType Leaf) { Remove-Item -LiteralPath $stopPath -Force }
    $journalPath = Get-ManuMcpJournalPath -DataRoot $dataRoot -Component $Component
    if (Test-Path -LiteralPath $journalPath -PathType Leaf) { Remove-Item -LiteralPath $journalPath -Force }
    Write-Output "Se eliminó la tarea programada '$TaskName'."
}

Remove-ManuMcpTask -TaskName "ManuMCP Agent" -Component Agent
Remove-ManuMcpTask -TaskName "ManuMCP Tunnel" -Component Tunnel
Write-Output "Se conservaron el perfil, la configuración, los logs, el token y la credencial DPAPI."
Write-Output "No se eliminaron el workspace, los archivos compilados ni los directorios compartidos."
