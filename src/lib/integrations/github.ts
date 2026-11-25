/**
 * GitHub client for setting up the sync: lists repositories, writes
 * luvhub.json and the workflow, stores the HubSpot token as an encrypted
 * Actions secret and starts runs.
 */
import sodium from "libsodium-wrappers";
import { config } from "../config";
import type { SessionData } from "../session";

const API = "https://api.github.com";
export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

export interface GitHubConnection {
  token: string;
  login: string;
}

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/vnd.github+json");
  headers.set("x-github-api-version", "2022-11-28");
  if (init.body) headers.set("content-type", "application/json");
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {
      // keep the raw text
    }
    const hint = res.status === 404 ? " (no access to this repository with the current GitHub login?)" : "";
    throw new GitHubError(res.status, `GitHub ${res.status}: ${message}${hint}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** OAuth session first; a server-wide token (LUVHUB_GITHUB_TOKEN) as a fallback. */
export async function githubConnection(session: SessionData): Promise<GitHubConnection | null> {
  if (session.github) return { token: session.github.accessToken, login: session.github.login };
  const token = config.github.token();
  if (!token) return null;
  return { token, login: (await api<{ login: string }>(token, "/user")).login };
}

export async function githubLogin(token: string): Promise<string> {
  return (await api<{ login: string }>(token, "/user")).login;
}

export interface RepoSummary {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  description: string | null;
}

/** Repositories the user can push to, most recently pushed first. */
export async function listRepos(conn: GitHubConnection): Promise<RepoSummary[]> {
  const repos = await api<
    { full_name: string; private: boolean; default_branch: string; pushed_at: string | null; description: string | null; permissions?: { push?: boolean } }[]
  >(conn.token, "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member");
  return repos
    .filter((r) => r.permissions?.push !== false)
    .map((r) => ({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, pushedAt: r.pushed_at, description: r.description }));
}

export function checkRepoName(repo: string): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new GitHubError(400, "Pick a repository like owner/name.");
  return repo;
}

export async function getRepo(conn: GitHubConnection, repo: string): Promise<{ defaultBranch: string; canPush: boolean; htmlUrl: string }> {
  const r = await api<{ default_branch: string; html_url: string; permissions?: { push?: boolean } }>(conn.token, `/repos/${checkRepoName(repo)}`);
  return { defaultBranch: r.default_branch, canPush: r.permissions?.push !== false, htmlUrl: r.html_url };
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Current text and sha of a file, or null when it doesn't exist. */
export async function readFile(conn: GitHubConnection, repo: string, path: string, branch: string): Promise<{ text: string; sha: string } | null> {
  try {
    const f = await api<{ content: string; sha: string; encoding: string }>(
      conn.token,
      `/repos/${checkRepoName(repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
    );
    return { text: Buffer.from(f.content, (f.encoding as BufferEncoding) || "base64").toString("utf8"), sha: f.sha };
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}

/** Creates or updates a file with one commit. Returns false when the content was already the same. */
export async function writeFile(
  conn: GitHubConnection,
  repo: string,
  path: string,
  text: string,
  message: string,
  branch: string,
): Promise<boolean> {
  const current = await readFile(conn, repo, path, branch);
  if (current?.text === text) return false;
  await api(conn.token, `/repos/${checkRepoName(repo)}/contents/${encodePath(path)}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: Buffer.from(text).toString("base64"), branch, ...(current ? { sha: current.sha } : {}) }),
  });
  return true;
}

export async function secretExists(conn: GitHubConnection, repo: string, name: string): Promise<boolean> {
  try {
    await api(conn.token, `/repos/${checkRepoName(repo)}/actions/secrets/${encodeURIComponent(name)}`);
    return true;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return false;
    throw e;
  }
}

/** Encrypts a value for a repository's Actions public key (libsodium sealed box), as GitHub requires. */
export async function sealSecret(value: string, publicKeyBase64: string): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  return sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(value), key), sodium.base64_variants.ORIGINAL);
}

export async function setSecret(conn: GitHubConnection, repo: string, name: string, value: string): Promise<void> {
  const r = checkRepoName(repo);
  const key = await api<{ key_id: string; key: string }>(conn.token, `/repos/${r}/actions/secrets/public-key`);
  await api(conn.token, `/repos/${r}/actions/secrets/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({ encrypted_value: await sealSecret(value, key.key), key_id: key.key_id }),
  });
}

/** Starts a workflow_dispatch run. A workflow file pushed seconds ago can take a moment to register. */
export async function dispatchWorkflow(conn: GitHubConnection, repo: string, workflowFile: string, ref: string, inputs: Record<string, string> = {}): Promise<void> {
  const path = `/repos/${checkRepoName(repo)}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`;
  for (let attempt = 0; ; attempt++) {
    try {
      await api(conn.token, path, { method: "POST", body: JSON.stringify({ ref, inputs }) });
      return;
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 404) || attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}
