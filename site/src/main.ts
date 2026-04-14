import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const SUPABASE_AUTH_BASE_URL = `${SUPABASE_URL}/auth/v1`;

// ---------------------------------------------------------------------------
// Types (mirroring the Supabase Auth OAuth API responses)
// ---------------------------------------------------------------------------

interface AuthorizationDetails {
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
  /** Present when the authorization is already approved — redirect immediately */
  redirect_url?: string;
}

interface ConsentResponse {
  redirect_url?: string;
}

type ConsentAction = "approve" | "deny";

// ---------------------------------------------------------------------------
// Supabase client (singleton)
// ---------------------------------------------------------------------------

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, storageKey: "mcp_auth" },
});

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const app = document.getElementById("app")!;

function setTitle(title: string) {
  document.title = `${title} — MiseEnPlace`;
}

function renderError(message: string) {
  setTitle("Error");
  app.innerHTML = `
    <p class="muted">MiseEnPlace MCP</p>
    <h1>Authorization error</h1>
    <p class="error">${escapeHtml(message)}</p>
  `;
}

function renderEnvError() {
  renderError(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. " +
    "Copy site/.env.example to site/.env and fill in the values.",
  );
}

function renderSignIn(authorizationId: string, errorMessage?: string) {
  setTitle("Sign in to continue");
  app.innerHTML = `
    <p class="muted">MiseEnPlace MCP · OAuth consent</p>
    <h1>Sign in to continue</h1>
    <p>Sign in with your Supabase account to review and approve this authorization request.</p>
    ${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ""}
    <form id="sign-in-form" class="stack-form">
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
      After sign-in, this page will resume the pending authorization request.
    </footer>
  `;

  document.getElementById("sign-in-form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const email = (form.elements.namedItem("email") as HTMLInputElement).value;
    const password = (form.elements.namedItem("password") as HTMLInputElement).value;
    handleSignIn(authorizationId, email, password);
  });
}

function renderConsent(details: AuthorizationDetails, authorizationId: string) {
  const scopes = details.scope?.split(/\s+/).filter(Boolean) ?? [];
  const clientName = details.client?.name ?? "Unknown application";
  const clientUri = details.client?.uri;
  const userEmail = details.user?.email ?? "Unknown user";
  const redirectUri = details.redirect_uri ?? "Unknown redirect URI";

  setTitle(`Authorize ${clientName}`);
  app.innerHTML = `
    <p class="muted">MiseEnPlace MCP · OAuth consent</p>
    <h1>Authorize ${escapeHtml(clientName)}</h1>
    <p>This application is requesting access to your MiseEnPlace MCP server through Supabase Auth.</p>
    <div id="consent-error"></div>
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
      <ul>
        ${scopes.length > 0
          ? scopes.map((s) => `<li>${escapeHtml(s)}</li>`).join("")
          : "<li>No scopes were requested.</li>"}
      </ul>
    </section>
    <form id="consent-form">
      <button type="submit" name="action" value="approve">Approve access</button>
      <button type="button" id="deny-btn">Deny</button>
    </form>
    <footer>
      This page delegates OAuth state handling to Supabase Auth.
    </footer>
  `;

  document.getElementById("consent-form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    handleConsent(authorizationId, "approve");
  });

  document.getElementById("deny-btn")!.addEventListener("click", () => {
    handleConsent(authorizationId, "deny");
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Auth actions
// ---------------------------------------------------------------------------

async function handleSignIn(authorizationId: string, email: string, password: string) {
  const submitBtn = app.querySelector<HTMLButtonElement>("button[type='submit']");
  if (submitBtn) submitBtn.disabled = true;

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    renderSignIn(authorizationId, error.message);
    return;
  }

  // Session is now stored by the SDK; re-run the flow
  await runFlow(authorizationId);
}

async function handleConsent(authorizationId: string, action: ConsentAction) {
  const errorEl = document.getElementById("consent-error");
  if (errorEl) errorEl.innerHTML = "";

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    await supabase.auth.signOut();
    renderSignIn(authorizationId, "Your session expired. Please sign in again.");
    return;
  }

  let response: Response;
  try {
    response = await fetch(
      `${SUPABASE_AUTH_BASE_URL}/oauth/authorizations/${encodeURIComponent(authorizationId)}/consent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
          "apikey": SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ action }),
      },
    );
  } catch {
    if (errorEl) errorEl.innerHTML = `<p class="error">Network error — could not reach Supabase Auth.</p>`;
    return;
  }

  if (response.status === 401 || response.status === 403) {
    await supabase.auth.signOut();
    renderSignIn(authorizationId, "Your session expired. Please sign in again.");
    return;
  }

  const data = await response.json() as ConsentResponse;

  if (!response.ok || !data.redirect_url) {
    const msg = "Supabase Auth could not process the consent decision.";
    if (errorEl) errorEl.innerHTML = `<p class="error">${escapeHtml(msg)}</p>`;
    return;
  }

  window.location.href = data.redirect_url;
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function runFlow(authorizationId: string) {
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    renderSignIn(authorizationId);
    return;
  }

  let response: Response;
  try {
    response = await fetch(
      `${SUPABASE_AUTH_BASE_URL}/oauth/authorizations/${encodeURIComponent(authorizationId)}`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
          "apikey": SUPABASE_ANON_KEY,
        },
      },
    );
  } catch {
    renderError("Network error — could not reach Supabase Auth.");
    return;
  }

  if (response.status === 401 || response.status === 403) {
    await supabase.auth.signOut();
    renderSignIn(authorizationId, "Your session expired. Please sign in again.");
    return;
  }

  if (!response.ok) {
    renderError(`Supabase Auth returned an unexpected error (HTTP ${response.status}).`);
    return;
  }

  const details = await response.json() as AuthorizationDetails;

  // Already approved — redirect immediately
  if (details.redirect_url) {
    window.location.href = details.redirect_url;
    return;
  }

  renderConsent(details, authorizationId);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    renderEnvError();
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const authorizationId = params.get("authorization_id");

  if (!authorizationId) {
    renderError("Missing authorization_id query parameter.");
    return;
  }

  runFlow(authorizationId);
}

main();
