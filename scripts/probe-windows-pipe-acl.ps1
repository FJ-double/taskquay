# Isolated read-only inspection of Windows default named-pipe permissions.
# Creates one disposable .NET named pipe; changes no user or production ACL.
param([string]$ExistingPipeName = '')
$ErrorActionPreference = 'Stop'
$definition = @'
using System;
using System.Runtime.InteropServices;
public static class TaskquayAclInspection {
  [DllImport("advapi32.dll", EntryPoint="GetSecurityInfo")]
  public static extern uint HandleSecurity(IntPtr handle, uint type, uint fields,
    out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);
  [DllImport("advapi32.dll", EntryPoint="ConvertSecurityDescriptorToStringSecurityDescriptorW", CharSet=CharSet.Unicode)]
  [return:MarshalAs(UnmanagedType.Bool)]
  public static extern bool ToSddl(IntPtr sd,uint revision,uint fields,out IntPtr text,out uint length);
  [DllImport("kernel32.dll")]
  public static extern IntPtr LocalFree(IntPtr ptr);
  [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)]
  public static extern IntPtr CreatePipeClient(string name,uint access,uint share,
    IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll")]
  [return:MarshalAs(UnmanagedType.Bool)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
Add-Type -TypeDefinition $definition
$pipe = $null
$handle = [IntPtr]::Zero
if ($ExistingPipeName) {
  if (-not $ExistingPipeName.StartsWith('\\.\pipe\taskquay-experimental-service-')) {
    throw 'READ_ONLY_PROBE_RESTRICTED_TO_EXPERIMENTAL_PIPE'
  }
  $handle = [TaskquayAclInspection]::CreatePipeClient(
    $ExistingPipeName,0x20000,3,[IntPtr]::Zero,3,0,[IntPtr]::Zero)
  if ($handle -eq [IntPtr]::new(-1)) {
    throw "PIPE_READ_CONTROL_OPEN_FAILED"
  }
} else {
  $name = "taskquay-acl-probe-$([Guid]::NewGuid().ToString('N'))"
  $pipe = [System.IO.Pipes.NamedPipeServerStream]::new(
    $name, [System.IO.Pipes.PipeDirection]::InOut, 1,
    [System.IO.Pipes.PipeTransmissionMode]::Byte,
    [System.IO.Pipes.PipeOptions]::Asynchronous
  )
  $handle = $pipe.SafePipeHandle.DangerousGetHandle()
}
try {
  $owner=[IntPtr]::Zero;$group=[IntPtr]::Zero;$dacl=[IntPtr]::Zero
  $sacl=[IntPtr]::Zero;$sd=[IntPtr]::Zero
  $code = [TaskquayAclInspection]::HandleSecurity($handle,6,4,
    [ref]$owner,[ref]$group,[ref]$dacl,[ref]$sacl,[ref]$sd)
  if ($code -ne 0) {
    Write-Output "PIPE_ACL_QUERY_FAILED code=$code"
    exit 3
  }
  try {
    $txt=[IntPtr]::Zero;$len=0
    if (-not [TaskquayAclInspection]::ToSddl($sd,1,4,[ref]$txt,[ref]$len)) {
      Write-Output "PIPE_ACL_SDDL_CONVERSION_FAILED"
      exit 4
    }
    try {
      Write-Output ("PIPE_ACL_SDDL="+[Runtime.InteropServices.Marshal]::PtrToStringUni($txt))
    } finally { [void][TaskquayAclInspection]::LocalFree($txt) }
  } finally { [void][TaskquayAclInspection]::LocalFree($sd) }
} finally {
  if ($pipe) { $pipe.Dispose() }
  else { [void][TaskquayAclInspection]::CloseHandle($handle) }
}
