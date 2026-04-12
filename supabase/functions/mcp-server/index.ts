// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

import { Hono } from "hono";
import { McpServer, StreamableHttpTransport } from "mcp-lite";
import { z } from "zod";

type SupabaseAuthUser = {
  id: string;
  aud?: string;
  email?: string | null;
  role?: string;
  [key: string]: unknown;
};

type TokenValidationResult =
  | { ok: true; user: SupabaseAuthUser }
  | { ok: false; status: 401 | 500; message: string };

// We create two Hono instances:
// 1. `app` is the root handler for the Supabase Edge Function (must match the function name, e.g. /mcp-server)
// 2. `mcpApp` handles the MCP protocol and health endpoints, mounted under the function route
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

const mcpApp = new Hono<{
  Variables: {
    authUser: SupabaseAuthUser;
  };
}>();

async function validateAccessToken(accessToken: string): Promise<TokenValidationResult> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY for token validation");
    return {
      ok: false,
      status: 500,
      message: "OAuth validation is not configured on this server",
    };
  }

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: supabaseAnonKey,
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        status: 401,
        message: "Invalid or expired access token",
      };
    }

    const user = (await response.json()) as SupabaseAuthUser;

    if (!user.id) {
      return {
        ok: false,
        status: 401,
        message: "Token did not resolve to a valid user",
      };
    }

    return { ok: true, user };
  } catch (error) {
    console.error("Failed to validate OAuth access token", error);
    return {
      ok: false,
      status: 500,
      message: "Failed to validate access token",
    };
  }
}

mcpApp.get("/", (c) => {
  return c.json({
    message: "MCP Server on Supabase Edge Functions",
    endpoints: {
      mcp: "/mcp",
      health: "/health",
    },
  });
});

mcpApp.get("/health", (c) => {
  return c.json({
    message: "Service is up and running",
  });
});

mcpApp.use("/mcp", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }

  const authorization = c.req.header("authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return c.json(
      {
        error: "unauthorized",
        message: "Missing bearer access token",
      },
      401,
    );
  }

  const accessToken = authorization.slice("Bearer ".length).trim();

  if (!accessToken) {
    return c.json(
      {
        error: "unauthorized",
        message: "Missing bearer access token",
      },
      401,
    );
  }

  const validationResult = await validateAccessToken(accessToken);

  if (!validationResult.ok) {
    return c.json(
      {
        error: validationResult.status === 401 ? "unauthorized" : "server_error",
        message: validationResult.message,
      },
      validationResult.status,
    );
  }

  c.set("authUser", validationResult.user);
  await next();
});



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
