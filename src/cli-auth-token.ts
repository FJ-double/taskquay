import { loadConfig } from "./config.js";
import { StaticTokenStore } from "./static-token-store.js";

const usage = "Usage: devspace auth token create --name <name> --allowed-tools <tool,...> | list | revoke <token-id>";

export function runAuthTokenCommand(args: string[]): void {
  const [kind, action, ...options] = args;
  if (kind !== "token") throw new Error(usage);
  let input: { name: string; allowedTools: string[] } | undefined;
  if (action === "create") {
    const values = new Map<string, string>();
    for (let index = 0; index < options.length; index += 2) {
      const key = options[index]!;
      const value = options[index + 1];
      if (!["--name", "--allowed-tools"].includes(key) || values.has(key) || !value || value.startsWith("--")) {
        throw new Error(usage);
      }
      values.set(key, value);
    }
    if (!values.has("--name") || !values.has("--allowed-tools")) throw new Error(usage);
    input = { name: values.get("--name")!, allowedTools: values.get("--allowed-tools")!.split(",").map((tool) => tool.trim()) };
  } else if (action === "list") {
    if (options.length) throw new Error(usage);
  } else if (action === "revoke") {
    if (options.length !== 1 || !options[0]) throw new Error(usage);
  } else {
    throw new Error(usage);
  }

  const store = new StaticTokenStore(loadConfig().stateDir);
  try {
    if (input) {
      // The only plaintext presentation. Never send this output to a logger.
      console.log(JSON.stringify(store.create(input), null, 2));
    } else if (action === "list") {
      console.log(JSON.stringify(store.list(), null, 2));
    } else {
      if (!store.revoke(options[0]!)) throw new Error("Token not found or already revoked.");
      console.log("Token revoked.");
    }
  } finally {
    store.close();
  }
}
