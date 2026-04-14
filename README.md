# MCP Server on Supabase — Complete Demo

A minimal, end-to-end demonstration of deploying a production-ready [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server on [Supabase](https://supabase.com), covering all three layers that a real deployment requires:

| Layer | Technology |
|---|---|
| **Database** | Supabase Postgres with Row-Level Security — every query is scoped to the authenticated user |
| **MCP API** | [mcp-lite](https://github.com/fiberplane/mcp-lite) over Streamable HTTP, hosted as a Supabase Edge Function |
| **OAuth security** | Full [MCP Authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization) flow — protected-resource metadata (RFC 9728), Supabase Auth sign-in UI, JWT validation middleware |

This repo is intentionally kept small so the wiring between the three layers is easy to follow. The recipe CRUD tools are the running example, but the pattern applies to any data-backed MCP server.

---

## How it works

```
MCP client
  │
  ├─ GET /.well-known/oauth-protected-resource   ← RFC 9728 metadata
  ├─ GET /auth/authorize                         ← sign-in / consent UI (Supabase Auth)
  │
  └─ POST /mcp  (Bearer: <supabase-access-token>)
       │
       ├─ jwt-middleware.ts  validates token against Supabase Auth
       ├─ Supabase client created with user token → RLS enforced in Postgres
       └─ mcp-lite tools execute (listRecipes, createRecipe, …)
```

All of the above runs inside a single Supabase Edge Function (`mcp-server`).

---

## Project structure

```
supabase/
├── functions/
│   └── mcp-server/
│       ├── index.ts                        # Hono router — wires auth + MCP routes
│       ├── deno.json                       # Deno import map
│       ├── auth/
│       │   ├── jwt-middleware.ts           # Bearer-token validation (Supabase Auth)
│       │   ├── oauth-protected-resource.ts # RFC 9728 metadata endpoint
│       │   └── auth-ui.ts                  # Sign-in / consent UI + cookie handling
│       └── mcp/
│           └── mcp.ts                      # mcp-lite server + tool definitions
├── migrations/
│   └── 20260413000000_create_recipes.sql   # recipes table + RLS policies
└── config.toml
```

---

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli/getting-started)
- [Deno](https://deno.land/) (required for Edge Functions)
- Docker (used by `supabase start` for local Postgres)

---

## Local development

```bash
# 1. Start local Supabase (Postgres + Auth + Edge runtime)
supabase start

# 2. Serve the function (JWT verification is handled inside the function, not by the platform)
supabase functions serve --no-verify-jwt mcp-server
```

Set `MCP_SERVER_PUBLIC_URL` in `supabase/functions/.env` (or `.env.local`) if you need a non-default base URL:

```
MCP_SERVER_PUBLIC_URL=http://127.0.0.1:54321/functions/v1/mcp-server
```

**Endpoints** (local):

| Endpoint | Purpose |
|---|---|
| `GET /` | Service index |
| `GET /health` | Health check |
| `GET /.well-known/oauth-protected-resource` | OAuth metadata (RFC 9728) |
| `GET /auth/authorize` | Sign-in / consent UI |
| `POST /mcp` | MCP Streamable HTTP (requires Bearer token) |

---

## Deploy to Supabase Cloud

### 1. Link your project

```bash
supabase link --project-ref <your-project-ref>
```

Your project ref is the string in your Supabase dashboard URL: `app.supabase.com/project/<ref>`.

### 2. Apply the database migration

```bash
supabase db push
```

This creates the `recipes` table and RLS policies in your production Postgres instance.

### 3. Set production secrets

The `.env` file under `supabase/functions/mcp-server/` is **only used locally** — it is never deployed. Set both values as Supabase secrets instead:

```bash
supabase secrets set \
  MCP_SERVER_PUBLIC_URL=https://<project-ref>.supabase.co/functions/v1/mcp-server \
  MCP_AUTH_SERVER_URL=https://<project-ref>.supabase.co/auth/v1
```

`MCP_SERVER_PUBLIC_URL` is the single source of truth for every URL the function constructs (OAuth metadata, redirect URIs, cookie path). Once it starts with `https://`, the session cookies will automatically gain the `Secure` flag.

### 4. Configure Auth in the Supabase Dashboard

Go to **Authentication → URL Configuration** and add the following to **Additional Redirect URLs**:

```
https://<project-ref>.supabase.co/functions/v1/mcp-server/auth/authorize
```

Then go to **Authentication → OAuth Server** (enable it if it isn't already) and set:

| Setting | Value |
|---|---|
| Authorization URL path | `/functions/v1/mcp-server/auth/authorize` |
| Allow Dynamic Registration | ✓ enabled |

> **Note:** `supabase/config.toml` configures these settings for local development only. The production equivalents must be set in the dashboard.

### 5. Deploy the function

Commit `deno.lock` first (ensures reproducible Deno dependency resolution on the edge runtime), then deploy:

```bash
git add supabase/functions/mcp-server/deno.lock
git commit -m "chore: lock deno dependencies for deploy"

supabase functions deploy --no-verify-jwt mcp-server
```

`--no-verify-jwt` is intentional: Supabase's platform-level JWT check is bypassed because `auth/jwt-middleware.ts` handles authentication directly, which lets it return the RFC-compliant `WWW-Authenticate` header MCP clients expect.

### 6. Verify

```bash
# Health check
curl https://<project-ref>.supabase.co/functions/v1/mcp-server/health

# OAuth metadata — resource and authorization_servers should show production https:// URLs
curl https://<project-ref>.supabase.co/functions/v1/mcp-server/.well-known/oauth-protected-resource
```

Your MCP endpoint is at:

```
https://<project-ref>.supabase.co/functions/v1/mcp-server/mcp
```

---

## Testing

```bash
# OAuth metadata
curl http://127.0.0.1:54321/functions/v1/mcp-server/.well-known/oauth-protected-resource

# MCP tool call (requires a valid Supabase user access token)
curl -X POST \
  -H 'Authorization: Bearer <supabase-user-access-token>' \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"sum","arguments":{"a":2,"b":3}},"id":1}' \
  http://127.0.0.1:54321/functions/v1/mcp-server/mcp
# → {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"5"}]}}
```

---

## Adding your own tools

Edit `supabase/functions/mcp-server/mcp/mcp.ts`:

```typescript
mcp.tool("myTool", {
  description: "What this tool does",
  inputSchema: z.object({ param: z.string() }),
  handler: async (args) => {
    const db = getDb(); // user-scoped Supabase client, RLS enforced
    // ... query Postgres, call external APIs, etc.
    return { content: [{ type: "text", text: args.param }] };
  },
});
```

`getDb()` returns a Supabase client pre-loaded with the authenticated user's token, so every Postgres query automatically respects your RLS policies.

---

## Resources

- [MCP Authorization spec](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [RFC 9728 — OAuth Protected Resource Metadata](https://www.rfc-editor.org/rfc/rfc9728)
- [mcp-lite](https://github.com/fiberplane/mcp-lite)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Supabase Auth](https://supabase.com/docs/guides/auth)
