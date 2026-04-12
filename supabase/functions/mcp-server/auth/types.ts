export type SupabaseAuthUser = {
  id: string;
  aud?: string;
  email?: string | null;
  role?: string;
  [key: string]: unknown;
};

export type TokenValidationResult =
  | { ok: true; user: SupabaseAuthUser }
  | { ok: false; status: 401 | 500; message: string };

export type AuthAppVariables = {
  authUser: SupabaseAuthUser;
};

export type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: ["header"];
  scopes_supported: string[];
  resource_name: string;
  resource_documentation?: string;
};

export type AuthorizationDetailsResponse = {
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

export type ConsentAction = "approve" | "deny";

export type ConsentResponse = {
  redirect_url?: string;
};