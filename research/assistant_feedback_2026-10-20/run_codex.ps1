param(
    [Parameter(Mandatory=$true)][string]$PromptPath,
    [Parameter(Mandatory=$true)][string]$WorkspacePath
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:HTTP_PROXY = 'http://127.0.0.1:7897'
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$ReviewPrompt = [System.IO.File]::ReadAllText($PromptPath, [System.Text.Encoding]::UTF8)
$ReviewPrompt | & 'C:/Users/chikitwong/AppData/Roaming/npm/codex.ps1' `
    -a never exec -m gpt-5.6-sol -c 'model_reasoning_effort="high"' `
    -c 'windows.sandbox="unelevated"' `
    --sandbox read-only --skip-git-repo-check --ephemeral --json -C $WorkspacePath -
exit $LASTEXITCODE
