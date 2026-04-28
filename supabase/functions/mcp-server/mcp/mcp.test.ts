/**
 * Unit tests for MCP tool input/output behaviour.
 *
 * Strategy: inject a recording mock Supabase client via requestContext, call
 * the MCP HTTP transport directly, then assert that the correct query builder
 * methods were (or weren't) chained.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { httpHandler, requestContext } from "./mcp.ts";
import type { SupabaseClient, User } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Mock fluent Supabase query builder
// ---------------------------------------------------------------------------

type MethodCall = { method: string; args: unknown[] };

interface MockBuilder {
  calls: MethodCall[];
  select: (...a: unknown[]) => MockBuilder;
  eq: (...a: unknown[]) => MockBuilder;
  neq: (...a: unknown[]) => MockBuilder;
  in: (...a: unknown[]) => MockBuilder;
  or: (...a: unknown[]) => MockBuilder;
  order: (...a: unknown[]) => MockBuilder;
  ilike: (...a: unknown[]) => MockBuilder;
  single: (...a: unknown[]) => MockBuilder;
  delete: (...a: unknown[]) => MockBuilder;
  insert: (...a: unknown[]) => MockBuilder;
  update: (...a: unknown[]) => MockBuilder;
  then<T>(resolve: (v: { data: unknown; error: null }) => T, reject?: (e: unknown) => T): Promise<T>;
}

function createMockBuilder(data: unknown): MockBuilder {
  const calls: MethodCall[] = [];
  const rec =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };

  const builder: MockBuilder = {
    calls,
    select: rec("select"),
    eq: rec("eq"),
    neq: rec("neq"),
    in: rec("in"),
    or: rec("or"),
    order: rec("order"),
    ilike: rec("ilike"),
    // .single() records the call AND marks that the resolved value should be
    // unwrapped from an array to the first element — matching real supabase-js.
    single: rec("single"),
    delete: rec("delete"),
    insert: rec("insert"),
    update: rec("update"),
    then<T>(
      resolve: (v: { data: unknown; error: null }) => T,
      reject?: (e: unknown) => T,
    ) {
      // If .single() was called, unwrap array → first element (mirrors supabase-js)
      const isSingle = calls.some((c) => c.method === "single");
      const resolved = isSingle && Array.isArray(data) ? data[0] ?? null : data;
      return Promise.resolve({ data: resolved, error: null }).then(resolve, reject);
    },
  };

  return builder;
}

/**
 * Creates a mock Supabase client.
 *
 * `plan` maps table names to an ordered list of response payloads — each
 * sequential call to `from(table)` consumes the next entry. The last entry is
 * reused if calls exceed the plan length.
 *
 * Optional overrides:
 *   `rpcResult`   — value returned by any `.rpc()` call (defaults to null)
 *   `authUserId`  — user id returned by `auth.getUser()` (defaults to FAKE_USER_ID)
 */
function createMockDb(
  plan: Record<string, unknown[][]>,
  opts: { rpcResult?: unknown; authUserId?: string } = {},
) {
  const counters: Record<string, number> = {};
  const log: Array<{ table: string; builder: MockBuilder }> = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];

  const authUserId = opts.authUserId ?? FAKE_USER_ID;

  return {
    from(table: string) {
      const n = counters[table] ?? 0;
      counters[table] = n + 1;
      const responses = plan[table] ?? [[]];
      const data = responses[Math.min(n, responses.length - 1)];
      const b = createMockBuilder(data);
      log.push({ table, builder: b });
      return b;
    },
    rpc(fn: string, args: unknown) {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: opts.rpcResult ?? null, error: null });
    },
    auth: {
      getUser() {
        return Promise.resolve({
          data: { user: { id: authUserId } },
          error: null,
        });
      },
    },
    _log: log,
    _rpcCalls: rpcCalls,
  };
}

type MockDb = ReturnType<typeof createMockDb>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sends an MCP tools/call request to httpHandler with the mock DB injected.
 * An initialize message is sent first to satisfy implementations that require
 * the MCP handshake before accepting tool calls.
 */
async function callTool(
  db: MockDb,
  toolName: string,
  args: Record<string, unknown>,
) {
  const mockUser = { id: "00000000-0000-0000-0000-000000000001" } as User;
  const injectDb = { supabase: db as unknown as SupabaseClient, user: mockUser };

  // Initialize (some MCP implementations require this before tools/call)
  const initReq = new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      },
    }),
  });
  await requestContext.run(injectDb, () => httpHandler(initReq));

  // Tool call
  const req = new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  const response = await requestContext.run(injectDb, () => httpHandler(req));
  return response.json() as Promise<{
    jsonrpc: "2.0";
    id: number;
    result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
    error?: { code: number; message: string };
  }>;
}

/** Returns the nth builder created for a table (0-indexed, in call order). */
function getBuilder(db: MockDb, table: string, callIndex = 0) {
  const entries = db._log.filter((e) => e.table === table);
  return entries[callIndex]?.builder;
}

/** True when the builder had `.eq(field, value)` called on it. */
function hadEqCall(builder: MockBuilder, field: string, value: unknown) {
  return builder.calls.some(
    (c) => c.method === "eq" && c.args[0] === field && c.args[1] === value,
  );
}

/** True when the builder never had `.eq(field, …)` called on it. */
function hadNoEqCallFor(builder: MockBuilder, field: string) {
  return !builder.calls.some((c) => c.method === "eq" && c.args[0] === field);
}

// Stable UUIDs used across tests — must be valid UUID v4 (version nibble = 4,
// variant nibble = 8-b) so Zod's strict uuid validator accepts them as tool args.
const FAKE_RECIPE_ID        = "00000000-0000-4000-8000-000000000001";
const FAKE_LIST_ID          = "00000000-0000-4000-8000-000000000099";
const FAKE_USER_ID          = "00000000-0000-4000-8000-000000000010";
const FAKE_OTHER_USER_ID    = "00000000-0000-4000-8000-000000000011";
const FAKE_SHOPPING_LIST_ID = "00000000-0000-4000-8000-000000000050";
const FAKE_ITEM_ID          = "00000000-0000-4000-8000-000000000060";

// ---------------------------------------------------------------------------
// listRecipes — tested filter
// ---------------------------------------------------------------------------

Deno.test("listRecipes: no tested arg — omits .eq('tested', …) call", async () => {
  const db = createMockDb({ recipes: [[]] });
  await callTool(db, "listRecipes", {});
  const b = getBuilder(db, "recipes");
  assert(b, "expected a recipes query");
  assert(hadNoEqCallFor(b, "tested"));
});

Deno.test("listRecipes: tested: true — chains .eq('tested', true)", async () => {
  const db = createMockDb({ recipes: [[]] });
  await callTool(db, "listRecipes", { tested: true });
  const b = getBuilder(db, "recipes");
  assert(b, "expected a recipes query");
  assert(hadEqCall(b, "tested", true));
});

Deno.test("listRecipes: tested: false — chains .eq('tested', false)", async () => {
  const db = createMockDb({ recipes: [[]] });
  await callTool(db, "listRecipes", { tested: false });
  const b = getBuilder(db, "recipes");
  assert(b, "expected a recipes query");
  assert(hadEqCall(b, "tested", false));
});

Deno.test("listRecipes: tested filter applies inside list_id branch", async () => {
  const db = createMockDb({
    recipe_list_items: [[{ recipe_id: FAKE_RECIPE_ID }]],
    recipes: [[]],
  });
  await callTool(db, "listRecipes", { list_id: FAKE_LIST_ID, tested: true });
  const b = getBuilder(db, "recipes");
  assert(b, "expected a recipes query after list lookup");
  assert(hadEqCall(b, "tested", true));
});

Deno.test("listRecipes: no tested arg inside list_id branch — omits .eq('tested', …)", async () => {
  const db = createMockDb({
    recipe_list_items: [[{ recipe_id: FAKE_RECIPE_ID }]],
    recipes: [[]],
  });
  await callTool(db, "listRecipes", { list_id: FAKE_LIST_ID });
  const b = getBuilder(db, "recipes");
  assert(b, "expected a recipes query after list lookup");
  assert(hadNoEqCallFor(b, "tested"));
});

// ---------------------------------------------------------------------------
// searchRecipes — tested filter
//
// searchRecipes makes two from("recipes") calls:
//   [0]  initial field search → select id, or(…)
//   [1]  final fetch          → select full fields, in(ids), eq?(tested), order
//
// The first call must return a non-empty result so execution reaches the final
// fetch; otherwise the handler short-circuits with an empty array.
// ---------------------------------------------------------------------------

Deno.test("searchRecipes: no tested arg — omits .eq('tested', …) on final fetch", async () => {
  const db = createMockDb({
    recipes: [[{ id: FAKE_RECIPE_ID }], []],
    recipe_notes: [[]],
  });
  await callTool(db, "searchRecipes", { query: "pasta" });
  const finalBuilder = getBuilder(db, "recipes", 1);
  assert(finalBuilder, "expected final recipes fetch");
  assert(hadNoEqCallFor(finalBuilder, "tested"));
});

Deno.test("searchRecipes: tested: true — chains .eq('tested', true) on final fetch", async () => {
  const db = createMockDb({
    recipes: [[{ id: FAKE_RECIPE_ID }], []],
    recipe_notes: [[]],
  });
  await callTool(db, "searchRecipes", { query: "pasta", tested: true });
  const finalBuilder = getBuilder(db, "recipes", 1);
  assert(finalBuilder, "expected final recipes fetch");
  assert(hadEqCall(finalBuilder, "tested", true));
});

Deno.test("searchRecipes: tested: false — chains .eq('tested', false) on final fetch", async () => {
  const db = createMockDb({
    recipes: [[{ id: FAKE_RECIPE_ID }], []],
    recipe_notes: [[]],
  });
  await callTool(db, "searchRecipes", { query: "pasta", tested: false });
  const finalBuilder = getBuilder(db, "recipes", 1);
  assert(finalBuilder, "expected final recipes fetch");
  assert(hadEqCall(finalBuilder, "tested", false));
});

Deno.test("searchRecipes: tested filter applies alongside list_id scope", async () => {
  const db = createMockDb({
    recipes: [[{ id: FAKE_RECIPE_ID }], []],
    recipe_notes: [[]],
    recipe_list_items: [[{ recipe_id: FAKE_RECIPE_ID }]],
  });
  await callTool(db, "searchRecipes", {
    query: "pasta",
    list_id: FAKE_LIST_ID,
    tested: true,
  });
  const finalBuilder = getBuilder(db, "recipes", 1);
  assert(finalBuilder, "expected final recipes fetch");
  assert(hadEqCall(finalBuilder, "tested", true));
});

// ---------------------------------------------------------------------------
// Shopping list tools — input schema and query builder assertions
// ---------------------------------------------------------------------------

// --- listShoppingLists ------------------------------------------------------

Deno.test("listShoppingLists: queries shopping_lists then shopping_list_items", async () => {
  const db = createMockDb({
    shopping_lists: [[{ id: FAKE_SHOPPING_LIST_ID, owner_id: FAKE_USER_ID, name: "Weekly", created_at: "", updated_at: "" }]],
    shopping_list_items: [[{ list_id: FAKE_SHOPPING_LIST_ID, acquired: false }]],
  });
  const res = await callTool(db, "listShoppingLists", {});
  assert(!res.result?.isError, "expected no error");
  const listsBuilder = getBuilder(db, "shopping_lists");
  assert(listsBuilder, "expected shopping_lists query");
  const itemsBuilder = getBuilder(db, "shopping_list_items");
  assert(itemsBuilder, "expected shopping_list_items query");
});

Deno.test("listShoppingLists: returns empty array when user has no lists", async () => {
  const db = createMockDb({ shopping_lists: [[]] });
  const res = await callTool(db, "listShoppingLists", {});
  assert(!res.result?.isError, "expected no error");
  assertEquals(res.result?.content[0].text, "[]");
});

// --- createShoppingList -----------------------------------------------------

Deno.test("createShoppingList: inserts into shopping_lists with provided name", async () => {
  const db = createMockDb({
    shopping_lists: [[{ id: FAKE_SHOPPING_LIST_ID, owner_id: FAKE_USER_ID, name: "BBQ Saturday", created_at: "" }]],
  });
  const res = await callTool(db, "createShoppingList", { name: "BBQ Saturday" });
  assert(!res.result?.isError, "expected no error");
  const b = getBuilder(db, "shopping_lists");
  assert(b, "expected shopping_lists builder");
  assert(b.calls.some((c) => c.method === "insert"), "expected insert call");
});

Deno.test("createShoppingList: rejects empty name", async () => {
  const db = createMockDb({ shopping_lists: [[]] });
  const res = await callTool(db, "createShoppingList", { name: "" });
  // Zod validation error → MCP returns an error response
  assert(res.error || res.result?.isError, "expected validation error for empty name");
});

// --- updateShoppingList -----------------------------------------------------

Deno.test("updateShoppingList: chains .eq('id', list_id) and .update()", async () => {
  const db = createMockDb({
    shopping_lists: [[{ id: FAKE_SHOPPING_LIST_ID, name: "Renamed", updated_at: "" }]],
  });
  const res = await callTool(db, "updateShoppingList", { list_id: FAKE_SHOPPING_LIST_ID, name: "Renamed" });
  assert(!res.result?.isError, "expected no error");
  const b = getBuilder(db, "shopping_lists");
  assert(b, "expected shopping_lists builder");
  assert(b.calls.some((c) => c.method === "update"), "expected update call");
  assert(hadEqCall(b, "id", FAKE_SHOPPING_LIST_ID), "expected eq on list id");
});

// --- deleteShoppingList -----------------------------------------------------

Deno.test("deleteShoppingList: chains .delete().eq('id', list_id)", async () => {
  const db = createMockDb({ shopping_lists: [[]] });
  const res = await callTool(db, "deleteShoppingList", { list_id: FAKE_SHOPPING_LIST_ID });
  assert(!res.result?.isError, "expected no error");
  const b = getBuilder(db, "shopping_lists");
  assert(b, "expected shopping_lists builder");
  assert(b.calls.some((c) => c.method === "delete"), "expected delete call");
  assert(hadEqCall(b, "id", FAKE_SHOPPING_LIST_ID), "expected eq on list id");
});

// --- getShoppingList --------------------------------------------------------

Deno.test("getShoppingList: returns role=owner when caller is owner", async () => {
  const db = createMockDb(
    {
      shopping_lists: [[{ id: FAKE_SHOPPING_LIST_ID, owner_id: FAKE_USER_ID, name: "Weekly", created_at: "", updated_at: "" }]],
      shopping_list_items: [[{ id: FAKE_ITEM_ID, name: "Milk", acquired: false, position: 0, created_at: "", updated_at: "" }]],
    },
    { authUserId: FAKE_USER_ID },
  );
  const res = await callTool(db, "getShoppingList", { list_id: FAKE_SHOPPING_LIST_ID });
  assert(!res.result?.isError, "expected no error");
  const body = JSON.parse(res.result!.content[0].text);
  assertEquals(body.role, "owner");
  assertEquals(body.items.length, 1);
});

Deno.test("getShoppingList: returns role=member when caller is not owner", async () => {
  const db = createMockDb(
    {
      shopping_lists: [[{ id: FAKE_SHOPPING_LIST_ID, owner_id: FAKE_OTHER_USER_ID, name: "Weekly", created_at: "", updated_at: "" }]],
      shopping_list_items: [[]],
    },
    { authUserId: FAKE_USER_ID },
  );
  const res = await callTool(db, "getShoppingList", { list_id: FAKE_SHOPPING_LIST_ID });
  assert(!res.result?.isError, "expected no error");
  const body = JSON.parse(res.result!.content[0].text);
  assertEquals(body.role, "member");
});

Deno.test("getShoppingList: items ordered by position then created_at", async () => {
  const db = createMockDb(
    {
      shopping_lists: [[{ id: FAKE_SHOPPING_LIST_ID, owner_id: FAKE_USER_ID, name: "Weekly", created_at: "", updated_at: "" }]],
      shopping_list_items: [[]],
    },
    { authUserId: FAKE_USER_ID },
  );
  await callTool(db, "getShoppingList", { list_id: FAKE_SHOPPING_LIST_ID });
  const b = getBuilder(db, "shopping_list_items");
  assert(b, "expected shopping_list_items builder");
  const orderCalls = b.calls.filter((c) => c.method === "order");
  assert(orderCalls.some((c) => c.args[0] === "position"), "expected order by position");
  assert(orderCalls.some((c) => c.args[0] === "created_at"), "expected order by created_at");
});

// --- addShoppingListItem ----------------------------------------------------

Deno.test("addShoppingListItem: inserts item with list_id and name", async () => {
  const db = createMockDb({
    shopping_list_items: [[{ id: FAKE_ITEM_ID, list_id: FAKE_SHOPPING_LIST_ID, name: "Olive oil", acquired: false, position: 0, created_at: "" }]],
  });
  const res = await callTool(db, "addShoppingListItem", { list_id: FAKE_SHOPPING_LIST_ID, name: "Olive oil" });
  assert(!res.result?.isError, "expected no error");
  const b = getBuilder(db, "shopping_list_items");
  assert(b, "expected shopping_list_items builder");
  assert(b.calls.some((c) => c.method === "insert"), "expected insert call");
});

Deno.test("addShoppingListItem: rejects empty name", async () => {
  const db = createMockDb({ shopping_list_items: [[]] });
  const res = await callTool(db, "addShoppingListItem", { list_id: FAKE_SHOPPING_LIST_ID, name: "" });
  assert(res.error || res.result?.isError, "expected validation error for empty name");
});

Deno.test("addShoppingListItem: uses provided position", async () => {
  const db = createMockDb({
    shopping_list_items: [[{ id: FAKE_ITEM_ID, list_id: FAKE_SHOPPING_LIST_ID, name: "Eggs", acquired: false, position: 5, created_at: "" }]],
  });
  const res = await callTool(db, "addShoppingListItem", { list_id: FAKE_SHOPPING_LIST_ID, name: "Eggs", position: 5 });
  assert(!res.result?.isError, "expected no error");
  const b = getBuilder(db, "shopping_list_items");
  const insertCall = b.calls.find((c) => c.method === "insert");
  assert(insertCall, "expected insert call");
  assertEquals((insertCall.args[0] as Record<string, unknown>).position, 5);
});

// --- updateShoppingListItem -------------------------------------------------

Deno.test("updateShoppingListItem: updates acquired status", async () => {
  const db = createMockDb({
    shopping_list_items: [[{ id: FAKE_ITEM_ID, list_id: FAKE_SHOPPING_LIST_ID, name: "Milk", acquired: true, position: 0, updated_at: "" }]],
  });
  const res = await callTool(db, "updateShoppingListItem", { item_id: FAKE_ITEM_ID, acquired: true });
  assert(!res.result?.isError, "expected no error");
  const b = getBuilder(db, "shopping_list_items");
  assert(b.calls.some((c) => c.method === "update"), "expected update call");
  assert(hadEqCall(b, "id", FAKE_ITEM_ID), "expected eq on item id");
});

Deno.test("updateShoppingListItem: rejects call with no fields", async () => {
  const db = createMockDb({ shopping_list_items: [[]] });
  const res = await callTool(db, "updateShoppingListItem", { item_id: FAKE_ITEM_ID });
  assert(res.result?.isError, "expected error when no fields provided");
});

Deno.test("updateShoppingListItem: can update name, acquired, and position together", async () => {
  const db = createMockDb({
    shopping_list_items: [[{ id: FAKE_ITEM_ID, list_id: FAKE_SHOPPING_LIST_ID, name: "Butter", acquired: false, position: 2, updated_at: "" }]],
  });
  const res = await callTool(db, "updateShoppingListItem", { item_id: FAKE_ITEM_ID, name: "Butter", acquired: false, position: 2 });
  assert(!res.result?.isError, "expected no error");
  const b = getBuilder(db, "shopping_list_items");
  const updateCall = b.calls.find((c) => c.method === "update");
  assert(updateCall, "expected update call");
  const payload = updateCall.args[0] as Record<string, unknown>;
  assertEquals(payload.name, "Butter");
  assertEquals(payload.acquired, false);
  assertEquals(payload.position, 2);
});

// --- removeShoppingListItem -------------------------------------------------

Deno.test("removeShoppingListItem: chains .delete().eq('id', item_id)", async () => {
  const db = createMockDb({ shopping_list_items: [[]] });
  const res = await callTool(db, "removeShoppingListItem", { item_id: FAKE_ITEM_ID });
  assert(!res.result?.isError, "expected no error");
  const b = getBuilder(db, "shopping_list_items");
  assert(b.calls.some((c) => c.method === "delete"), "expected delete call");
  assert(hadEqCall(b, "id", FAKE_ITEM_ID), "expected eq on item id");
});

// --- shareShoppingList ------------------------------------------------------

Deno.test("shareShoppingList: calls rpc lookup then inserts share row", async () => {
  const db = createMockDb(
    { shopping_list_shares: [[]] },
    { rpcResult: FAKE_OTHER_USER_ID, authUserId: FAKE_USER_ID },
  );
  const res = await callTool(db, "shareShoppingList", { list_id: FAKE_SHOPPING_LIST_ID, email: "other@example.com" });
  assert(!res.result?.isError, "expected no error");
  assert(db._rpcCalls.some((c) => c.fn === "lookup_user_id_by_email"), "expected rpc call");
  const b = getBuilder(db, "shopping_list_shares");
  assert(b, "expected shopping_list_shares builder");
  assert(b.calls.some((c) => c.method === "insert"), "expected insert call");
});

Deno.test("shareShoppingList: returns error when email not found", async () => {
  const db = createMockDb(
    { shopping_list_shares: [[]] },
    { rpcResult: null, authUserId: FAKE_USER_ID },
  );
  const res = await callTool(db, "shareShoppingList", { list_id: FAKE_SHOPPING_LIST_ID, email: "nobody@example.com" });
  assert(res.result?.isError, "expected error for unknown email");
});

Deno.test("shareShoppingList: returns error when sharing with yourself", async () => {
  const db = createMockDb(
    { shopping_list_shares: [[]] },
    { rpcResult: FAKE_USER_ID, authUserId: FAKE_USER_ID },
  );
  const res = await callTool(db, "shareShoppingList", { list_id: FAKE_SHOPPING_LIST_ID, email: "me@example.com" });
  assert(res.result?.isError, "expected error when sharing with self");
});

Deno.test("shareShoppingList: rejects invalid email format", async () => {
  const db = createMockDb({}, { rpcResult: null });
  const res = await callTool(db, "shareShoppingList", { list_id: FAKE_SHOPPING_LIST_ID, email: "not-an-email" });
  assert(res.error || res.result?.isError, "expected validation error for invalid email");
});

// --- unshareShoppingList ----------------------------------------------------

Deno.test("unshareShoppingList: calls rpc lookup then deletes share row", async () => {
  const db = createMockDb(
    { shopping_list_shares: [[]] },
    { rpcResult: FAKE_OTHER_USER_ID },
  );
  const res = await callTool(db, "unshareShoppingList", { list_id: FAKE_SHOPPING_LIST_ID, email: "other@example.com" });
  assert(!res.result?.isError, "expected no error");
  assert(db._rpcCalls.some((c) => c.fn === "lookup_user_id_by_email"), "expected rpc call");
  const b = getBuilder(db, "shopping_list_shares");
  assert(b, "expected shopping_list_shares builder");
  assert(b.calls.some((c) => c.method === "delete"), "expected delete call");
  assert(hadEqCall(b, "list_id", FAKE_SHOPPING_LIST_ID), "expected eq on list_id");
  assert(hadEqCall(b, "user_id", FAKE_OTHER_USER_ID), "expected eq on user_id");
});

Deno.test("unshareShoppingList: returns error when email not found", async () => {
  const db = createMockDb(
    { shopping_list_shares: [[]] },
    { rpcResult: null },
  );
  const res = await callTool(db, "unshareShoppingList", { list_id: FAKE_SHOPPING_LIST_ID, email: "nobody@example.com" });
  assert(res.result?.isError, "expected error for unknown email");
});
