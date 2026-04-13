// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

import { Hono } from "hono";
import { McpServer, StreamableHttpTransport } from "mcp-lite";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createAuthMiddleware } from "./auth/middleware.ts";
import { createAuthorizationUiRoutes, createProtectedResourceMetadataRoutes } from "./auth/routes.ts";
import type { AuthAppVariables } from "./auth/types.ts";

// Per-request Supabase client injected by the /mcp Hono handler after auth validation.
// AsyncLocalStorage ensures each concurrent request sees its own client.
const requestContext = new AsyncLocalStorage<{ supabase: SupabaseClient }>();

function getDb(): SupabaseClient {
  const ctx = requestContext.getStore();
  if (!ctx) throw new Error("No request context — tool called outside of an MCP request");
  return ctx.supabase;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Recipes tools — full CRUD + list, scoped to the authenticated user via RLS
// ---------------------------------------------------------------------------

mcp.tool("listRecipes", {
  description: "List all recipes belonging to the authenticated user",
  inputSchema: z.object({}),
  handler: async () => {
    const db = getDb();
    const { data, error } = await db
      .from("recipes")
      .select("id, title, created_at, updated_at")
      .order("created_at", { ascending: false });

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

mcp.tool("getRecipe", {
  description: "Get a single recipe by ID",
  inputSchema: z.object({
    id: z.string().uuid(),
  }),
  handler: async (args: { id: string }) => {
    const db = getDb();
    const { data, error } = await db
      .from("recipes")
      .select("*")
      .eq("id", args.id)
      .single();

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

mcp.tool("createRecipe", {
  description: "Create a new recipe for the authenticated user",
  inputSchema: z.object({
    title: z.string().min(1),
    content: z.string().min(1),
  }),
  handler: async (args: { title: string; content: string }) => {
    const db = getDb();
    const { data, error } = await db
      .from("recipes")
      .insert({ title: args.title, content: args.content })
      .select("id, title, created_at")
      .single();

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

mcp.tool("updateRecipe", {
  description: "Update the title and/or content of an existing recipe by ID",
  inputSchema: z.object({
    id: z.string().uuid(),
    title: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
  }),
  handler: async (args: { id: string; title?: string; content?: string }) => {
    const updates: Record<string, string> = {};
    if (args.title !== undefined) updates.title = args.title;
    if (args.content !== undefined) updates.content = args.content;
    if (Object.keys(updates).length === 0) {
      return { content: [{ type: "text", text: "Error: provide at least one field to update" }], isError: true };
    }

    const db = getDb();
    const { data, error } = await db
      .from("recipes")
      .update(updates)
      .eq("id", args.id)
      .select("id, title, updated_at")
      .single();

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

mcp.tool("deleteRecipe", {
  description: "Delete a recipe by ID",
  inputSchema: z.object({
    id: z.string().uuid(),
  }),
  handler: async (args: { id: string }) => {
    const db = getDb();
    const { error } = await db
      .from("recipes")
      .delete()
      .eq("id", args.id);

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: `Recipe ${args.id} deleted.` }] };
  },
});

const transport = new StreamableHttpTransport();
const httpHandler = transport.bind(mcp);

const app = new Hono();
const mcpApp = new Hono<{ Variables: AuthAppVariables }>();

const baseUrl = Deno.env.get("MCP_SERVER_PUBLIC_URL") ?? "http://localhost:54321/functions/v1/mcp-server";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

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
  // Build a user-scoped Supabase client from the already-validated Bearer token
  // so that RLS policies in Postgres run as the authenticated user.
  const authHeader = c.req.header("Authorization") ?? "";
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  return await requestContext.run({ supabase }, async () => {
    const response = await httpHandler(c.req.raw);
    return response;
  });
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
