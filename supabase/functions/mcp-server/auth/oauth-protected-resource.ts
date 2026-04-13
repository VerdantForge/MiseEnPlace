import { Hono } from "hono";

import type { AuthAppVariables } from "./jwt-middleware.ts";

type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: ["header"];
  scopes_supported: string[];
  resource_name: string;
  resource_documentation?: string;
};

export function createOAuthProtectedResourceApp(baseUrl: string) {
  const router = new Hono<{ Variables: AuthAppVariables }>();
  const authServerUrl = Deno.env.get("MCP_AUTH_SERVER_URL") ?? "http://127.0.0.1:54321/auth/v1";

  const metadata: ProtectedResourceMetadata = {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [authServerUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "email", "profile", "phone"],
    resource_name: "MiseEnPlace MCP Server",
    resource_documentation: baseUrl,
  };

  router.get("/", (c) => c.json(metadata));

  return router;
}
