import assert from "node:assert/strict";
import test from "node:test";
import { WindowsJobObject } from "./windows-job-object.js";

test("failed native Job CloseHandle preserves ownership for an explicit retry", () => {
  // A fake Win32 handle is enough to verify the object-state transition.
  // No real OS Job is created or closed by this test.
  const job = Object.create(WindowsJobObject.prototype) as WindowsJobObject;
  let attempts = 0;
  const handle = { testHandle: true };
  const internals = job as unknown as {
    api: { close: (handle: unknown) => number; error: () => number };
    handle: unknown;
    closed: boolean;
  };
  internals.api = {
    close: (givenHandle) => {
      assert.equal(givenHandle, handle);
      return ++attempts === 1 ? 0 : 1;
    },
    error: () => 5,
  };
  internals.handle = handle;
  internals.closed = false;

  assert.throws(() => job.close(), /WINDOWS_JOB_CLOSE_FAILED: GetLastError=5/);
  assert.equal(internals.closed, false);
  assert.equal(internals.handle, handle);

  job.close();
  assert.equal(internals.closed, true);
  assert.equal(internals.handle, null);
  job.close();
  assert.equal(attempts, 2, "closing an already-closed Job must be idempotent");
});
