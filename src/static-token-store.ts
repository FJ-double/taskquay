import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as z from "zod/v4";

export const STATIC_TOKEN_PREFIX = "tq_static_";

const tokenInputSchema = z.object({
  name: z.string().trim().min(1).max(128),
  // Exact tool names only. No implicit grants or wildcard permissions.
  allowedTools: z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)).min(1),
}).strict();

export interface StaticTokenMetadata {
  id: string;
  name: string;
  allowedTools: string[];
  createdAt: string;
  revokedAt: string | null;
}

interface TokenRow {
  id: string;
  name: string;
  allowed_tools: string;
  created_at: string;
  revoked_at: string | null;
}

export function staticTokenDatabasePath(stateDir: string): string {
  return join(stateDir, "static-tokens.sqlite");
}

export class StaticTokenStore {
  private readonly sqlite: Database.Database;

  constructor(stateDir: string) {
    // Match the existing state database's private-directory/file boundary.
    // A separate SQLite file leaves the old build's migration history readable.
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const path = staticTokenDatabasePath(stateDir);
    this.sqlite = new Database(path);
    chmodSync(path, 0o600);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("busy_timeout = 5000");
    this.sqlite.exec(`create table if not exists static_tokens (
      id text primary key,
      token_hash text not null unique,
      name text not null,
      allowed_tools text not null,
      created_at text not null,
      revoked_at text
    )`);
  }

  create(input: { name: string; allowedTools: string[] }): StaticTokenMetadata & { token: string } {
    const parsed = tokenInputSchema.parse(input);
    const metadata: StaticTokenMetadata = {
      id: randomUUID(),
      name: parsed.name,
      allowedTools: [...new Set(parsed.allowedTools)],
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    const token = STATIC_TOKEN_PREFIX + randomBytes(32).toString("base64url");
    this.sqlite.prepare(`insert into static_tokens
      (id, token_hash, name, allowed_tools, created_at) values (?, ?, ?, ?, ?)`)
      .run(metadata.id, hashToken(token), metadata.name, JSON.stringify(metadata.allowedTools), metadata.createdAt);
    return { ...metadata, token };
  }

  list(): StaticTokenMetadata[] {
    const rows = this.sqlite.prepare(
      "select id, name, allowed_tools, created_at, revoked_at from static_tokens order by created_at, id",
    ).all() as TokenRow[];
    return rows.map(metadataFromRow);
  }

  verify(token: string): StaticTokenMetadata | undefined {
    if (!token.startsWith(STATIC_TOKEN_PREFIX)) return undefined;
    // Query on every request so another process's revoke takes effect immediately.
    const row = this.sqlite.prepare(`select id, name, allowed_tools, created_at, revoked_at
      from static_tokens where token_hash = ? and revoked_at is null`).get(hashToken(token)) as TokenRow | undefined;
    return row ? metadataFromRow(row) : undefined;
  }

  revoke(id: string): boolean {
    return this.sqlite.prepare(
      "update static_tokens set revoked_at = ? where id = ? and revoked_at is null",
    ).run(new Date().toISOString(), id).changes > 0;
  }

  close(): void {
    this.sqlite.close();
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function metadataFromRow(row: TokenRow): StaticTokenMetadata {
  return {
    id: row.id,
    name: row.name,
    allowedTools: JSON.parse(row.allowed_tools) as string[],
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}
