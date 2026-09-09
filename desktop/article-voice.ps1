param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$inputPath = Join-Path $Directory 'speech-input.json'
$speechInput = Get-Content -LiteralPath $inputPath -Raw -Encoding UTF8 | ConvertFrom-Json
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($speechInput.voice) { $speaker.SelectVoice([string]$speechInput.voice) }
  for ($index = 0; $index -lt $speechInput.segments.Count; $index++) {
    $speaker.SetOutputToWaveFile((Join-Path $Directory "$index.wav"))
    $speaker.Speak([string]$speechInput.segments[$index])
    $speaker.SetOutputToNull()
  }
} finally { $speaker.Dispose() }
