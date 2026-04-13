// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

import { Hono } from "hono";
import { McpServer, StreamableHttpTransport } from "mcp-lite";
import { z } from "zod";

import { createAuthMiddleware } from "./auth/middleware.ts";
import { createAuthorizationUiRoutes, createProtectedResourceMetadataRoutes } from "./auth/routes.ts";
import type { AuthAppVariables } from "./auth/types.ts";

// We create two Hono instances:
// 1. `app` is the root handler for the Supabase Edge Function (must match the function name, e.g. /mcp-server)
// 2. `mcpApp` handles the MCP protocol and companion auth routes, mounted under the function route
// This pattern is required because Supabase Edge Functions route all requests to /<function-name>/*

const mcp = new McpServer({
  name: "starter-mcp-supabase-server",
  version: "1.0.0",
  schemaAdapter: (schema: unknown) => z.toJSONSchema(schema as z.ZodType),
});

mcp.tool("sum", {
  description: "Adds two numbers together",
  inputSchema: z.object({
    a: z.number(),
    b: z.number(),
  }),
  handler: (args: { a: number; b: number }) => ({
    content: [{ type: "text", text: String(args.a + args.b) }],
  }),
});

const transport = new StreamableHttpTransport();
const httpHandler = transport.bind(mcp);

const app = new Hono();
const mcpApp = new Hono<{ Variables: AuthAppVariables }>();

const baseUrl = Deno.env.get("MCP_SERVER_PUBLIC_URL") ?? "http://localhost:54321/functions/v1/mcp-server";

mcpApp.get("/", (c) => {
  return c.json({
    message: "MCP Server on Supabase Edge Functions",
    endpoints: {
      mcp: "/mcp",
      health: "/health",
      authMetadata: "/.well-known/oauth-protected-resource",
      authUi: "/auth/authorize",
    },
  });
});

mcpApp.get("/health", (c) => {
  return c.json({
    message: "Service is up and running",
  });
});

mcpApp.route("/.well-known/oauth-protected-resource", createProtectedResourceMetadataRoutes(baseUrl));
mcpApp.route("/auth", createAuthorizationUiRoutes(baseUrl));

mcpApp.use("/mcp", createAuthMiddleware({ metadataUrl: `${baseUrl}/.well-known/oauth-protected-resource` }));

mcpApp.all("/mcp", async (c) => {
  const response = await httpHandler(c.req.raw);
  return response;
});

// Mount the MCP app at /mcp-server (matches the function name)
app.route("/mcp-server", mcpApp);

export default app;

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/mcp-server/mcp' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","method":"tools/list","id":1}'

  3. Test the health endpoint:

  curl 'http://127.0.0.1:54321/functions/v1/mcp-server/health'

*/
