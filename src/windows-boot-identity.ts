import koffi from "koffi";

/**
 * Kernel-sourced Windows boot epoch evidence, not a random process UUID.
 *
 * SystemBootEnvironmentInformation (0x5A) contains the loader-supplied
 * BootIdentifier GUID; SystemTimeOfDayInformation (3) carries the NT FILETIME
 * BootTime. Combine both because a loader GUID ALONE is not proof of a new
 * boot on every Windows configuration.
 *
 * Both structures are native/partly undocumented. If either probe fails,
 * refuse automatic recovery; never substitute uptime or a generated UUID.
 */
export function windowsBootIdentity(): string {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("WINDOWS_BOOT_IDENTITY_UNSUPPORTED");
  }
  const dll = koffi.load("ntdll.dll");
  const query = dll.func("NtQuerySystemInformation", "int", ["int", "void *", "uint32", "void *"]);
  const boot = Buffer.alloc(32);
  const time = Buffer.alloc(48);
  const bootStatus = query(90, boot, boot.length, null) as number;
  const timeStatus = query(3, time, time.length, null) as number;
  if (bootStatus !== 0 || timeStatus !== 0) {
    throw new Error("WINDOWS_BOOT_IDENTITY_QUERY_FAILED");
  }
  const bytes = boot.subarray(0, 16);
  if (bytes.every((b) => b === 0)) throw new Error("WINDOWS_BOOT_IDENTITY_ZERO_GUID");
  const hex = (number: number, width: number) => number.toString(16).padStart(width, "0");
  const guid = [
    hex(boot.readUInt32LE(0), 8),
    hex(boot.readUInt16LE(4), 4),
    hex(boot.readUInt16LE(6), 4),
    boot.subarray(8, 10).toString("hex"),
    boot.subarray(10, 16).toString("hex"),
  ].join("-");
  const bootTicks = time.readBigUInt64LE(0);
  const filetimeUnixOffset = 116444736000000000n;
  if (bootTicks <= filetimeUnixOffset) throw new Error("WINDOWS_BOOT_IDENTITY_INVALID_TIME");
  const bootMs = Number((bootTicks - filetimeUnixOffset) / 10_000n);
  if (!Number.isSafeInteger(bootMs) || bootMs < Date.UTC(2010, 0, 1) ||
      bootMs > Date.now()) throw new Error("WINDOWS_BOOT_IDENTITY_IMPLAUSIBLE_TIME");
  // Full raw FILETIME precision avoids collapsing separate boots into one
  // timestamp when they happen in rapid succession.
  return `win-ntboot-v1:${guid}:${bootTicks.toString(16).padStart(16, "0")}`;
}
