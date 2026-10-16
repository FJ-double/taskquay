# Verify a native restricted-token access check against a disposable or
# explicitly named experimental Taskquay pipe. No new accounts/passwords.
param([string]$ExistingPipeName = '')
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'RESTRICTED_TOKEN_WINDOWS_ONLY' }
if ($ExistingPipeName -and
    $ExistingPipeName -cnotmatch '^\\\\\.\\pipe\\taskquay-experimental-service-[a-f0-9]{32}$') {
  throw 'RESTRICTED_TOKEN_PROBE_ONLY_TEST_PIPE'
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class TaskquayRestrictedTokenProbe {
  [StructLayout(LayoutKind.Sequential)]
  struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
  const uint QUERY=0x0008, DUPLICATE=0x0002, IMPERSONATE=0x0004;
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr value);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool OpenProcessToken(IntPtr process,uint rights,out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool CreateRestrictedToken(IntPtr token,uint flags,
    uint disableSidCount,IntPtr disableSids,uint deletePrivilegeCount,IntPtr deletePrivileges,
    uint restrictSidCount,IntPtr restrictSids,out IntPtr newToken);
  [DllImport("advapi32.dll", EntryPoint="ConvertStringSidToSidW",
    CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool ConvertStringSidToSid(string sddl,out IntPtr sid);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool ImpersonateLoggedOnUser(IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool RevertToSelf();
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool IsTokenRestricted(IntPtr token);
  [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFile(string path,uint desired,uint share,IntPtr security,
    uint disposition,uint flags,IntPtr template);

  static int Open(string path) {
    var handle=CreateFile(path,0xC0000000,0,IntPtr.Zero,3,0,IntPtr.Zero);
    if (handle == new IntPtr(-1)) return Marshal.GetLastWin32Error();
    CloseHandle(handle);
    return 0;
  }
  public static int[] Check(string path, bool checkOriginal) {
    IntPtr original=IntPtr.Zero, derived=IntPtr.Zero, sid=IntPtr.Zero, sids=IntPtr.Zero;
    int current=checkOriginal ? Open(path) : -1;
    try {
      if (!OpenProcessToken(GetCurrentProcess(),QUERY|DUPLICATE|IMPERSONATE,out original))
        throw new InvalidOperationException("OPEN_TOKEN",new Win32Exception(Marshal.GetLastWin32Error()));
      // Built-in Guests is intentionally not allowed by the target ACL.
      if (!ConvertStringSidToSid("S-1-5-32-546",out sid))
        throw new InvalidOperationException("SID_CONVERSION",new Win32Exception(Marshal.GetLastWin32Error()));
      sids=Marshal.AllocHGlobal(Marshal.SizeOf<SidAndAttributes>());
      Marshal.StructureToPtr(new SidAndAttributes {Sid=sid,Attributes=0},sids,false);
      if (!CreateRestrictedToken(original,1,0,IntPtr.Zero,0,IntPtr.Zero,1,sids,out derived))
        throw new InvalidOperationException("CREATE_RESTRICTED_TOKEN",new Win32Exception(Marshal.GetLastWin32Error()));
      if (!IsTokenRestricted(derived)) throw new InvalidOperationException("TOKEN_NOT_RESTRICTED");
      if (!ImpersonateLoggedOnUser(derived))
        throw new InvalidOperationException("RESTRICTED_IMPERSONATION",new Win32Exception(Marshal.GetLastWin32Error()));
      try { return new [] {current,Open(path)}; }
      finally {
        if (!RevertToSelf()) throw new InvalidOperationException("REVERT_FAILED",
          new Win32Exception(Marshal.GetLastWin32Error()));
      }
    } finally {
      if (derived!=IntPtr.Zero) CloseHandle(derived);
      if (sids!=IntPtr.Zero) Marshal.FreeHGlobal(sids);
      if (sid!=IntPtr.Zero) LocalFree(sid);
      if (original!=IntPtr.Zero) CloseHandle(original);
    }
  }
}
'@

$pipe=$null
try {
  if ($ExistingPipeName) { $path=$ExistingPipeName }
  else {
    $name='taskquay-restricted-token-test-'+[Guid]::NewGuid().ToString('N')
    $security=[System.IO.Pipes.PipeSecurity]::new()
    $security.SetAccessRuleProtection($true,$false)
    $allow=[System.Security.AccessControl.AccessControlType]::Allow
    foreach($sid in @(
      [System.Security.Principal.WindowsIdentity]::GetCurrent().User,
      [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
      [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
      $security.AddAccessRule([System.IO.Pipes.PipeAccessRule]::new(
        $sid,[System.IO.Pipes.PipeAccessRights]::FullControl,$allow))
    }
    $pipe=[System.IO.Pipes.NamedPipeServerStreamAcl]::Create(
      $name,[System.IO.Pipes.PipeDirection]::InOut,1,
      [System.IO.Pipes.PipeTransmissionMode]::Byte,
      [System.IO.Pipes.PipeOptions]::Asynchronous,0,0,$security)
    $path='\\.\pipe\'+$name
  }
  $outcomes=[TaskquayRestrictedTokenProbe]::Check($path, -not [bool]$ExistingPipeName)
  if(-not $ExistingPipeName -and $outcomes[0] -ne 0) {
    throw "ORIGINAL_USER_DENIED code=$($outcomes[0])"
  }
  if($outcomes[1] -ne 5) { throw "RESTRICTED_TOKEN_NOT_DENIED code=$($outcomes[1])" }
  Write-Output 'WINDOWS_NATIVE_RESTRICTED_TOKEN_ACL_OK'
  if (-not $ExistingPipeName) { Write-Output 'originalIdentityOpen=0' }
  Write-Output 'restrictedIdentityOpen=5'
} finally { if($pipe) { $pipe.Dispose() } }
