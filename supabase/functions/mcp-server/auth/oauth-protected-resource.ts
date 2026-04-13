import { Hono } from "hono";

import type { AuthAppVariables, ProtectedResourceMetadata } from "./types.ts";

export function createOAuthProtectedResourceApp(baseUrl: string) {
  const router = new Hono<{ Variables: AuthAppVariables }>();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");

  const metadata: ProtectedResourceMetadata = {
    resource: `${baseUrl}/mcp`,
    authorization_servers: supabaseUrl ? [`${supabaseUrl}/auth/v1`] : [],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "email", "profile", "phone"],
    resource_name: "MiseEnPlace MCP Server",
    resource_documentation: baseUrl,
  };

  router.get("/", (c) => c.json(metadata));

  return router;
}
