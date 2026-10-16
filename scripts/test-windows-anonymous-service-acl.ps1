# Disposable native Windows ACL proof. Never targets production service paths.
# Requires PowerShell 7 on Windows. Does not create users or install services.
[CmdletBinding()]
param([string]$ExistingPipeName = '')
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'ACL_TEST_WINDOWS_ONLY' }

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class TaskquayRestrictedAclProbe {
  const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;

  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentThread();
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool ImpersonateAnonymousToken(IntPtr thread);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool RevertToSelf();
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr ptr);
  [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr sec,
    uint disposition, uint flags, IntPtr template);
  [DllImport("advapi32.dll", EntryPoint="GetSecurityInfo")]
  static extern uint GetSecurityInfo(IntPtr handle,uint objectType,uint fields,
    out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr sd);
  [DllImport("advapi32.dll",EntryPoint="ConvertSecurityDescriptorToStringSecurityDescriptorW", CharSet=CharSet.Unicode)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool ToSddl(IntPtr sd,uint revision,uint fields,out IntPtr text,out uint length);

  static T AsAnonymous<T>(Func<T> action) {
    if (!ImpersonateAnonymousToken(GetCurrentThread()))
      throw new InvalidOperationException("ANONYMOUS_IMPERSONATION_UNAVAILABLE",
        new Win32Exception(Marshal.GetLastWin32Error()));
    try {
      return action();
    } finally {
      if (!RevertToSelf()) throw new InvalidOperationException("REVERT_IMPERSONATION_FAILED",
        new Win32Exception(Marshal.GetLastWin32Error()));
    }
  }

  public static int OpenPipeError(string path, bool anonymous) {
    Func<int> open = () => {
      IntPtr handle = CreateFile(path,GENERIC_READ|GENERIC_WRITE,0,IntPtr.Zero,3,0,IntPtr.Zero);
      if (handle == new IntPtr(-1)) return Marshal.GetLastWin32Error();
      CloseHandle(handle);
      return 0;
    };
    return anonymous ? AsAnonymous(open) : open();
  }

  public static bool CanReadFile(string path, bool anonymous) {
    Func<bool> open = () => {
      try { System.IO.File.ReadAllText(path); return true; }
      catch (UnauthorizedAccessException) { return false; }
      catch (System.IO.IOException) { return false; }
    };
    return anonymous ? AsAnonymous(open) : open();
  }

  public static string HandleSddl(IntPtr handle) {
    IntPtr owner,group,dacl,sacl,sd;
    var code=GetSecurityInfo(handle,6,4,out owner,out group,out dacl,out sacl,out sd);
    if (code!=0) throw new Win32Exception((int)code);
    try {
      IntPtr ptr; uint len;
      if (!ToSddl(sd,1,4,out ptr,out len)) throw new Win32Exception(Marshal.GetLastWin32Error());
      try { return Marshal.PtrToStringUni(ptr); }
      finally { LocalFree(ptr); }
    } finally { LocalFree(sd); }
  }
}
'@

if ($ExistingPipeName) {
  if ($ExistingPipeName -cnotmatch '^\\\\\.\\pipe\\taskquay-experimental-service-[a-f0-9]{32}$') {
    throw 'NATIVE_ACL_PROBE_RESTRICTED_TO_EXPERIMENTAL_PIPE'
  }
  $anonymous = [TaskquayRestrictedAclProbe]::OpenPipeError($ExistingPipeName,$true)
  if ($anonymous -ne 5) { throw "EXPERIMENTAL_PIPE_ANONYMOUS_ACCESS_NOT_DENIED code=$anonymous" }
  $authorized = [TaskquayRestrictedAclProbe]::OpenPipeError($ExistingPipeName,$false)
  if ($authorized -ne 0) { throw "EXPERIMENTAL_PIPE_AUTHORIZED_ACCESS_FAILED code=$authorized" }
  Write-Output 'EXPERIMENTAL_NATIVE_PIPE_ACL_OK'
  Write-Output 'anonymousTokenPipeError=5'
  Write-Output 'currentUserPipeAccess=True'
  return
}

$base = Join-Path ([System.IO.Path]::GetTempPath()) ('taskquay-acl-test-' + [Guid]::NewGuid().ToString('N'))
$state = Join-Path $base 'service-state'
$pipe = $null
try {
  [void][System.IO.Directory]::CreateDirectory($state)
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $admins = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $allow = [System.Security.AccessControl.AccessControlType]::Allow

  # Protected, non-inheriting DACL on a DISPOSABLE directory only.
  $acl = Get-Acl -LiteralPath $state
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($old in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($old) }
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  $propagate = [System.Security.AccessControl.PropagationFlags]::None
  foreach ($sid in @($user,$system,$admins)) {
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,[System.Security.AccessControl.FileSystemRights]::FullControl,$inherit,$propagate,$allow))
  }
  Set-Acl -LiteralPath $state -AclObject $acl
  $actualDir = Get-Acl -LiteralPath $state
  if (-not $actualDir.AreAccessRulesProtected) { throw 'DIRECTORY_INHERITANCE_NOT_DISABLED' }
  $file = Join-Path $state 'proof.txt'
  [System.IO.File]::WriteAllText($file, 'disposable proof')

  # Create the native kernel pipe WITH the explicit DACL, not by applying
  # permissions after Node's public-default CreateNamedPipe call.
  $pipeAcl = [System.IO.Pipes.PipeSecurity]::new()
  $pipeAcl.SetAccessRuleProtection($true,$false)
  foreach ($sid in @($user,$system,$admins)) {
    $pipeAcl.AddAccessRule([System.IO.Pipes.PipeAccessRule]::new(
      $sid,[System.IO.Pipes.PipeAccessRights]::FullControl,$allow))
  }
  $pipeName = 'taskquay-secure-acl-test-' + [Guid]::NewGuid().ToString('N')
  $pipe = [System.IO.Pipes.NamedPipeServerStreamAcl]::Create(
    $pipeName,[System.IO.Pipes.PipeDirection]::InOut,1,
    [System.IO.Pipes.PipeTransmissionMode]::Byte,
    [System.IO.Pipes.PipeOptions]::Asynchronous,0,0,$pipeAcl)
  $sddl = [TaskquayRestrictedAclProbe]::HandleSddl($pipe.SafePipeHandle.DangerousGetHandle())
  if ($sddl -match '\(A;;[^)]*;;;(?:WD|AN|AU|BU|IU|NU|S-1-1-0|S-1-5-7|S-1-5-11|S-1-5-32-545)\)') {
    throw 'PIPE_BROAD_ALLOW_ACE'
  }

  if ([TaskquayRestrictedAclProbe]::CanReadFile($file,$true)) {
    throw 'ANONYMOUS_TOKEN_READ_PRIVATE_DIRECTORY'
  }
  if (-not [TaskquayRestrictedAclProbe]::CanReadFile($file,$false)) {
    throw 'AUTHORISED_USER_CANNOT_READ_PRIVATE_DIRECTORY'
  }
  $path = '\\.\pipe\' + $pipeName
  $denied = [TaskquayRestrictedAclProbe]::OpenPipeError($path,$true)
  if ($denied -ne 5) { throw "ANONYMOUS_TOKEN_PIPE_NOT_DENIED code=$denied" }
  $allowed = [TaskquayRestrictedAclProbe]::OpenPipeError($path,$false)
  if ($allowed -ne 0) { throw "AUTHORISED_USER_PIPE_OPEN_FAILED code=$allowed" }
  Write-Output 'WINDOWS_NATIVE_ANONYMOUS_ACL_OK'
  Write-Output 'pipeDaclCreatedAtomically=True'
  Write-Output 'anonymousTokenPipeError=5'
  Write-Output 'anonymousTokenDirectoryRead=False'
  Write-Output 'currentUserPipeAndDirectoryAccess=True'
  Write-Output 'scope=disposable_only;cross_account_service_identity=not_verified'
} finally {
  if ($pipe) { $pipe.Dispose() }
  if (Test-Path -LiteralPath $base) {
    Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction Stop
  }
}
