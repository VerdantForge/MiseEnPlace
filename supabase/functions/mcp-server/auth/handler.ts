import type { Context } from "hono";

import type {
  AuthorizationDetailsResponse,
  ConsentAction,
  ConsentResponse,
} from "./types.ts";

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

function buildSupabaseHeaders(request: Request) {
  const url = new URL(request.url);
  const headers = new Headers({
    accept: "application/json",
    apikey: getSupabaseAnonKey(),
    origin: url.origin,
    referer: request.url,
  });

  const cookie = request.headers.get("cookie");
  if (cookie) {
    headers.set("cookie", cookie);
  }

  const authorization = request.headers.get("authorization");
  if (authorization) {
    headers.set("authorization", authorization);
  }

  return headers;
}

async function fetchAuthorizationDetails(request: Request, authorizationId: string) {
  return fetch(
    `${getSupabaseAuthBaseUrl()}/oauth/authorizations/${encodeURIComponent(authorizationId)}`,
    {
      method: "GET",
      headers: buildSupabaseHeaders(request),
    },
  );
}

async function submitConsentDecision(
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

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Authorize ${escapeHtml(clientName)}</title>
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
      p, li { line-height: 1.6; }
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
    <main>
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
    </main>
  </body>
</html>`;
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

  if (!authorizationId) {
    return renderErrorPage("Missing authorization_id query parameter.");
  }

  try {
    const detailsResponse = await fetchAuthorizationDetails(c.req.raw, authorizationId);

    if (detailsResponse.status === 401 || detailsResponse.status === 403) {
      return renderErrorPage(
        "You must be signed in before you can approve this authorization request.",
        detailsResponse.status,
      );
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

    return c.html(renderAuthPage(data, c.req.url));
  } catch (error) {
    console.error("Failed to render authorization UI", error);
    return renderErrorPage("Failed to load authorization details.", 500);
  }
}

export async function handleAuthorizationDecision(c: Context) {
  try {
    const formData = await c.req.formData();
    const authorizationId = formData.get("authorization_id");
    const decision = formData.get("decision");

    if (typeof authorizationId !== "string" || !authorizationId) {
      return renderErrorPage("Missing authorization_id form field.");
    }

    if (decision !== "approve" && decision !== "deny") {
      return renderErrorPage("Decision must be approve or deny.");
    }

    const consentResponse = await submitConsentDecision(c.req.raw, authorizationId, decision);
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