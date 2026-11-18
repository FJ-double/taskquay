/** Best-effort prompt recognition. A process exit is never inferred from output. */
export function detectTerminalPrompt(output: string): string | undefined {
  const tail = output.slice(-4096).replace(/\r/g, "");
  const line = tail.slice(tail.lastIndexOf("\n") + 1);
  if (!line) return undefined;
  // Generic > prompts must occupy the entire final line to avoid matching ordinary text.
  if (/^(?:>>> |\.\.\. |> |\+ |\| )+$/.test(line)) return line.trim();
  if (/^(?:mysql>|redis>|julia>|sqlite>|ftp>)\s*$/.test(line)) return line.trim();
  if (/^PS [^\n<>|]*[\\/:][^\n<>|]*> ?$/.test(line)) return "PowerShell";
  if (/^[A-Za-z]:\\[^<>|"?*\n]*> ?$/.test(line)) return "cmd";
  if (/^(?:[^\s@]+@[^\s:]+:[^\n]*|[\w./~-]+)[#$%] $/.test(line)) return "shell";
  return undefined;
}
