/**
 * Unit tests for the `tested` filter added to listRecipes and searchRecipes.
 *
 * Strategy: inject a recording mock Supabase client via requestContext, call
 * the MCP HTTP transport directly, then assert that the correct .eq("tested", …)
 * call was (or wasn't) chained onto the Supabase query builder.
 */

import { assert } from "jsr:@std/assert";
import { httpHandler, requestContext } from "./mcp.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

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
    single: rec("single"),
    delete: rec("delete"),
    insert: rec("insert"),
    update: rec("update"),
    then<T>(
      resolve: (v: { data: unknown; error: null }) => T,
      reject?: (e: unknown) => T,
    ) {
      return Promise.resolve({ data, error: null }).then(resolve, reject);
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
 */
function createMockDb(plan: Record<string, unknown[][]>) {
  const counters: Record<string, number> = {};
  const log: Array<{ table: string; builder: MockBuilder }> = [];

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
    _log: log,
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
  const injectDb = { supabase: db as unknown as SupabaseClient };

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
const FAKE_RECIPE_ID = "00000000-0000-4000-8000-000000000001";
const FAKE_LIST_ID   = "00000000-0000-4000-8000-000000000099";

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
