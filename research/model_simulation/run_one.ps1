param(
    [Parameter(Mandatory=$true)][string]$ModelId,
    [Parameter(Mandatory=$true)][string]$PromptPath,
    [Parameter(Mandatory=$true)][string]$WorkspacePath
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:HTTP_PROXY = 'http://127.0.0.1:7897'
Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:ALL_PROXY -ErrorAction SilentlyContinue
$SimulationPrompt = [System.IO.File]::ReadAllText($PromptPath, [System.Text.Encoding]::UTF8)
$AgentArguments = @('--mode','ask','--print','--model',$ModelId,'--output-format','stream-json','--workspace',$WorkspacePath)
& 'C:\Users\chikitwong\AppData\Local\cursor-agent\agent.ps1' @AgentArguments $SimulationPrompt
exit $LASTEXITCODE
