import { McpServer, StreamableHttpTransport } from "mcp-lite";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient, User } from "@supabase/supabase-js";

// Per-request context injected by the /mcp Hono handler after auth validation.
// AsyncLocalStorage ensures each concurrent request sees its own client and user.
export const requestContext = new AsyncLocalStorage<{ supabase: SupabaseClient; user: User }>();

function getDb(): SupabaseClient {
  const ctx = requestContext.getStore();
  if (!ctx) throw new Error("No request context — tool called outside of an MCP request");
  return ctx.supabase;
}

function getUserId(): string {
  const ctx = requestContext.getStore();
  if (!ctx) throw new Error("No request context — tool called outside of an MCP request");
  return ctx.user.id;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const mcp = new McpServer({
  name: "starter-mcp-supabase-server",
  version: "1.0.0",
  schemaAdapter: (schema: unknown) => z.toJSONSchema(schema as z.ZodType),
});


// ---------------------------------------------------------------------------
// Recipes tools — full CRUD + list, scoped to the authenticated user via RLS
// ---------------------------------------------------------------------------

mcp.tool("listRecipes", {
  description: "List recipes belonging to the authenticated user. Optionally scope to a specific list or filter by tested status.",
  inputSchema: z.object({
    list_id: z.string().uuid().optional().describe("If provided, only return recipes in this list"),
    tested: z.boolean().optional().describe("Filter by tested status. true = proven recipes you know, false = untried recipes to explore"),
  }),
  handler: async (args: { list_id?: string; tested?: boolean }) => {
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

      let query = db
        .from("recipes")
        .select("id, title, source, tested, created_at, updated_at")
        .in("id", ids)
        .order("created_at", { ascending: false });

      if (args.tested !== undefined) query = query.eq("tested", args.tested);

      const { data, error } = await query;

      if (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    let query = db
      .from("recipes")
      .select("id, title, source, tested, created_at, updated_at")
      .order("created_at", { ascending: false });

    if (args.tested !== undefined) query = query.eq("tested", args.tested);

    const { data, error } = await query;

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
  description: "Search recipes by keyword. Optionally scope to specific fields, a list, or filter by tested status.",
  inputSchema: z.object({
    query: z.string().min(1).describe("The search term (case-insensitive)"),
    fields: z
      .array(z.enum(["title", "content", "source", "notes"]))
      .optional()
      .describe("Which fields to search. Defaults to all: title, content, source, notes"),
    list_id: z.string().uuid().optional().describe("If provided, only search within this list"),
    tested: z.boolean().optional().describe("Filter results by tested status. true = proven recipes, false = untried recipes"),
  }),
  handler: async (args: { query: string; fields?: Array<"title" | "content" | "source" | "notes">; list_id?: string; tested?: boolean }) => {
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

    let finalQuery = db
      .from("recipes")
      .select("id, title, source, tested, variant_of, variant_label, created_at, updated_at")
      .in("id", ids)
      .order("created_at", { ascending: false });

    if (args.tested !== undefined) finalQuery = finalQuery.eq("tested", args.tested);

    const { data, error } = await finalQuery;

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

// ---------------------------------------------------------------------------
// Shopping list tools
// ---------------------------------------------------------------------------
// Permission model (enforced by RLS — no application-layer checks needed):
//   • owner: full control including share/delete the list itself
//   • member (shared): read + add/modify/remove items only

mcp.tool("listShoppingLists", {
  description: "List all shopping lists the authenticated user owns or has been shared on. Each entry includes a count of total items and how many have been acquired.",
  inputSchema: z.object({}),
  handler: async () => {
    const db = getDb();
    const { data: lists, error: listsError } = await db
      .from("shopping_lists")
      .select("id, owner_id, name, created_at, updated_at")
      .order("created_at", { ascending: false });

    if (listsError) {
      return { content: [{ type: "text", text: `Error: ${listsError.message}` }], isError: true };
    }
    if (!lists || lists.length === 0) {
      return { content: [{ type: "text", text: "[]" }] };
    }

    const listIds = lists.map((l: { id: string }) => l.id);
    const { data: items, error: itemsError } = await db
      .from("shopping_list_items")
      .select("list_id, acquired")
      .in("list_id", listIds);

    if (itemsError) {
      return { content: [{ type: "text", text: `Error fetching item counts: ${itemsError.message}` }], isError: true };
    }

    const counts: Record<string, { total: number; acquired: number }> = {};
    for (const item of items ?? []) {
      if (!counts[item.list_id]) counts[item.list_id] = { total: 0, acquired: 0 };
      counts[item.list_id].total++;
      if (item.acquired) counts[item.list_id].acquired++;
    }

    const result = lists.map((l: { id: string; owner_id: string; name: string; created_at: string; updated_at: string }) => ({
      ...l,
      item_count: counts[l.id]?.total ?? 0,
      acquired_count: counts[l.id]?.acquired ?? 0,
    }));

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
});

mcp.tool("createShoppingList", {
  description: "Create a new shopping list owned by the authenticated user",
  inputSchema: z.object({
    name: z.string().min(1).describe("Name of the shopping list, e.g. 'Weekly groceries' or 'BBQ Saturday'"),
  }),
  handler: async (args: { name: string }) => {
    const db = getDb();
    const { data, error } = await db
      .from("shopping_lists")
      .insert({ name: args.name, owner_id: getUserId() })
      .select("id, owner_id, name, created_at")
      .single();

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

mcp.tool("updateShoppingList", {
  description: "Rename a shopping list. Only the list owner may do this.",
  inputSchema: z.object({
    list_id: z.string().uuid(),
    name: z.string().min(1),
  }),
  handler: async (args: { list_id: string; name: string }) => {
    const db = getDb();
    const { data, error } = await db
      .from("shopping_lists")
      .update({ name: args.name })
      .eq("id", args.list_id)
      .select("id, name, updated_at")
      .single();

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

mcp.tool("deleteShoppingList", {
  description: "Delete a shopping list and all its items. Only the list owner may do this.",
  inputSchema: z.object({
    list_id: z.string().uuid(),
  }),
  handler: async (args: { list_id: string }) => {
    const db = getDb();
    const { error } = await db
      .from("shopping_lists")
      .delete()
      .eq("id", args.list_id);

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: `Shopping list ${args.list_id} deleted.` }] };
  },
});

mcp.tool("getShoppingList", {
  description: "Get a shopping list with all its items, ordered by position. Also returns whether the caller is the owner or a shared member.",
  inputSchema: z.object({
    list_id: z.string().uuid(),
  }),
  handler: async (args: { list_id: string }) => {
    const db = getDb();

    const { data: list, error: listError } = await db
      .from("shopping_lists")
      .select("id, owner_id, name, created_at, updated_at")
      .eq("id", args.list_id)
      .single();

    if (listError) {
      return { content: [{ type: "text", text: `Error: ${listError.message}` }], isError: true };
    }

    const { data: items, error: itemsError } = await db
      .from("shopping_list_items")
      .select("id, name, acquired, position, created_at, updated_at")
      .eq("list_id", args.list_id)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });

    if (itemsError) {
      return { content: [{ type: "text", text: `Error fetching items: ${itemsError.message}` }], isError: true };
    }

    const { data: userData, error: userError } = await db.auth.getUser();
    if (userError) {
      return { content: [{ type: "text", text: `Error resolving current user: ${userError.message}` }], isError: true };
    }

    const role = userData.user.id === list.owner_id ? "owner" : "member";

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ ...list, role, items: items ?? [] }, null, 2),
      }],
    };
  },
});

mcp.tool("addShoppingListItem", {
  description: "Add an item to a shopping list. Available to the list owner and any shared member.",
  inputSchema: z.object({
    list_id: z.string().uuid(),
    name: z.string().min(1).describe("Free-form item description, e.g. '2 lbs chicken thighs' or 'olive oil'"),
    position: z.number().int().optional().describe("Display order hint (lower = earlier). Defaults to 0."),
  }),
  handler: async (args: { list_id: string; name: string; position?: number }) => {
    const db = getDb();
    const { data, error } = await db
      .from("shopping_list_items")
      .insert({
        list_id: args.list_id,
        name: args.name,
        position: args.position ?? 0,
      })
      .select("id, list_id, name, acquired, position, created_at")
      .single();

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

mcp.tool("updateShoppingListItem", {
  description: "Edit an item's name, toggle its acquired status, or change its position. Available to the list owner and any shared member.",
  inputSchema: z.object({
    item_id: z.string().uuid(),
    name: z.string().min(1).optional().describe("New item name"),
    acquired: z.boolean().optional().describe("true = item has been picked up, false = still needed"),
    position: z.number().int().optional().describe("New display order hint"),
  }),
  handler: async (args: { item_id: string; name?: string; acquired?: boolean; position?: number }) => {
    const updates: Record<string, unknown> = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.acquired !== undefined) updates.acquired = args.acquired;
    if (args.position !== undefined) updates.position = args.position;

    if (Object.keys(updates).length === 0) {
      return { content: [{ type: "text", text: "Error: provide at least one field to update" }], isError: true };
    }

    const db = getDb();
    const { data, error } = await db
      .from("shopping_list_items")
      .update(updates)
      .eq("id", args.item_id)
      .select("id, list_id, name, acquired, position, updated_at")
      .single();

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

mcp.tool("removeShoppingListItem", {
  description: "Remove an item from a shopping list. Available to the list owner and any shared member.",
  inputSchema: z.object({
    item_id: z.string().uuid(),
  }),
  handler: async (args: { item_id: string }) => {
    const db = getDb();
    const { error } = await db
      .from("shopping_list_items")
      .delete()
      .eq("id", args.item_id);

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: `Item ${args.item_id} removed.` }] };
  },
});

mcp.tool("shareShoppingList", {
  description: "Share a shopping list with another user by their email address. Only the list owner may do this. The recipient gains immediate read and item-management access.",
  inputSchema: z.object({
    list_id: z.string().uuid(),
    email: z.string().email().describe("Email address of the user to share with"),
  }),
  handler: async (args: { list_id: string; email: string }) => {
    const db = getDb();

    // Resolve email → UUID via the least-privilege SECURITY DEFINER function.
    // The function lower()s the input and uses a bind parameter — no injection surface.
    const { data: targetUserId, error: lookupError } = await db
      .rpc("lookup_user_id_by_email", { p_email: args.email });

    if (lookupError) {
      return { content: [{ type: "text", text: `Error looking up user: ${lookupError.message}` }], isError: true };
    }
    if (!targetUserId) {
      return { content: [{ type: "text", text: `No account found for ${args.email}.` }], isError: true };
    }

    // Prevent sharing with yourself (would be a no-op but confusing)
    const { data: userData, error: userError } = await db.auth.getUser();
    if (userError) {
      return { content: [{ type: "text", text: `Error resolving current user: ${userError.message}` }], isError: true };
    }
    if (userData.user.id === targetUserId) {
      return { content: [{ type: "text", text: "You cannot share a list with yourself." }], isError: true };
    }

    const { error: shareError } = await db
      .from("shopping_list_shares")
      .insert({ list_id: args.list_id, user_id: targetUserId });

    if (shareError) {
      // Unique constraint violation means the list is already shared with this user
      if (shareError.code === "23505") {
        return { content: [{ type: "text", text: `List is already shared with ${args.email}.` }] };
      }
      return { content: [{ type: "text", text: `Error: ${shareError.message}` }], isError: true };
    }

    return { content: [{ type: "text", text: `Shopping list shared with ${args.email}.` }] };
  },
});

mcp.tool("unshareShoppingList", {
  description: "Revoke a user's access to a shared shopping list by their email address. Only the list owner may do this.",
  inputSchema: z.object({
    list_id: z.string().uuid(),
    email: z.string().email().describe("Email address of the user to remove"),
  }),
  handler: async (args: { list_id: string; email: string }) => {
    const db = getDb();

    const { data: targetUserId, error: lookupError } = await db
      .rpc("lookup_user_id_by_email", { p_email: args.email });

    if (lookupError) {
      return { content: [{ type: "text", text: `Error looking up user: ${lookupError.message}` }], isError: true };
    }
    if (!targetUserId) {
      return { content: [{ type: "text", text: `No account found for ${args.email}.` }], isError: true };
    }

    const { error } = await db
      .from("shopping_list_shares")
      .delete()
      .eq("list_id", args.list_id)
      .eq("user_id", targetUserId);

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    return { content: [{ type: "text", text: `Access revoked for ${args.email}.` }] };
  },
});

const transport = new StreamableHttpTransport();
export const httpHandler = transport.bind(mcp);
