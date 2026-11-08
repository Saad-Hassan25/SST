$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskSamRoot = if ($env:SAM_AUDIO_ROOT) { $env:SAM_AUDIO_ROOT } else { 'S:\Work\Sam Audio 3D' }
$taskPython = Join-Path $taskSamRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) { throw "SAM Audio Python environment not found at $taskPython. Set SAM_AUDIO_ROOT to your SAM Audio folder." }
if (-not $env:HF_HOME) { $env:HF_HOME = 'E:\huggingface' }
if (-not $env:HF_HUB_CACHE) { $env:HF_HUB_CACHE = Join-Path $env:HF_HOME 'hub' }
& $taskPython -X faulthandler -u scripts/studio.py
if ($LASTEXITCODE -ne 0) { throw "Prompter exited with code $LASTEXITCODE. See the output above." }
