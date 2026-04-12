import type { Hono } from "hono";

import {
  handleAuthorizationDecision,
  handleAuthorizationUi,
} from "./authorization-ui.ts";
import type { AuthAppVariables, ProtectedResourceMetadata } from "./types.ts";

const PUBLIC_FUNCTION_PREFIX = "/functions/v1";
const INTERNAL_FUNCTION_PREFIX = "/mcp-server";

function getPublicRequestUrl(request: Request) {
  const internalUrl = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedPort = request.headers.get("x-forwarded-port");
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const host = forwardedHost ?? request.headers.get("host");
  const protocol = forwardedProto ?? (origin ? new URL(origin).protocol.replace(/:$/, "") : internalUrl.protocol.replace(/:$/, ""));
  const publicPathname = internalUrl.pathname.startsWith(INTERNAL_FUNCTION_PREFIX)
    ? `${PUBLIC_FUNCTION_PREFIX}${internalUrl.pathname}`
    : internalUrl.pathname;

  if (origin) {
    return new URL(`${origin}${publicPathname}${internalUrl.search}`);
  }

  if (referer) {
    return new URL(`${new URL(referer).origin}${publicPathname}${internalUrl.search}`);
  }

  if (host) {
    const hostWithPort = forwardedPort && !host.includes(":")
      ? `${host}:${forwardedPort}`
      : host;

    return new URL(`${protocol}://${hostWithPort}${publicPathname}${internalUrl.search}`);
  }

  return new URL(`${internalUrl.origin}${publicPathname}${internalUrl.search}`);
}

function getSupabaseProjectUrl(request: Request) {
  return Deno.env.get("SUPABASE_URL") ?? getPublicRequestUrl(request).origin;
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

function createProtectedResourceMetadata(request: Request): ProtectedResourceMetadata {
  const requestUrl = getPublicRequestUrl(request).toString();
  const projectUrl = getSupabaseProjectUrl(request);

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
    return c.json(createProtectedResourceMetadata(c.req.raw));
  });

  app.get("/.well-known/oauth-protected-resource", (c) => {
    return c.json(createProtectedResourceMetadata(c.req.raw));
  });

  app.get("/auth/metadata", (c) => {
    return c.json(createProtectedResourceMetadata(c.req.raw));
  });

  app.get("/auth/.well-known/oauth-protected-resource", (c) => {
    return c.json(createProtectedResourceMetadata(c.req.raw));
  });

  app.get("/auth/authorize", handleAuthorizationUi);
  app.post("/auth/authorize", handleAuthorizationDecision);
}