# Test-only Windows named-pipe transport for ManagedServiceLocalControl.
# A native PipeSecurity descriptor is applied AT CREATION (no public-DACL window).
# The Node owner authenticates and authorizes requests; this process never
# receives the control token outside the client's own message.
param([Parameter(Mandatory=$true)][string]$PipeName)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $PipeName -notmatch '^taskquay-experimental-service-[a-f0-9]{32}$') {
  throw 'CONTROL_BROKER_INVALID_PIPE_NAME'
}
if ([Console]::In.ReadLine() -cne 'GO') { throw 'CONTROL_BROKER_NOT_ARMED' }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
public static class TaskquayControlBoundedRead {
  public static string Line(Stream pipe, int maxBytes, int timeoutMs) {
    using var cancel = new CancellationTokenSource(timeoutMs);
    var bytes = new List<byte>();
    var buffer = new byte[1];
    while (true) {
      int read = pipe.ReadAsync(buffer.AsMemory(), cancel.Token).AsTask()
        .GetAwaiter().GetResult();
      if (read == 0) throw new EndOfStreamException("CONTROL_CLIENT_DISCONNECTED");
      if (buffer[0] == 10) return new UTF8Encoding(false, true).GetString(bytes.ToArray());
      if (bytes.Count >= maxBytes) throw new InvalidDataException("CONTROL_MESSAGE_TOO_LARGE");
      bytes.Add(buffer[0]);
    }
  }
}
'@

$acl = [System.IO.Pipes.PipeSecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$type = [System.Security.AccessControl.AccessControlType]::Allow
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($principal in @(
  $sid,
  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
)) {
  $acl.AddAccessRule([System.IO.Pipes.PipeAccessRule]::new(
    $principal, [System.IO.Pipes.PipeAccessRights]::FullControl, $type))
}

function New-RestrictedPipe {
  return [System.IO.Pipes.NamedPipeServerStreamAcl]::Create(
    $PipeName, [System.IO.Pipes.PipeDirection]::InOut, 2,
    [System.IO.Pipes.PipeTransmissionMode]::Byte,
    [System.IO.Pipes.PipeOptions]::Asynchronous, 4096, 4096, $acl)
}
$pipe = New-RestrictedPipe
try {
  [Console]::Out.WriteLine('{"event":"READY"}')
  [Console]::Out.Flush()
  $sequence = 0
  $waitRecoveries = 0
  while ($true) {
    try {
      $pipe.WaitForConnection()
      $waitRecoveries = 0
    } catch {
      # Windows can invalidate an asynchronous pipe instance after a
      # disconnected client's cancellation. Recreate ONLY with the same
      # restrictive DACL in CreateNamedPipe, never as a Node default pipe.
      $cause = $_.Exception.InnerException
      if ($cause -isnot [System.IO.IOException] -and
          $cause -isnot [System.ObjectDisposedException]) { throw }
      $waitRecoveries++
      if ($waitRecoveries -gt 3) { throw 'CONTROL_BROKER_NATIVE_PIPE_UNSTABLE' }
      try { $pipe.Dispose() } catch {}
      $pipe = New-RestrictedPipe
      [Console]::Out.WriteLine('{"event":"PIPE_RECOVERED"}')
      [Console]::Out.Flush()
      continue
    }
    # Keep another restricted native instance alive before disposing the
    # one whose client may abruptly close. This preserves the pipe name's
    # secure owner without a name-unbound window between requests.
    $nextPipe = New-RestrictedPipe
    $writer = $null
    try {
      $writer = [System.IO.StreamWriter]::new($pipe,
        [System.Text.UTF8Encoding]::new($false), 256, $true)
      $writer.AutoFlush = $true
      $message = [TaskquayControlBoundedRead]::Line($pipe, 2048, 3000)
      $sequence++
      $raw = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($message))
      [Console]::Out.WriteLine((@{event='REQUEST';id=$sequence;raw=$raw} |
        ConvertTo-Json -Compress))
      [Console]::Out.Flush()
      $response = [Console]::In.ReadLine()
      if ($null -eq $response) { break }
      $parsed = $response | ConvertFrom-Json
      if ($parsed.event -cne 'RESPONSE' -or $parsed.id -ne $sequence -or
          $parsed.body -isnot [string] -or $parsed.body.Length -gt 4096) {
        throw 'CONTROL_BROKER_BAD_PARENT_RESPONSE'
      }
      $writer.WriteLine($parsed.body)
      # Windows DisconnectNamedPipe can turn a successful buffered write
      # into EPIPE at the peer. Wait until the client has drained the bytes.
      $pipe.WaitForPipeDrain()
      [Console]::Out.WriteLine((@{event='ACK';id=$sequence} | ConvertTo-Json -Compress))
      [Console]::Out.Flush()
    } catch {
      # A malformed or slow client cannot stop the Job. Do not log tokens.
    } finally {
      # StreamWriter.Dispose flushes. A client that closed before replying
      # makes that flush throw "Pipe is broken"; never crash the broker.
      if ($writer) { try { $writer.Dispose() } catch {} }
      try { $pipe.Dispose() } catch {}
      $pipe = $nextPipe
    }
  }
} catch {
  # No client bytes or capabilities in the diagnostic; only exception type.
  [Console]::Error.WriteLine('CONTROL_BROKER_FATAL_EXCEPTION_TYPE=' + $_.Exception.GetType().Name)
  throw
} finally {
  $pipe.Dispose()
}
