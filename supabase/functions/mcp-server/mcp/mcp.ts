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
  description: "List recipes belonging to the authenticated user. Optionally scope to a specific list.",
  inputSchema: z.object({
    list_id: z.string().uuid().optional().describe("If provided, only return recipes in this list"),
  }),
  handler: async (args: { list_id?: string }) => {
    const db = getDb();

    if (args.list_id) {
      const { data: items, error: itemsError } = await db
        .from("recipe_list_items")
        .select("recipe_id")
        .eq("list_id", args.list_id);

      if (itemsError) {
        return { content: [{ type: "text", text: `Error: ${itemsError.message}` }], isError: true };
      }

      const ids = (items ?? []).map((r: { recipe_id: string }) => r.recipe_id);
      if (ids.length === 0) {
        return { content: [{ type: "text", text: "[]" }] };
      }

      const { data, error } = await db
        .from("recipes")
        .select("id, title, source, tested, created_at, updated_at")
        .in("id", ids)
        .order("created_at", { ascending: false });

      if (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    const { data, error } = await db
      .from("recipes")
      .select("id, title, source, tested, created_at, updated_at")
      .order("created_at", { ascending: false });

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

mcp.tool("getRecipe", {
  description: "Get a single recipe by ID, including its notes",
  inputSchema: z.object({
    id: z.string().uuid(),
  }),
  handler: async (args: { id: string }) => {
    const db = getDb();
    const { data: recipe, error: recipeError } = await db
      .from("recipes")
      .select("*")
      .eq("id", args.id)
      .single();

    if (recipeError) {
      return { content: [{ type: "text", text: `Error: ${recipeError.message}` }], isError: true };
    }

    const { data: notes, error: notesError } = await db
      .from("recipe_notes")
      .select("id, content, created_at, updated_at")
      .eq("recipe_id", args.id)
      .order("created_at", { ascending: true });

    if (notesError) {
      return { content: [{ type: "text", text: `Error fetching notes: ${notesError.message}` }], isError: true };
    }

    return { content: [{ type: "text", text: JSON.stringify({ ...recipe, notes: notes ?? [] }, null, 2) }] };
  },
});

mcp.tool("createRecipe", {
  description: "Create a new recipe for the authenticated user",
  inputSchema: z.object({
    title: z.string().min(1),
    content: z.string().min(1),
    source: z.string().optional().describe("Where this recipe came from: a URL, book title, or person"),
    tested: z.boolean().optional().describe("Whether this recipe has been cooked and validated"),
    variant_of: z.string().uuid().optional().describe("ID of the recipe this is a variant of"),
    variant_label: z.string().optional().describe("Describes the adaptation, e.g. 'gluten-free', 'low-fodmap', 'bulk'"),
  }),
  handler: async (args: { title: string; content: string; source?: string; tested?: boolean; variant_of?: string; variant_label?: string }) => {
    const db = getDb();
    const { data, error } = await db
      .from("recipes")
      .insert({
        title: args.title,
        content: args.content,
        source: args.source ?? null,
        tested: args.tested ?? false,
        variant_of: args.variant_of ?? null,
        variant_label: args.variant_label ?? null,
      })
      .select("id, title, source, tested, variant_of, variant_label, created_at")
      .single();

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

mcp.tool("updateRecipe", {
  description: "Update fields of an existing recipe by ID",
  inputSchema: z.object({
    id: z.string().uuid(),
    title: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
    source: z.string().nullable().optional().describe("Set to null to clear"),
    tested: z.boolean().optional(),
    variant_of: z.string().uuid().nullable().optional().describe("Set to null to remove variant relationship"),
    variant_label: z.string().nullable().optional().describe("Set to null to clear"),
  }),
  handler: async (args: { id: string; title?: string; content?: string; source?: string | null; tested?: boolean; variant_of?: string | null; variant_label?: string | null }) => {
    const updates: Record<string, unknown> = {};
    if (args.title !== undefined) updates.title = args.title;
    if (args.content !== undefined) updates.content = args.content;
    if (args.source !== undefined) updates.source = args.source;
    if (args.tested !== undefined) updates.tested = args.tested;
    if (args.variant_of !== undefined) updates.variant_of = args.variant_of;
    if (args.variant_label !== undefined) updates.variant_label = args.variant_label;

    if (Object.keys(updates).length === 0) {
      return { content: [{ type: "text", text: "Error: provide at least one field to update" }], isError: true };
    }

    const db = getDb();
    const { data, error } = await db
      .from("recipes")
      .update(updates)
      .eq("id", args.id)
      .select("id, title, source, tested, variant_of, variant_label, updated_at")
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

// ---------------------------------------------------------------------------
// Recipe family tool — returns an original recipe plus all its variants
// ---------------------------------------------------------------------------

mcp.tool("getRecipeFamily", {
  description: "Given any recipe (original or variant), return the full family: the original and all its variants",
  inputSchema: z.object({
    recipe_id: z.string().uuid().describe("ID of any recipe in the family"),
  }),
  handler: async (args: { recipe_id: string }) => {
    const db = getDb();

    // Resolve the root: fetch the recipe to check if it's already the original
    const { data: recipe, error: fetchError } = await db
      .from("recipes")
      .select("id, variant_of")
      .eq("id", args.recipe_id)
      .single();

    if (fetchError) {
      return { content: [{ type: "text", text: `Error: ${fetchError.message}` }], isError: true };
    }

    const rootId: string = recipe.variant_of ?? recipe.id;

    const { data, error } = await db
      .from("recipes")
      .select("id, title, source, tested, variant_of, variant_label, created_at, updated_at")
      .or(`id.eq.${rootId},variant_of.eq.${rootId}`)
      .order("created_at", { ascending: true });

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

// ---------------------------------------------------------------------------
// Lists tools
// ---------------------------------------------------------------------------

mcp.tool("listLists", {
  description: "List all recipe lists belonging to the authenticated user",
  inputSchema: z.object({}),
  handler: async () => {
    const db = getDb();
    const { data, error } = await db
      .from("recipe_lists")
      .select("id, name, description, created_at, updated_at")
      .order("created_at", { ascending: false });

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

mcp.tool("createList", {
  description: "Create a new recipe list",
  inputSchema: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
  }),
  handler: async (args: { name: string; description?: string }) => {
    const db = getDb();
    const { data, error } = await db
      .from("recipe_lists")
      .insert({ name: args.name, description: args.description ?? null })
      .select("id, name, description, created_at")
      .single();

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

mcp.tool("updateList", {
  description: "Update the name and/or description of a recipe list",
  inputSchema: z.object({
    id: z.string().uuid(),
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional().describe("Set to null to clear"),
  }),
  handler: async (args: { id: string; name?: string; description?: string | null }) => {
    const updates: Record<string, unknown> = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.description !== undefined) updates.description = args.description;

    if (Object.keys(updates).length === 0) {
      return { content: [{ type: "text", text: "Error: provide at least one field to update" }], isError: true };
    }

    const db = getDb();
    const { data, error } = await db
      .from("recipe_lists")
      .update(updates)
      .eq("id", args.id)
      .select("id, name, description, updated_at")
      .single();

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

mcp.tool("deleteList", {
  description: "Delete a recipe list (recipes themselves are not deleted)",
  inputSchema: z.object({
    id: z.string().uuid(),
  }),
  handler: async (args: { id: string }) => {
    const db = getDb();
    const { error } = await db
      .from("recipe_lists")
      .delete()
      .eq("id", args.id);

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: `List ${args.id} deleted.` }] };
  },
});

mcp.tool("addRecipeToList", {
  description: "Add a recipe to a list",
  inputSchema: z.object({
    list_id: z.string().uuid(),
    recipe_id: z.string().uuid(),
  }),
  handler: async (args: { list_id: string; recipe_id: string }) => {
    const db = getDb();
    const { error } = await db
      .from("recipe_list_items")
      .insert({ list_id: args.list_id, recipe_id: args.recipe_id });

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: `Recipe ${args.recipe_id} added to list ${args.list_id}.` }] };
  },
});

mcp.tool("removeRecipeFromList", {
  description: "Remove a recipe from a list",
  inputSchema: z.object({
    list_id: z.string().uuid(),
    recipe_id: z.string().uuid(),
  }),
  handler: async (args: { list_id: string; recipe_id: string }) => {
    const db = getDb();
    const { error } = await db
      .from("recipe_list_items")
      .delete()
      .eq("list_id", args.list_id)
      .eq("recipe_id", args.recipe_id);

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: `Recipe ${args.recipe_id} removed from list ${args.list_id}.` }] };
  },
});

// ---------------------------------------------------------------------------
// Notes tools
// ---------------------------------------------------------------------------

mcp.tool("addNote", {
  description: "Add a note to a recipe",
  inputSchema: z.object({
    recipe_id: z.string().uuid(),
    content: z.string().min(1),
  }),
  handler: async (args: { recipe_id: string; content: string }) => {
    const db = getDb();
    const { data, error } = await db
      .from("recipe_notes")
      .insert({ recipe_id: args.recipe_id, content: args.content })
      .select("id, recipe_id, content, created_at")
      .single();

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

mcp.tool("updateNote", {
  description: "Update the content of a note",
  inputSchema: z.object({
    id: z.string().uuid(),
    content: z.string().min(1),
  }),
  handler: async (args: { id: string; content: string }) => {
    const db = getDb();
    const { data, error } = await db
      .from("recipe_notes")
      .update({ content: args.content })
      .eq("id", args.id)
      .select("id, content, updated_at")
      .single();

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

mcp.tool("deleteNote", {
  description: "Delete a note by ID",
  inputSchema: z.object({
    id: z.string().uuid(),
  }),
  handler: async (args: { id: string }) => {
    const db = getDb();
    const { error } = await db
      .from("recipe_notes")
      .delete()
      .eq("id", args.id);

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: `Note ${args.id} deleted.` }] };
  },
});

// ---------------------------------------------------------------------------
// Search tool
// ---------------------------------------------------------------------------

mcp.tool("searchRecipes", {
  description: "Search recipes by keyword. Optionally scope to specific fields or a list.",
  inputSchema: z.object({
    query: z.string().min(1).describe("The search term (case-insensitive)"),
    fields: z
      .array(z.enum(["title", "content", "source", "notes"]))
      .optional()
      .describe("Which fields to search. Defaults to all: title, content, source, notes"),
    list_id: z.string().uuid().optional().describe("If provided, only search within this list"),
  }),
  handler: async (args: { query: string; fields?: Array<"title" | "content" | "source" | "notes">; list_id?: string }) => {
    const db = getDb();
    const fields = args.fields ?? ["title", "content", "source", "notes"];
    const q = args.query;

    const matchedIds = new Set<string>();

    // Search recipe fields (title, content, source)
    const recipeFields = fields.filter((f): f is "title" | "content" | "source" => f !== "notes");
    if (recipeFields.length > 0) {
      const orFilter = recipeFields.map((f) => `${f}.ilike.%${q}%`).join(",");
      const { data, error } = await db
        .from("recipes")
        .select("id")
        .or(orFilter);

      if (error) {
        return { content: [{ type: "text", text: `Error searching recipes: ${error.message}` }], isError: true };
      }
      for (const row of data ?? []) matchedIds.add(row.id);
    }

    // Search notes
    if (fields.includes("notes")) {
      const { data, error } = await db
        .from("recipe_notes")
        .select("recipe_id")
        .ilike("content", `%${q}%`);

      if (error) {
        return { content: [{ type: "text", text: `Error searching notes: ${error.message}` }], isError: true };
      }
      for (const row of data ?? []) matchedIds.add(row.recipe_id);
    }

    if (matchedIds.size === 0) {
      return { content: [{ type: "text", text: "[]" }] };
    }

    let ids = [...matchedIds];

    // Scope to list if requested
    if (args.list_id) {
      const { data, error } = await db
        .from("recipe_list_items")
        .select("recipe_id")
        .eq("list_id", args.list_id)
        .in("recipe_id", ids);

      if (error) {
        return { content: [{ type: "text", text: `Error filtering by list: ${error.message}` }], isError: true };
      }
      ids = (data ?? []).map((r: { recipe_id: string }) => r.recipe_id);
    }

    if (ids.length === 0) {
      return { content: [{ type: "text", text: "[]" }] };
    }

    const { data, error } = await db
      .from("recipes")
      .select("id, title, source, tested, variant_of, variant_label, created_at, updated_at")
      .in("id", ids)
      .order("created_at", { ascending: false });

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

const transport = new StreamableHttpTransport();
export const httpHandler = transport.bind(mcp);
