param(
    [string]$DataDir = (Join-Path $env:APPDATA 'midnight\missions'),
    [string]$PythonPath = ''
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js is required to run this repository setup script. In the installed app, use Settings > Local search > Set up local search.' }
$env:MIDNIGHT_SEARCH_SETUP_DATA = [IO.Path]::GetFullPath($DataDir)
$env:MIDNIGHT_SEARCH_SETUP_PYTHON = $PythonPath
$env:MIDNIGHT_SEARCH_SETUP_ROOT = $projectRoot
$setupScript = Join-Path ([IO.Path]::GetTempPath()) ('midnight-search-setup-' + [Guid]::NewGuid().ToString('N') + '.mjs')
$setupSource = @'
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const { createEmbeddingRuntime } = await import(pathToFileURL(path.join(process.env.MIDNIGHT_SEARCH_SETUP_ROOT, 'src', 'search', 'runtime.mjs')).href);
const runtime = createEmbeddingRuntime({ settings: () => ({ embedding: { pythonPath: process.env.MIDNIGHT_SEARCH_SETUP_PYTHON || undefined } }), paths: { dataDir: process.env.MIDNIGHT_SEARCH_SETUP_DATA } });
try { console.log(await runtime.setup({ onProgress: p => console.log(p.detail ?? p.message) })); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { runtime.close(); }
'@
Set-Content -LiteralPath $setupScript -Value $setupSource -Encoding UTF8
Push-Location $projectRoot
try {
    # Passing configuration through the environment preserves spaces and avoids shell interpolation.
    & $node.Source $setupScript
    if ($LASTEXITCODE -ne 0) { throw 'Local search setup failed. See the error above; install 64-bit Python 3.10–3.13 if it is missing.' }
} finally {
    Pop-Location
    Remove-Item -LiteralPath $setupScript -ErrorAction SilentlyContinue
    Remove-Item Env:MIDNIGHT_SEARCH_SETUP_DATA -ErrorAction SilentlyContinue
    Remove-Item Env:MIDNIGHT_SEARCH_SETUP_PYTHON -ErrorAction SilentlyContinue
    Remove-Item Env:MIDNIGHT_SEARCH_SETUP_ROOT -ErrorAction SilentlyContinue
}
