import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { filterMcpToolRegistrations, type McpRegistrationTarget } from "./mcp-modern-server.js";
import { STATIC_TOKEN_PREFIX, type StaticTokenStore } from "./static-token-store.js";

export function createMcpTokenVerifier(
  oauth: { verifyAccessToken(token: string): Promise<AuthInfo> },
  store: StaticTokenStore | undefined,
  resource: URL,
  scope: string,
): { verifyAccessToken(token: string): Promise<AuthInfo> } {
  return {
    async verifyAccessToken(token) {
      if (!token.startsWith(STATIC_TOKEN_PREFIX)) return oauth.verifyAccessToken(token);
      const record = store?.verify(token);
      if (!record) throw new InvalidTokenError("Invalid or revoked static token");
      return {
        token,
        clientId: `static:${record.id}`,
        scopes: [scope],
        resource,
        // The existing SDK middleware requires a numeric expiry. Static tokens
        // have no TTL: their validity comes from the store on every request.
        expiresAt: Number.MAX_SAFE_INTEGER,
        extra: { staticTokenId: record.id, allowedTools: record.allowedTools },
      };
    },
  };
}

export function staticTokenAllowedTools(auth: { extra?: Record<string, unknown> } | undefined): string[] | undefined {
  if (typeof auth?.extra?.staticTokenId !== "string") return undefined;
  const tools = auth.extra.allowedTools;
  return Array.isArray(tools) ? tools.filter((tool): tool is string => typeof tool === "string") : [];
}

export function restrictMcpTools(target: McpRegistrationTarget, allowedTools: readonly string[]): McpRegistrationTarget {
  const allowed = new Set(allowedTools);
  return filterMcpToolRegistrations(target, name => allowed.has(name));
}
