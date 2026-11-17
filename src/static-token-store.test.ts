import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMcpTokenVerifier } from "./static-token-auth.js";
import { STATIC_TOKEN_PREFIX, StaticTokenStore, staticTokenDatabasePath } from "./static-token-store.js";

test("static credentials persist only hashes, require exact tool grants and revoke independently", () => {
  const root = mkdtempSync(join(tmpdir(), "taskquay-static-store-"));
  let store = new StaticTokenStore(root);
  try {
    for (const allowedTools of [[], ["*"], ["read", ""], ["exec_*"]]) {
      assert.throws(() => store.create({ name: "invalid", allowedTools }));
    }
    assert.throws(() => store.create({ name: " ", allowedTools: ["read"] }));
    assert.equal(store.list().length, 0);
    const first = store.create({ name: "xiaomi-fixture", allowedTools: ["read", "read"] });
    const other = store.create({ name: "other-fixture", allowedTools: ["open_workspace"] });
    assert.equal(Buffer.from(first.token.slice(STATIC_TOKEN_PREFIX.length), "base64url").length, 32);
    assert.notEqual(first.token, other.token);
    assert.deepEqual(first.allowedTools, ["read"]);
    assert.deepEqual(store.list().map((entry) => entry.id).sort(), [first.id, other.id].sort());
    assert(!JSON.stringify(store.list()).includes(first.token));
    assert(!JSON.stringify(store.list()).includes("token_hash"));
    if (process.platform !== "win32") {
      assert.equal(statSync(root).mode & 0o777, 0o700);
      assert.equal(statSync(staticTokenDatabasePath(root)).mode & 0o777, 0o600);
    }
    for (const file of readdirSync(root)) {
      const bytes = readFileSync(join(root, file));
      assert(!bytes.includes(Buffer.from(first.token)));
      assert(!bytes.includes(Buffer.from(other.token)));
    }
    store.close();
    store = new StaticTokenStore(root);
    assert.equal(store.verify(first.token)?.id, first.id);
    assert.equal(store.verify(`${first.token}wrong`), undefined);
    const manager = new StaticTokenStore(root);
    try {
      assert.equal(manager.revoke(first.id), true);
      assert.equal(store.verify(first.token), undefined);
      assert.equal(store.verify(other.token)?.id, other.id);
      assert.equal(manager.revoke(first.id), false);
      assert.equal(manager.revoke("missing"), false);
    } finally { manager.close(); }
    assert.equal(store.list().find((entry) => entry.id === first.id)?.revokedAt !== null, true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("static verification preserves OAuth and establishes identity/resource without the OAuth TTL", async () => {
  const root = mkdtempSync(join(tmpdir(), "taskquay-static-verifier-"));
  const store = new StaticTokenStore(root);
  try {
    const issued = store.create({ name: "fixture", allowedTools: ["read"] });
    const resource = new URL("https://example.com/mcp");
    let oauthCalls = 0;
    const oauth = { async verifyAccessToken(token: string) {
      oauthCalls++;
      return { token, clientId: "oauth-fixture", scopes: ["devspace"], expiresAt: 1, resource };
    } };
    const verifier = createMcpTokenVerifier(oauth, store, resource, "custom-scope");
    const auth = await verifier.verifyAccessToken(issued.token);
    assert.equal(auth.clientId, `static:${issued.id}`);
    assert.equal(auth.resource?.href, resource.href);
    assert.deepEqual(auth.scopes, ["custom-scope"]);
    assert.deepEqual(auth.extra?.allowedTools, ["read"]);
    assert(auth.expiresAt! > Date.now() / 1000 + 3600 * 24 * 365);
    assert.equal(oauthCalls, 0);
    assert.equal((await verifier.verifyAccessToken("oauth-fixture-token")).clientId, "oauth-fixture");
    assert.equal(oauthCalls, 1);
    await assert.rejects(createMcpTokenVerifier(oauth, undefined, resource, "devspace").verifyAccessToken(issued.token), /Invalid or revoked/);
    store.revoke(issued.id);
    await assert.rejects(verifier.verifyAccessToken(issued.token), /Invalid or revoked/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
