param([switch]$RemoveFiles)
$ErrorActionPreference = 'Stop'
$ShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Taskquay Windows.lnk'
if (Test-Path $ShortcutPath) {
  $Shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($ShortcutPath)
  if ($Shortcut.Arguments -like ('*' + $PSScriptRoot + '*')) { Remove-Item -LiteralPath $ShortcutPath }
}
if ($RemoveFiles) { Remove-Item -LiteralPath $PSScriptRoot -Recurse -Force }
Write-Output 'Removed this candidate installation/autostart entry. User configuration and data are preserved.'
