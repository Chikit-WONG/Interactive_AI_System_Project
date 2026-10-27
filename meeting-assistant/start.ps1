param(
    [switch]$CheckRuntime,
    [switch]$NoBrowser,
    [switch]$Recorder,
    [switch]$StopService,
    [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$meetingCandidates = @(
    Get-Command node -CommandType Application -All -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Source
    Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
) | Select-Object -Unique
$meetingNode = $null
foreach ($meetingCandidate in $meetingCandidates) {
    if (-not (Test-Path -LiteralPath $meetingCandidate -PathType Leaf)) { continue }
    try {
        $meetingVersion = & $meetingCandidate --version 2>$null
        if ($LASTEXITCODE -eq 0 -and "$meetingVersion" -match '^v(\d+)\.\d+\.\d+' -and [int]$Matches[1] -ge 22) {
            $meetingNode = $meetingCandidate
            break
        }
    } catch {
        continue
    }
}
if (-not $meetingNode) {
    throw 'Node.js 22 or newer is required. Install it and run start.cmd again.'
}
if ($CheckRuntime) {
    Write-Output "Compatible Node.js: $meetingVersion ($meetingNode)"
    exit 0
}
if ($Foreground) {
    & $meetingNode (Join-Path $PSScriptRoot 'server.mjs')
    exit $LASTEXITCODE
}

$meetingAction = if ($StopService) { 'stop' } else { 'start' }
$meetingArguments = @((Join-Path $PSScriptRoot 'launcher.mjs'), $meetingAction)
if ($Recorder) { $meetingArguments += '--recorder' }
$meetingResultText = & $meetingNode @meetingArguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$meetingResult = ($meetingResultText -join "`n") | ConvertFrom-Json
if ($StopService) {
    Write-Host 'Meeting Cue service is stopped. Double-click start.cmd to open it again.'
    exit 0
}
if ($meetingResult.url -notmatch '^http://127\.0\.0\.1:\d+/(recorder\.html)?$') {
    throw 'The launcher returned an unexpected address. The browser was not opened.'
}
Write-Host "Meeting Cue is ready: $($meetingResult.url)"
Write-Host 'The service stays running in the background. Use stop.cmd to fully exit.'
if (-not $NoBrowser) {
    try { Start-Process -FilePath $meetingResult.url }
    catch {
        Write-Warning 'The service is ready, but the browser could not be opened automatically.'
        Write-Host "Open this address manually: $($meetingResult.url)"
        exit 1
    }
}
exit 0
