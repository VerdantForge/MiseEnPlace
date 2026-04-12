import type { Context } from "hono";

import type {
  AuthorizationDetailsResponse,
  ConsentAction,
  ConsentResponse,
} from "./types.ts";

const ACCESS_TOKEN_COOKIE = "mcp_access_token";
const REFRESH_TOKEN_COOKIE = "mcp_refresh_token";
const AUTH_COOKIE_PATH = "/functions/v1/mcp-server/auth";
const PUBLIC_FUNCTION_PREFIX = "/functions/v1";
const INTERNAL_FUNCTION_PREFIX = "/mcp-server";

type SupabaseSessionResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
  msg?: string;
  message?: string;
};

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

function getSupabaseAuthBaseUrl() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");

  if (!supabaseUrl) {
    throw new Error("SUPABASE_URL is required to render the authorization UI");
  }

  return `${supabaseUrl}/auth/v1`;
}

function getSupabaseAnonKey() {
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseAnonKey) {
    throw new Error("SUPABASE_ANON_KEY is required to render the authorization UI");
  }

  return supabaseAnonKey;
}

function getCookieValue(request: Request, name: string) {
  const cookieHeader = request.headers.get("cookie");

  if (!cookieHeader) {
    return null;
  }

  for (const cookiePart of cookieHeader.split(";")) {
    const [cookieName, ...cookieValueParts] = cookiePart.trim().split("=");

    if (cookieName === name) {
      return cookieValueParts.join("=");
    }
  }

  return null;
}

function getAccessToken(request: Request) {
  const authorization = request.headers.get("authorization");

  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  return getCookieValue(request, ACCESS_TOKEN_COOKIE);
}

function buildSupabaseHeaders(
  request: Request,
  options?: {
    accessToken?: string | null;
    includeCookies?: boolean;
    includeAuthorization?: boolean;
  },
) {
  const publicUrl = getPublicRequestUrl(request);
  const headers = new Headers({
    accept: "application/json",
    apikey: getSupabaseAnonKey(),
    origin: publicUrl.origin,
    referer: publicUrl.toString(),
  });

  const includeCookies = options?.includeCookies ?? true;
  const includeAuthorization = options?.includeAuthorization ?? true;

  const cookie = request.headers.get("cookie");
  if (includeCookies && cookie) {
    headers.set("cookie", cookie);
  }

  const accessToken = options?.accessToken ?? getAccessToken(request);
  if (includeAuthorization && accessToken) {
    headers.set("authorization", `Bearer ${accessToken}`);
  }

  return headers;
}

function fetchAuthorizationDetails(request: Request, authorizationId: string) {
  return fetch(
    `${getSupabaseAuthBaseUrl()}/oauth/authorizations/${encodeURIComponent(authorizationId)}`,
    {
      method: "GET",
      headers: buildSupabaseHeaders(request),
    },
  );
}

function submitConsentDecision(
  request: Request,
  authorizationId: string,
  action: ConsentAction,
) {
  const headers = buildSupabaseHeaders(request);
  headers.set("content-type", "application/json");

  return fetch(
    `${getSupabaseAuthBaseUrl()}/oauth/authorizations/${encodeURIComponent(authorizationId)}/consent`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ action }),
    },
  );
}

function signInWithPassword(request: Request, email: string, password: string) {
  const headers = buildSupabaseHeaders(request, {
    includeCookies: false,
    includeAuthorization: false,
  });
  headers.set("content-type", "application/json");

  return fetch(`${getSupabaseAuthBaseUrl()}/token?grant_type=password`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password }),
  });
}

function buildSetCookieValue(name: string, value: string, maxAge?: number) {
  const cookieParts = [
    `${name}=${value}`,
    `Path=${AUTH_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (typeof maxAge === "number") {
    cookieParts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  }

  return cookieParts.join("; ");
}

function applySessionCookies(response: Response, session: SupabaseSessionResponse) {
  if (session.access_token) {
    response.headers.append(
      "set-cookie",
      buildSetCookieValue(ACCESS_TOKEN_COOKIE, session.access_token, session.expires_in),
    );
  }

  if (session.refresh_token) {
    response.headers.append(
      "set-cookie",
      buildSetCookieValue(REFRESH_TOKEN_COOKIE, session.refresh_token),
    );
  }
}

function clearSessionCookies(response: Response) {
  response.headers.append(
    "set-cookie",
    buildSetCookieValue(ACCESS_TOKEN_COOKIE, "", 0),
  );
  response.headers.append(
    "set-cookie",
    buildSetCookieValue(REFRESH_TOKEN_COOKIE, "", 0),
  );
}

async function readAuthError(response: Response, fallbackMessage: string) {
  try {
    const payload = (await response.json()) as SupabaseSessionResponse;
    return payload.error_description ?? payload.message ?? payload.msg ?? payload.error ?? fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPage(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Georgia, serif;
        --bg: #f3eee7;
        --card: #fffaf4;
        --ink: #2c241b;
        --muted: #6b5c4b;
        --accent: #8b5e3c;
        --border: #d8c7b5;
        --danger: #8f2d2d;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top, rgba(139, 94, 60, 0.16), transparent 35%),
          linear-gradient(180deg, #efe5d7 0%, var(--bg) 100%);
        color: var(--ink);
      }
      main {
        width: min(720px, calc(100vw - 2rem));
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 24px;
        padding: 2rem;
        box-shadow: 0 24px 80px rgba(75, 54, 35, 0.12);
      }
      h1 {
        margin: 0 0 0.5rem;
        font-size: clamp(2rem, 3vw, 2.8rem);
      }
      h2 {
        margin: 0 0 0.75rem;
        font-size: 1.2rem;
      }
      p, li, label { line-height: 1.6; }
      .muted { color: var(--muted); }
      .error {
        border: 1px solid rgba(143, 45, 45, 0.2);
        background: rgba(143, 45, 45, 0.08);
        color: var(--danger);
        padding: 0.75rem 1rem;
        border-radius: 12px;
      }
      dl {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 0.75rem 1rem;
        margin: 1.5rem 0;
      }
      dt { font-weight: 700; }
      dd { margin: 0; word-break: break-word; }
      ul { margin: 0; padding-left: 1.25rem; }
      form {
        display: flex;
        flex-wrap: wrap;
        gap: 1rem;
        margin-top: 2rem;
      }
      .stack-form {
        flex-direction: column;
        align-items: stretch;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }
      input {
        border: 1px solid var(--border);
        border-radius: 14px;
        background: #fff;
        color: var(--ink);
        font: inherit;
        padding: 0.85rem 1rem;
      }
      button {
        appearance: none;
        border: 1px solid var(--border);
        border-radius: 999px;
        background: transparent;
        color: var(--ink);
        cursor: pointer;
        font: inherit;
        padding: 0.85rem 1.35rem;
      }
      button[type="submit"],
      button[type="submit"][value="approve"] {
        background: var(--accent);
        color: #fffaf4;
        border-color: var(--accent);
      }
      footer {
        margin-top: 1.5rem;
        font-size: 0.92rem;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main>${body}</main>
  </body>
</html>`;
}

function renderAuthPage(
  data: AuthorizationDetailsResponse,
  requestUrl: string,
  errorMessage?: string,
) {
  const scopes = data.scope?.split(/\s+/).filter(Boolean) ?? [];
  const clientName = data.client?.name ?? "Unknown application";
  const clientUri = data.client?.uri;
  const userEmail = data.user?.email ?? "Unknown user";
  const redirectUri = data.redirect_uri ?? "Unknown redirect URI";
  const authorizationId = data.authorization_id ?? "";

  const scopeMarkup = scopes.length > 0
    ? scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("")
    : "<li>No scopes were requested.</li>";

  const errorMarkup = errorMessage
    ? `<p class="error">${escapeHtml(errorMessage)}</p>`
    : "";

  return renderPage(
    `Authorize ${clientName}`,
    `
      <p class="muted">Supabase OAuth consent</p>
      <h1>Authorize ${escapeHtml(clientName)}</h1>
      <p>This application is requesting access to your MiseEnPlace MCP server through Supabase Auth.</p>
      ${errorMarkup}
      <dl>
        <dt>Signed in as</dt>
        <dd>${escapeHtml(userEmail)}</dd>
        <dt>Redirect URI</dt>
        <dd>${escapeHtml(redirectUri)}</dd>
        <dt>Application URL</dt>
        <dd>${clientUri ? escapeHtml(clientUri) : "Not provided"}</dd>
      </dl>
      <section>
        <h2>Requested scopes</h2>
        <ul>${scopeMarkup}</ul>
      </section>
      <form method="post" action="${escapeHtml(requestUrl)}">
        <input type="hidden" name="authorization_id" value="${escapeHtml(authorizationId)}" />
        <button type="submit" name="decision" value="approve">Approve access</button>
        <button type="submit" name="decision" value="deny">Deny</button>
      </form>
      <footer>
        This page is served by the MCP edge function and delegates OAuth state handling to Supabase Auth.
      </footer>
    `,
  );
}

function renderLoginPage(
  authorizationId: string,
  requestUrl: string,
  errorMessage?: string,
) {
  const errorMarkup = errorMessage
    ? `<p class="error">${escapeHtml(errorMessage)}</p>`
    : "";

  return renderPage(
    "Sign In To Continue",
    `
      <p class="muted">Supabase OAuth consent</p>
      <h1>Sign in to continue</h1>
      <p>This authorization request needs an authenticated Supabase user session before consent can be shown.</p>
      ${errorMarkup}
      <form method="post" action="${escapeHtml(requestUrl)}" class="stack-form">
        <input type="hidden" name="intent" value="sign_in" />
        <input type="hidden" name="authorization_id" value="${escapeHtml(authorizationId)}" />
        <label class="field">
          <span>Email</span>
          <input type="email" name="email" autocomplete="email" required />
        </label>
        <label class="field">
          <span>Password</span>
          <input type="password" name="password" autocomplete="current-password" required />
        </label>
        <button type="submit">Sign in</button>
      </form>
      <footer>
        After sign-in, this page will resume the pending authorization request using the same authorization_id.
      </footer>
    `,
  );
}

function renderErrorPage(message: string, status = 400) {
  return new Response(
    `<!doctype html><html lang="en"><body><h1>Authorization error</h1><p>${escapeHtml(message)}</p></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    },
  );
}

export async function handleAuthorizationUi(c: Context) {
  const authorizationId = c.req.query("authorization_id");
  const publicRequestUrl = getPublicRequestUrl(c.req.raw).toString();

  if (!authorizationId) {
    return renderErrorPage("Missing authorization_id query parameter.");
  }

  try {
    const detailsResponse = await fetchAuthorizationDetails(c.req.raw, authorizationId);

    if (detailsResponse.status === 401 || detailsResponse.status === 403) {
      const loginResponse = c.html(
        renderLoginPage(
          authorizationId,
          publicRequestUrl,
          "Sign in first, then this authorization request will continue automatically.",
        ),
      );

      if (getCookieValue(c.req.raw, ACCESS_TOKEN_COOKIE) || getCookieValue(c.req.raw, REFRESH_TOKEN_COOKIE)) {
        clearSessionCookies(loginResponse);
      }

      return loginResponse;
    }

    const data = (await detailsResponse.json()) as AuthorizationDetailsResponse;

    if (!detailsResponse.ok) {
      return renderErrorPage(
        "Supabase Auth rejected the authorization details request.",
        detailsResponse.status,
      );
    }

    if (data.redirect_url) {
      return c.redirect(data.redirect_url, 302);
    }

    return c.html(renderAuthPage(data, publicRequestUrl));
  } catch (error) {
    console.error("Failed to render authorization UI", error);
    return renderErrorPage("Failed to load authorization details.", 500);
  }
}

export async function handleAuthorizationDecision(c: Context) {
  try {
    const formData = await c.req.formData();
    const publicRequestUrl = getPublicRequestUrl(c.req.raw).toString();
    const authorizationId = formData.get("authorization_id");
    const intent = formData.get("intent");

    if (typeof authorizationId !== "string" || !authorizationId) {
      return renderErrorPage("Missing authorization_id form field.");
    }

    if (intent === "sign_in") {
      const email = formData.get("email");
      const password = formData.get("password");

      if (typeof email !== "string" || !email || typeof password !== "string" || !password) {
        return c.html(
          renderLoginPage(
            authorizationId,
            publicRequestUrl,
            "Email and password are required to continue.",
          ),
        );
      }

      const signInResponse = await signInWithPassword(c.req.raw, email, password);

      if (!signInResponse.ok) {
        const message = await readAuthError(
          signInResponse,
          "Supabase Auth rejected the sign-in attempt.",
        );

        return c.html(renderLoginPage(authorizationId, publicRequestUrl, message));
      }

      const session = (await signInResponse.json()) as SupabaseSessionResponse;

      if (!session.access_token) {
        return c.html(
          renderLoginPage(
            authorizationId,
            publicRequestUrl,
            "Supabase Auth did not return an access token.",
          ),
        );
      }

      const response = c.redirect(publicRequestUrl, 302);
      applySessionCookies(response, session);
      return response;
    }

    const decision = formData.get("decision");

    if (decision !== "approve" && decision !== "deny") {
      return renderErrorPage("Decision must be approve or deny.");
    }

    const consentResponse = await submitConsentDecision(c.req.raw, authorizationId, decision);

    if (consentResponse.status === 401 || consentResponse.status === 403) {
      const loginResponse = c.html(
        renderLoginPage(
          authorizationId,
          publicRequestUrl,
          "Your Supabase session expired. Sign in again to finish this authorization request.",
        ),
      );
      clearSessionCookies(loginResponse);
      return loginResponse;
    }

    const data = (await consentResponse.json()) as ConsentResponse;

    if (!consentResponse.ok || !data.redirect_url) {
      return renderErrorPage(
        "Supabase Auth could not process the consent decision.",
        consentResponse.status,
      );
    }

    return c.redirect(data.redirect_url, 302);
  } catch (error) {
    console.error("Failed to submit authorization decision", error);
    return renderErrorPage("Failed to submit consent decision.", 500);
  }
}