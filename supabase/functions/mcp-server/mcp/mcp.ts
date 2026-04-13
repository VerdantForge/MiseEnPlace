import { McpServer, StreamableHttpTransport } from "mcp-lite";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";

// Per-request Supabase client injected by the /mcp Hono handler after auth validation.
// AsyncLocalStorage ensures each concurrent request sees its own client.
export const requestContext = new AsyncLocalStorage<{ supabase: SupabaseClient }>();

function getDb(): SupabaseClient {
  const ctx = requestContext.getStore();
  if (!ctx) throw new Error("No request context — tool called outside of an MCP request");
  return ctx.supabase;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

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
export const httpHandler = transport.bind(mcp);
