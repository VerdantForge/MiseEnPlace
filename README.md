# MCP Server on Supabase — Complete Demo

A minimal, end-to-end demonstration of deploying a production-ready [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server on [Supabase](https://supabase.com), covering all three layers that a real deployment requires:

| Layer | Technology |
|---|---|
| **Database** | Supabase Postgres with Row-Level Security — every query is scoped to the authenticated user |
| **MCP API** | [mcp-lite](https://github.com/fiberplane/mcp-lite) over Streamable HTTP, hosted as a Supabase Edge Function |
| **OAuth security** | Full [MCP Authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization) flow — protected-resource metadata (RFC 9728), static sign-in/consent UI on Netlify, JWT validation middleware |
| **Auth UI** | Vite + TypeScript static site hosted on Netlify CDN — calls Supabase Auth APIs directly from the browser |

This repo is intentionally kept small so the wiring between the three layers is easy to follow. The recipe CRUD tools are the running example, but the pattern applies to any data-backed MCP server.

---

## How it works

```
MCP client
  │
  ├─ GET /.well-known/oauth-protected-resource   ← RFC 9728 metadata (Edge Function)
  ├─ GET https://<netlify-site>/authorize        ← sign-in / consent UI (Netlify CDN)
  │        │
  │        ├─ supabase.auth.signInWithPassword() ← direct browser → Supabase Auth
  │        ├─ GET  /auth/v1/oauth/authorizations/{id}          ← browser → Supabase Auth
  │        └─ POST /auth/v1/oauth/authorizations/{id}/consent  ← browser → Supabase Auth
  │
  └─ POST /mcp  (Bearer: <supabase-access-token>)
       │
       ├─ jwt-middleware.ts  validates token against Supabase Auth
       ├─ Supabase client created with user token → RLS enforced in Postgres
       └─ mcp-lite tools execute (listRecipes, createRecipe, …)
```

The Edge Function handles MCP protocol and OAuth metadata only. The sign-in/consent UI is a
pure static Vite + TypeScript site (in `site/`) deployed to Netlify. It calls Supabase Auth
directly from the browser — no proxy needed.

---

## Project structure

```
site/                                       # Netlify static auth UI (Vite + TypeScript)
├── src/
│   ├── main.ts                             # Sign-in / consent page logic
│   └── styles.css                          # Warm, earthy design
├── index.html
├── package.json
├── vite.config.ts
└── tsconfig.json
supabase/
├── functions/
│   └── mcp-server/
│       ├── index.ts                        # Hono router — wires auth metadata + MCP routes
│       ├── deno.json                       # Deno import map
│       ├── auth/
│       │   ├── jwt-middleware.ts           # Bearer-token validation (Supabase Auth)
│       │   └── oauth-protected-resource.ts # RFC 9728 metadata endpoint
│       └── mcp/
│           └── mcp.ts                      # mcp-lite server + tool definitions
├── migrations/
│   └── 20260413000000_create_recipes.sql   # recipes table + RLS policies
└── config.toml
netlify.toml                                # Netlify build config (builds site/)
```

---

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli/getting-started)
- [Deno](https://deno.land/) (required for Edge Functions)
- [Node.js](https://nodejs.org/) v18+ (required for the Vite auth UI in `site/`)
- Docker (used by `supabase start` for local Postgres)

---

## Local development

```bash
# 1. Start local Supabase (Postgres + Auth + Edge runtime)
supabase start

# 2. Serve the edge function
supabase functions serve --no-verify-jwt mcp-server

# 3. In a separate terminal, start the auth UI dev server
cd site
npm install
npm run dev   # → http://localhost:5173/authorize?authorization_id=<id>
```

Copy `site/.env.example` to `site/.env` and fill in your local Supabase credentials:

```
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<your-local-anon-key>
```

Set `MCP_SERVER_PUBLIC_URL` in `supabase/functions/.env` if you need a non-default base URL:

```
MCP_SERVER_PUBLIC_URL=http://127.0.0.1:54321/functions/v1/mcp-server
```

**Edge Function endpoints** (local):

| Endpoint | Purpose |
|---|---|
| `GET /` | Service index |
| `GET /health` | Health check |
| `GET /.well-known/oauth-protected-resource` | OAuth metadata (RFC 9728) |
| `POST /mcp` | MCP Streamable HTTP (requires Bearer token) |

The sign-in/consent UI is served by `npm run dev` in `site/` (or Netlify in production), not by the edge function.

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

### 3. Deploy the auth UI to Netlify

Make sure the `site/` directory is committed to your repository — Netlify clones the repo fresh on every build and will fail if the directory is missing:

```bash
git add site/
git commit -m "feat: add Netlify auth UI"
git push
```

Connect your repo to Netlify. Netlify will auto-detect `netlify.toml` and build `site/` on every push.

In the Netlify dashboard under **Site configuration → Environment variables**, set:

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Your Supabase project's `anon` public key |

Note the Netlify site URL (e.g. `https://<site-name>.netlify.app`) — you will need it in the next step.

### 4. Set production secrets

The `.env` file under `supabase/functions/mcp-server/` is **only used locally** — it is never deployed. Set the required values as Supabase secrets instead:

```bash
supabase secrets set \
  MCP_SERVER_PUBLIC_URL=https://<project-ref>.supabase.co/functions/v1/mcp-server \
  MCP_AUTH_SERVER_URL=https://<project-ref>.supabase.co/auth/v1 \
  MCP_AUTH_UI_URL=https://<site-name>.netlify.app
```

`MCP_SERVER_PUBLIC_URL` is the single source of truth for every URL the function constructs (OAuth metadata, resource identifier). `MCP_AUTH_UI_URL` tells the `/auth/authorize` redirect stub where to send the browser after Supabase Auth hands off the flow.

### 5. Configure Auth in the Supabase Dashboard

#### URL Configuration

Go to **Authentication → URL Configuration** and set:

| Setting | Value |
|---|---|
| **Site URL** | `https://<site-name>.netlify.app` |
| **Redirect URLs** | Add your MCP client callback URLs (e.g. `http://localhost:6274/oauth/callback`) |

This is required so Supabase Auth trusts requests that originate from the Netlify domain. Without it, the browser's direct calls to `/auth/v1/oauth/authorizations/*` will be rejected with `"unauthorized request origin"`.

#### OAuth Server

Go to **Authentication → OAuth Server** (enable it if it isn't already) and set:

| Setting | Value |
|---|---|
| Authorization URL | `/functions/v1/mcp-server/auth/authorize` |
| Allow Dynamic Registration | ✓ enabled |

> **Note:** `supabase/config.toml` configures these settings for local development only. The production equivalents must be set in the dashboard.

### 6. Deploy the function

Commit `deno.lock` first (ensures reproducible Deno dependency resolution on the edge runtime), then deploy:

```bash
git add supabase/functions/mcp-server/deno.lock
git commit -m "chore: lock deno dependencies for deploy"

supabase functions deploy --no-verify-jwt mcp-server
```

`--no-verify-jwt` is intentional: Supabase's platform-level JWT check is bypassed because `auth/jwt-middleware.ts` handles authentication directly, which lets it return the RFC-compliant `WWW-Authenticate` header MCP clients expect.

### 7. Verify

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
