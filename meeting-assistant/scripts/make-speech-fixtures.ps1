$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$fixtureDir = Join-Path $PSScriptRoot '../test-output/speech-diagnostic'
[System.IO.Directory]::CreateDirectory($fixtureDir) | Out-Null
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $voices = @($synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo })
    foreach ($sample in @(
        @{ lang = 'zh-CN'; text = '这是一段语音测试。小林，请确认明天上午十点四十分参加排练。' },
        @{ lang = 'en-US'; text = 'This is a speech recognition test. Please confirm that the rehearsal starts tomorrow morning at ten forty.' }
    )) {
        $voice = $voices | Where-Object { $_.Culture.Name -eq $sample.lang } | Select-Object -First 1
        if (-not $voice) {
            Add-Type -AssemblyName System.Runtime.WindowsRuntime
            $runtimeType = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]
            $runtimeVoice = $runtimeType::AllVoices | Where-Object { $_.Language -eq $sample.lang } | Select-Object -First 1
            if (-not $runtimeVoice) { Write-Output "No installed voice for $($sample.lang)"; continue }
            $runtimeSynth = [Activator]::CreateInstance($runtimeType)
            try {
                $runtimeSynth.Voice = $runtimeVoice
                $asyncSpeech = $runtimeSynth.SynthesizeTextToStreamAsync($sample.text)
                $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
                    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
                    $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
                } | Select-Object -First 1
                $speechStreamType = [Windows.Media.SpeechSynthesis.SpeechSynthesisStream, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]
                $speechTask = $asTask.MakeGenericMethod($speechStreamType).Invoke($null, @($asyncSpeech))
                $speechTask.Wait()
                $runtimeStream = $speechTask.Result
                $inputStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($runtimeStream)
                $outputStream = [IO.File]::Create((Join-Path $fixtureDir "$($sample.lang).wav"))
                try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
                Write-Output "Created synthetic fixture with local Windows voice: $($sample.lang)"
            } finally { $runtimeSynth.Dispose() }
            continue
        }
        $synth.SelectVoice($voice.Name)
        $synth.Rate = -1
        $synth.SetOutputToWaveFile((Join-Path $fixtureDir "$($sample.lang).wav"))
        $synth.Speak($sample.text)
        $synth.SetOutputToNull()
        Write-Output "Created synthetic fixture: $($sample.lang)"
    }
} finally { $synth.Dispose() }
