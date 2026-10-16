/** Optional test-only loopback transport diagnostics.
 * Capture sanitized socket failure codes without logging URLs or request
 * bodies, and NEVER retry a request that may have changed remote state.
 */
const originalFetch = globalThis.fetch;
const safeCode = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9_]{1,48}$/.test(value) ? value : "unavailable";
function errorCodes(value: unknown): Array<Record<string, unknown>> {
  if (value === null || typeof value !== "object") return [];
  const err = value as { name?: unknown; code?: unknown; errno?: unknown;
    syscall?: unknown; cause?: unknown; errors?: unknown };
  const entry: Record<string, unknown> = {
    name: safeCode(err.name), code: safeCode(err.code), syscall: safeCode(err.syscall),
  };
  if (typeof err.errno === "number" && Number.isSafeInteger(err.errno)) entry.errno = err.errno;
  if (err.cause && err.cause !== value) return [entry, ...errorCodes(err.cause).slice(0, 2)];
  if (Array.isArray(err.errors)) {
    return [entry, ...err.errors.slice(0, 2).flatMap((child) => errorCodes(child).slice(0, 1))];
  }
  return [entry];
}
globalThis.fetch = async (input, init) => {
  try { return await originalFetch(input, init); }
  catch (error) {
    const url = typeof input === "string" ? input
      : input instanceof URL ? input.href : input.url;
    let loopback = false;
    try { loopback = ["127.0.0.1", "[::1]", "localhost"].includes(new URL(url).hostname); }
    catch { /* Never reveal URL components. */ }
    if (loopback) process.stderr.write("[LOCAL_HTTP_FETCH_ERROR] " +
      JSON.stringify({ socketErrors: errorCodes(error).slice(0, 3) }) + "\n");
    throw error;
  }
};
