param(
  [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Taskquay\windows-1.1.1'),
  [string]$ConfigDirectory = (Join-Path $env:USERPROFILE '.devspace'),
  [switch]$AutoStart,
  [switch]$Start
)
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Taskquay requires Windows x64.' }
$Source = $PSScriptRoot
$Destination = [IO.Path]::GetFullPath($Destination)
if ($Source -ne $Destination) {
  if (Test-Path $Destination) { throw "Destination already exists: $Destination. Choose a new candidate directory." }
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $Source 'app') -Destination $Destination -Recurse
  Copy-Item -LiteralPath (Join-Path $Source 'runtime') -Destination $Destination -Recurse
  Copy-Item -LiteralPath (Join-Path $Source 'taskquay.cmd') -Destination $Destination
  Copy-Item -LiteralPath (Join-Path $Source 'uninstall-windows.ps1') -Destination $Destination
}
$Launcher = Join-Path $Destination 'start-taskquay.vbs'
$Node = Join-Path $Destination 'runtime\node.exe'
$Cli = Join-Path $Destination 'app\dist\cli.js'
$LaunchText = @"
Set shell = CreateObject("WScript.Shell")
shell.Environment("PROCESS")("DEVSPACE_CONFIG_DIR") = "$($ConfigDirectory.Replace('"','""'))"
shell.Run """$Node"" ""$Cli"" serve", 0, False
"@
Set-Content -LiteralPath $Launcher -Value $LaunchText -Encoding Unicode
if ($AutoStart) {
  $ShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Taskquay Windows.lnk'
  if (Test-Path $ShortcutPath) { throw "Autostart entry already exists: $ShortcutPath" }
  $Shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($ShortcutPath)
  $Shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $Shortcut.Arguments = '"' + $Launcher + '"'
  $Shortcut.WorkingDirectory = $Destination
  $Shortcut.Save()
}
if ($Start) { Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $Launcher + '"') }
Write-Output "Installed Taskquay Windows x64: $Destination"
Write-Output "Config: $ConfigDirectory. Default MCP endpoint: http://127.0.0.1:7676/mcp"
Write-Output "Initialize once with: $Destination\taskquay.cmd init"
