/** Reads configuration from the environment. Server-only. */

import { randomBytes } from "node:crypto";

const env = (name: string, fallback = ""): string => process.env[name]?.trim() || fallback;

/**
 * Local development works without any setup: when SESSION_SECRET is missing
 * outside production, a random secret is made once per dev server (kept on
 * globalThis so hot reloads don't log everyone out). Production still requires it.
 */
function devSecret(): string {
  const g = globalThis as { __luvhubDevSecret?: string };
  if (!g.__luvhubDevSecret) {
    g.__luvhubDevSecret = randomBytes(32).toString("base64url");
    console.warn("[luvhub] SESSION_SECRET is not set: using a temporary secret for development. Set it in .env.local to keep logins across restarts.");
  }
  return g.__luvhubDevSecret;
}

export const config = {
  // On Netlify, URL is the primary site URL (https) and is available to functions.
  appUrl: () => env("APP_URL", env("URL", "http://localhost:3000")).replace(/\/$/, ""),
  dataDir: () => env("DATA_DIR", "./.data"),
  sessionSecret: () => {
    const s = env("SESSION_SECRET");
    if (s.length >= 32) return s;
    if (process.env.NODE_ENV !== "production" && !s) return devSecret();
    throw new Error("SESSION_SECRET must be set to at least 32 characters.");
  },

  lovable: {
    apiBase: () => env("LOVABLE_API_BASE", "https://api.lovable.dev").replace(/\/$/, ""),
    apiKey: () => env("LOVABLE_API_KEY"),
    clientId: () => env("LOVABLE_CLIENT_ID"),
    clientSecret: () => env("LOVABLE_CLIENT_SECRET"),
    authorizeUrl: () => env("LOVABLE_AUTHORIZE_URL"),
    tokenUrl: () => env("LOVABLE_TOKEN_URL"),
    scopes: () => env("LOVABLE_SCOPES", "projects:read workspaces:read"),
    oauthEnabled: () => Boolean(env("LOVABLE_CLIENT_ID") && env("LOVABLE_AUTHORIZE_URL") && env("LOVABLE_TOKEN_URL")),
  },

  hubspot: {
    clientId: () => env("HUBSPOT_CLIENT_ID"),
    clientSecret: () => env("HUBSPOT_CLIENT_SECRET"),
    scopes: () => env("HUBSPOT_SCOPES", "oauth content files"),
    accessToken: () => env("HUBSPOT_ACCESS_TOKEN"),
    sourceCodeBase: () => env("HUBSPOT_SOURCE_CODE_BASE", "/cms/v3/source-code"),
    oauthEnabled: () => Boolean(env("HUBSPOT_CLIENT_ID") && env("HUBSPOT_CLIENT_SECRET")),
  },
};

/** What the UI may know about the server setup (no secrets). */
export function publicSetup() {
  return {
    lovableOAuth: config.lovable.oauthEnabled(),
    lovableApiKey: Boolean(config.lovable.apiKey()),
    hubspotOAuth: config.hubspot.oauthEnabled(),
    hubspotToken: Boolean(config.hubspot.accessToken()),
    embedAvailable: config.appUrl().startsWith("https://"),
  };
}
