# Development fallback only: the app runs native\midnight-hotkey.exe (built by scripts/build-native.mjs). This loads
# the same C# source when that exe has not been built. Only emits READY / TRIGGER; no key contents leave the hook.
param([int]$ParentPid = 0, [switch]$SelfTest)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -Path (Join-Path $PSScriptRoot 'native\MidnightHotkey.cs')
if ($SelfTest) { [MidnightHotkey]::Test() } else { [MidnightHotkey]::Run($ParentPid) }
