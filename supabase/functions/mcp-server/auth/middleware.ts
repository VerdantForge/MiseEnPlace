import type { MiddlewareHandler } from "hono";

import type { AuthAppVariables, TokenValidationResult } from "./types.ts";

type AuthMiddlewareOptions = {
  metadataUrl: (requestUrl: string) => string;
  requiredScope?: string;
};

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

    const user = (await response.json()) as AuthAppVariables["authUser"];

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

function buildChallenge(metadataUrl: string, requiredScope?: string): string {
  const challengeParts = [`resource_metadata="${metadataUrl}"`];

  if (requiredScope) {
    challengeParts.push(`scope="${requiredScope}"`);
  }

  return `Bearer ${challengeParts.join(", ")}`;
}

function unauthorizedResponse(
  message: string,
  requestUrl: string,
  metadataUrlBuilder: (requestUrl: string) => string,
  requiredScope?: string,
) {
  const headers = new Headers({
    "content-type": "application/json",
    "WWW-Authenticate": buildChallenge(metadataUrlBuilder(requestUrl), requiredScope),
  });

  return new Response(
    JSON.stringify({
      error: "unauthorized",
      message,
    }),
    {
      status: 401,
      headers,
    },
  );
}

export function createAuthMiddleware(
  options: AuthMiddlewareOptions,
): MiddlewareHandler<{ Variables: AuthAppVariables }> {
  return async (c, next) => {
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }

    const authorization = c.req.header("authorization");
    const requestUrl = c.req.url;

    if (!authorization?.startsWith("Bearer ")) {
      return unauthorizedResponse(
        "Missing bearer access token",
        requestUrl,
        options.metadataUrl,
        options.requiredScope,
      );
    }

    const accessToken = authorization.slice("Bearer ".length).trim();

    if (!accessToken) {
      return unauthorizedResponse(
        "Missing bearer access token",
        requestUrl,
        options.metadataUrl,
        options.requiredScope,
      );
    }

    const validationResult = await validateAccessToken(accessToken);

    if (!validationResult.ok) {
      if (validationResult.status === 401) {
        return unauthorizedResponse(
          validationResult.message,
          requestUrl,
          options.metadataUrl,
          options.requiredScope,
        );
      }

      return c.json(
        {
          error: "server_error",
          message: validationResult.message,
        },
        validationResult.status,
      );
    }

    c.set("authUser", validationResult.user);
    await next();
  };
}