[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$taskName = "ManuMCP Agent"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "Se eliminó la tarea programada '$taskName'."
}
else {
    Write-Output "La tarea '$taskName' no estaba instalada."
}
Write-Output "No se eliminaron el workspace, los archivos ni el token local."
