# MCP Starter (Supabase Edge Functions)

Minimal MCP server built with mcp-lite and deployed as a Supabase Edge Function using Deno runtime.

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli/getting-started)
- [Deno](https://deno.land/) (required for Supabase Edge Functions)

## Getting Started

1. **Start local development**:
```bash
# Start Supabase services
supabase start
# Serve your MCP function locally
supabase functions serve --no-verify-jwt mcp-server
```

The function keeps Supabase's platform JWT check disabled and instead validates OAuth user access tokens inside the `/mcp` handler.

The MCP server will be available at:
- Main endpoint: `http://localhost:54321/functions/v1/mcp-server/mcp`
- Health check: `http://localhost:54321/functions/v1/mcp-server/health`

2. **Deploy to Supabase**:
```bash
supabase functions deploy --no-verify-jwt mcp-server
```

**Note: The authentication layer should be implemented on the MCP server. Please refer to MCP Authorization offical docs for more [information](https://modelcontextprotocol.io/specification/draft/basic/authorization)** 

## Project Structure

```
supabase/
├── functions/
│   └── mcp-server/
│       ├── index.ts           # Main MCP server
│       └── deno.json          # Deno configuration with imports
├── config.toml                # Supabase configuration
└── .env.local                 # Local environment variables (This file will be ignored by the .gitignore)
```

## Testing the Server

### Test MCP Protocol
```bash
curl -X POST \
  -H 'Authorization: Bearer <supabase-user-access-token>' \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"sum","arguments": {"a":2,"b":3}},"id":1}' \
  http://localhost:54321/functions/v1/mcp-server/mcp
```

Expected result

```json
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"5"}]}}
```

### Test Health Check
```bash
curl 'http://127.0.0.1:54321/functions/v1/mcp-server/health'
```

## Adding Tools

```typescript
mcp.tool("myTool", {
  description: "Description of what the tool does",
  inputSchema: z.object({
    param: z.string(),
  }),
  handler: (args: { param: string }) => ({
    content: [{ type: "text", text: `Result: ${args.param}` }],
  }),
});
```

## Deployment

1. **Deploy function**:
```bash
supabase functions deploy mcp-server
```

The deployed function expects `SUPABASE_URL` and `SUPABASE_ANON_KEY` to be available so it can validate incoming bearer tokens with Supabase Auth.

2. **Your MCP server will be available at**:
```
https://your-project-ref.supabase.co/functions/v1/mcp-server/mcp
```

## Resources

- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [MCP Lite](https://github.com/fiberplane/mcp-lite)
- [Hono on Deno](https://hono.dev/getting-started/deno)
- [Deno Runtime](https://deno.land/)
