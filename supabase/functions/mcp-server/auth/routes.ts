import type { Hono } from "hono";

import {
  handleAuthorizationDecision,
  handleAuthorizationUi,
} from "./handler.ts";
import type { AuthAppVariables, ProtectedResourceMetadata } from "./types.ts";

function getSupabaseProjectUrl(requestUrl: string) {
  return Deno.env.get("SUPABASE_URL") ?? new URL(requestUrl).origin;
}

function buildMcpResourceUrl(requestUrl: string) {
  return requestUrl
    .replace(/\/metadata$/, "/mcp")
    .replace(/\/.well-known\/oauth-protected-resource$/, "/mcp")
    .replace(/\/auth\/metadata$/, "/mcp")
    .replace(/\/auth\/.well-known\/oauth-protected-resource$/, "/mcp");
}

export function buildMetadataUrl(requestUrl: string) {
  return requestUrl
    .replace(/\/mcp$/, "/.well-known/oauth-protected-resource")
    .replace(/\/metadata$/, "/.well-known/oauth-protected-resource")
    .replace(/\/auth\/metadata$/, "/.well-known/oauth-protected-resource")
    .replace(/\/auth\/.well-known\/oauth-protected-resource$/, "/.well-known/oauth-protected-resource");
}

function buildResourceDocumentationUrl(requestUrl: string) {
  return requestUrl
    .replace(/\/metadata$/, "/")
    .replace(/\/.well-known\/oauth-protected-resource$/, "/")
    .replace(/\/auth\/metadata$/, "/")
    .replace(/\/auth\/.well-known\/oauth-protected-resource$/, "/");
}

function createProtectedResourceMetadata(requestUrl: string): ProtectedResourceMetadata {
  const projectUrl = getSupabaseProjectUrl(requestUrl);

  return {
    resource: buildMcpResourceUrl(requestUrl),
    authorization_servers: [`${projectUrl}/auth/v1`],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "email", "profile", "phone"],
    resource_name: "MiseEnPlace MCP Server",
    resource_documentation: buildResourceDocumentationUrl(requestUrl),
  };
}

export function registerAuthRoutes(app: Hono<{ Variables: AuthAppVariables }>) {
  app.get("/metadata", (c) => {
    return c.json(createProtectedResourceMetadata(c.req.url));
  });

  app.get("/.well-known/oauth-protected-resource", (c) => {
    return c.json(createProtectedResourceMetadata(c.req.url));
  });

  app.get("/auth/metadata", (c) => {
    return c.json(createProtectedResourceMetadata(c.req.url));
  });

  app.get("/auth/.well-known/oauth-protected-resource", (c) => {
    return c.json(createProtectedResourceMetadata(c.req.url));
  });

  app.get("/auth/authorize", handleAuthorizationUi);
  app.post("/auth/authorize", handleAuthorizationDecision);
}