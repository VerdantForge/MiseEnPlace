import { createClient } from "@supabase/supabase-js";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { Hono } from "hono";
import type { Context } from "hono";

import type { AuthAppVariables } from "./jwt-middleware.ts";

type AuthorizationDetailsResponse = {
  authorization_id?: string;
  redirect_uri?: string;
  client?: {
    id?: string;
    name?: string;
    uri?: string;
    logo_uri?: string;
  };
  user?: {
    id?: string;
    email?: string;
  };
  scope?: string;
  redirect_url?: string;
};

type ConsentAction = "approve" | "deny";

type ConsentResponse = {
  redirect_url?: string;
};

const ACCESS_TOKEN_COOKIE = "mcp_access_token";
const REFRESH_TOKEN_COOKIE = "mcp_refresh_token";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_ANON_KEY = requireEnv("SUPABASE_ANON_KEY");
const SUPABASE_AUTH_BASE_URL = `${SUPABASE_URL}/auth/v1`;

let _supabase: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
  if (!_supabase) {
    _supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
  }
  return _supabase;
}

function getCookieValue(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return null;

  for (const cookiePart of cookieHeader.split(";")) {
    const [cookieName, ...cookieValueParts] = cookiePart.trim().split("=");

    if (cookieName === name) {
      return cookieValueParts.join("=");
    }
  }

  return null;
}

function buildAuthorizeUrl(baseUrl: string, authorizationId: string) {
  return `${baseUrl}/auth/authorize?authorization_id=${encodeURIComponent(authorizationId)}`;
}

function fetchAuthorizationDetails(
  authorizationId: string,
  accessToken: string | null,
  cookieHeader: string | null,
) {
  const headers = new Headers({
    accept: "application/json",
    apikey: SUPABASE_ANON_KEY,
  });
  if (cookieHeader) headers.set("cookie", cookieHeader);
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);

  return fetch(
    `${SUPABASE_AUTH_BASE_URL}/oauth/authorizations/${encodeURIComponent(authorizationId)}`,
    { method: "GET", headers },
  );
}

function submitConsentDecision(
  authorizationId: string,
  action: ConsentAction,
  accessToken: string | null,
  cookieHeader: string | null,
) {
  const headers = new Headers({
    accept: "application/json",
    apikey: SUPABASE_ANON_KEY,
    "content-type": "application/json",
  });
  if (cookieHeader) headers.set("cookie", cookieHeader);
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);

  return fetch(
    `${SUPABASE_AUTH_BASE_URL}/oauth/authorizations/${encodeURIComponent(authorizationId)}/consent`,
    { method: "POST", headers, body: JSON.stringify({ action }) },
  );
}

function buildSetCookieValue(name: string, value: string, cookiePath: string, maxAge?: number, secure = false) {
  const cookieParts = [
    `${name}=${value}`,
    `Path=${cookiePath}`,
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (secure) {
    cookieParts.push("Secure");
  }

  if (typeof maxAge === "number") {
    cookieParts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  }

  return cookieParts.join("; ");
}

function applySessionCookies(response: Response, session: Session, cookiePath: string, secure: boolean) {
  response.headers.append(
    "set-cookie",
    buildSetCookieValue(ACCESS_TOKEN_COOKIE, session.access_token, cookiePath, session.expires_in, secure),
  );
  response.headers.append(
    "set-cookie",
    buildSetCookieValue(REFRESH_TOKEN_COOKIE, session.refresh_token, cookiePath, undefined, secure),
  );
}

function clearSessionCookies(response: Response, cookiePath: string, secure: boolean) {
  response.headers.append(
    "set-cookie",
    buildSetCookieValue(ACCESS_TOKEN_COOKIE, "", cookiePath, 0, secure),
  );
  response.headers.append(
    "set-cookie",
    buildSetCookieValue(REFRESH_TOKEN_COOKIE, "", cookiePath, 0, secure),
  );
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

async function handleAuthorizationUi(c: Context, baseUrl: string) {
  const authorizationId = c.req.query("authorization_id");

  if (!authorizationId) {
    return renderErrorPage("Missing authorization_id query parameter.");
  }

  const authorizeUrl = buildAuthorizeUrl(baseUrl, authorizationId);
  const cookiePath = new URL(baseUrl).pathname + "/auth";
  const secure = baseUrl.startsWith("https://");
  const cookieHeader = c.req.raw.headers.get("cookie");
  const authorization = c.req.raw.headers.get("authorization");
  const accessToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : getCookieValue(cookieHeader, ACCESS_TOKEN_COOKIE);

  try {
    const detailsResponse = await fetchAuthorizationDetails(authorizationId, accessToken, cookieHeader);

    if (detailsResponse.status === 401 || detailsResponse.status === 403) {
      const loginResponse = c.html(
        renderLoginPage(
          authorizationId,
          authorizeUrl,
          "Sign in first, then this authorization request will continue automatically.",
        ),
      );

      if (getCookieValue(cookieHeader, ACCESS_TOKEN_COOKIE) || getCookieValue(cookieHeader, REFRESH_TOKEN_COOKIE)) {
        clearSessionCookies(loginResponse, cookiePath, secure);
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

    return c.html(renderAuthPage(data, authorizeUrl));
  } catch (error) {
    console.error("Failed to render authorization UI", error);
    return renderErrorPage("Failed to load authorization details.", 500);
  }
}

async function handleAuthorizationDecision(c: Context, baseUrl: string) {
  try {
    const formData = await c.req.formData();
    const authorizationId = formData.get("authorization_id");
    const intent = formData.get("intent");

    if (typeof authorizationId !== "string" || !authorizationId) {
      return renderErrorPage("Missing authorization_id form field.");
    }

    const authorizeUrl = buildAuthorizeUrl(baseUrl, authorizationId);
    const cookiePath = new URL(baseUrl).pathname + "/auth";
    const secure = baseUrl.startsWith("https://");
    const cookieHeader = c.req.raw.headers.get("cookie");
    const authorization = c.req.raw.headers.get("authorization");
    const accessToken = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : getCookieValue(cookieHeader, ACCESS_TOKEN_COOKIE);

    if (intent === "sign_in") {
      const email = formData.get("email");
      const password = formData.get("password");

      if (typeof email !== "string" || !email || typeof password !== "string" || !password) {
        return c.html(
          renderLoginPage(
            authorizationId,
            authorizeUrl,
            "Email and password are required to continue.",
          ),
        );
      }

      const { data: signInData, error } = await getSupabaseClient().auth.signInWithPassword({ email, password });

      if (error || !signInData.session) {
        const message = error?.message ?? "Supabase Auth did not return a session.";
        return c.html(renderLoginPage(authorizationId, authorizeUrl, message));
      }

      const response = c.redirect(authorizeUrl, 302);
      applySessionCookies(response, signInData.session, cookiePath, secure);
      return response;
    }

    const decision = formData.get("decision");

    if (decision !== "approve" && decision !== "deny") {
      return renderErrorPage("Decision must be approve or deny.");
    }

    const consentResponse = await submitConsentDecision(authorizationId, decision, accessToken, cookieHeader);

    if (consentResponse.status === 401 || consentResponse.status === 403) {
      const loginResponse = c.html(
        renderLoginPage(
          authorizationId,
          authorizeUrl,
          "Your Supabase session expired. Sign in again to finish this authorization request.",
        ),
      );
      clearSessionCookies(loginResponse, cookiePath, secure);
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

export function createAuthUiApp(baseUrl: string) {
  const router = new Hono<{ Variables: AuthAppVariables }>();

  router.get("/authorize", (c) => handleAuthorizationUi(c, baseUrl));
  router.post("/authorize", (c) => handleAuthorizationDecision(c, baseUrl));

  return router;
}
