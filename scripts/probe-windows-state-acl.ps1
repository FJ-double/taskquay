# Read-only inspection of explicitly selected disposable test directories.
# Does not grant, deny, change ownership, or authenticate a second account.
param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference='Stop'
$resolved=(Resolve-Path -LiteralPath $Directory).Path
$temp=(Resolve-Path -LiteralPath $env:TEMP).Path
$prefix=$temp.TrimEnd('\')+'\'
if (-not $resolved.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) {
  throw "STATE_ACL_PROBE_TEMP_ONLY"
}
$acl=Get-Acl -LiteralPath $resolved
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$operatorReview=$false
foreach($ace in $acl.Access) {
  if($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){continue}
  $sid=''
  try{$sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}
  catch{$operatorReview=$true;continue}
  if($sid -eq $current -or $sid -eq 'S-1-5-18' -or $sid -eq 'S-1-5-32-544'){continue}
  # Conservatively treat any other Allow ACE as unverified. This is not
  # an effective-access check; do not auto-enable production on "clean".
  $operatorReview=$true
  Write-Output ("STATE_ACL_FOREIGN_ALLOW_SID="+$sid)
}
Write-Output ("STATE_ACL_OWNER="+$acl.Owner)
Write-Output ("STATE_ACL_INHERITANCE_PROTECTED="+$acl.AreAccessRulesProtected)
Write-Output ("STATE_ACL_OTHER_ALLOW_REQUIRES_REVIEW="+$operatorReview)
Write-Output "STATE_ACL_EFFECTIVE_CROSS_ACCOUNT_ACCESS_NOT_VERIFIED"
