param(
  [Parameter(Mandatory=$true)][string]$Provider,
  [Parameter(Mandatory=$true)][string]$ModelId,
  [Parameter(Mandatory=$true)][string]$PromptPath,
  [Parameter(Mandatory=$true)][string]$WorkspacePath
)
$ErrorActionPreference = 'Stop'
$Utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8
[Console]::OutputEncoding = $Utf8
$OutputEncoding = $Utf8
$env:HTTP_PROXY = 'http://127.0.0.1:7897'
Remove-Item Env:ALL_PROXY -ErrorAction SilentlyContinue
$ReviewPrompt = [IO.File]::ReadAllText($PromptPath, [Text.Encoding]::UTF8)
if ($Provider -eq 'cursor') {
  Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
  $AgentArgs = @('--mode','ask','--print','--model',$ModelId,'--output-format','stream-json','--workspace',$WorkspacePath)
  & 'C:\Users\chikitwong\AppData\Local\cursor-agent\agent.ps1' @AgentArgs $ReviewPrompt
} elseif ($Provider -eq 'codex') {
  $env:HTTPS_PROXY = 'http://127.0.0.1:7897'
  $AgentArgs = @('-a','never','exec','--model',$ModelId,'-c','model_reasoning_effort="high"','--sandbox','read-only','--skip-git-repo-check','--ephemeral','--json','--color','never','-C',$WorkspacePath,'-')
  $ReviewPrompt | & 'C:\Users\chikitwong\AppData\Roaming\npm\codex.ps1' @AgentArgs
} else {
  throw "Unsupported provider"
}
exit $LASTEXITCODE
