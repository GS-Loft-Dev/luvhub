import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { HttpError, handle } from "@/lib/http";
import {
  GitHubError,
  checkRepoName,
  dispatchWorkflow,
  getRepo,
  githubConnection,
  readFile,
  secretExists,
  setSecret,
  writeFile,
} from "@/lib/integrations/github";
import { connectionFromToken, HubSpotHttpError } from "@/lib/integrations/hubspot";
import { createEmbedUrl } from "@/lib/integrations/lovable";
import { saveJob } from "@/lib/jobs";
import { requireJob } from "@/lib/require-job";
import { getSession } from "@/lib/session";
import { CONFIG_FILE, configFromModel, parseConfig, serializeConfig, type LuvhubConfig } from "@/lib/sync/config";
import { LOVABLE_SECRET_NAME, SECRET_NAME, WORKFLOW_PATH, workflowYaml } from "@/lib/sync/workflow";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Body {
  repo: string;
  /** Published site address, for conversions made from a pasted URL. */
  url?: string;
  /** HubSpot private app token; optional when the repository already has the secret. */
  hubspotToken?: string;
  /** Lovable API key, for conversions made from a Lovable project; optional when the repository has it. */
  lovableKey?: string;
}

/**
 * Sets up the GitHub Action for this conversion: luvhub.json with the choices
 * made in the dashboard, the workflow, and the HubSpot token as an encrypted
 * secret. Adding the workflow starts the first sync; later edits in Lovable
 * (pushed to the same repository) start the next ones.
 */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const job = await requireJob(ctx);
  const conn = await githubConnection(await getSession());
  if (!conn) throw new HttpError(401, "Connect GitHub first.");
  const body = (await req.json()) as Body;
  const repo = checkRepoName(body.repo ?? "");

  const info = await getRepo(conn, repo).catch((e: unknown) => {
    throw new HttpError(e instanceof GitHubError ? e.status : 502, (e as Error).message);
  });
  if (!info.canPush) throw new HttpError(403, `Your GitHub account can't push to ${repo}.`);
  const branch = info.defaultBranch;

  // HubSpot token: checked against HubSpot before it is stored, and never kept by luvhub.
  const token = body.hubspotToken?.trim();
  let portalId: number | undefined;
  if (token) {
    try {
      portalId = (await connectionFromToken(token)).portalId;
    } catch (e) {
      const status = e instanceof HubSpotHttpError ? e.status : 0;
      throw new HttpError(400, status === 401 ? "HubSpot rejected that token. Copy it again from the private app." : `Couldn't check the HubSpot token: ${(e as Error).message}`);
    }
  } else if (!(await secretExists(conn, repo, SECRET_NAME))) {
    throw new HttpError(400, "Paste the HubSpot private app token: this repository doesn't have it yet.");
  }

  // Always Lovable's own render, the same one this conversion was made from:
  // the project's latest preview (every edit) or the published site.
  let source: LuvhubConfig["source"];
  const lovableKey = body.lovableKey?.trim();
  if (job.source.kind === "lovable" && job.source.projectId) {
    const parentOrigin = new URL(config.appUrl()).origin;
    if (!parentOrigin.startsWith("https://")) throw new HttpError(400, "Lovable previews only load on an HTTPS origin: set APP_URL to the public https:// address of this app.");
    source = { type: "lovable", projectId: job.source.projectId, parentOrigin };
    if (lovableKey) {
      await createEmbedUrl({ kind: "key", key: lovableKey }, job.source.projectId, parentOrigin).catch((e: unknown) => {
        throw new HttpError(400, `Lovable didn't accept that API key for this project: ${(e as Error).message}`);
      });
    } else if (!(await secretExists(conn, repo, LOVABLE_SECRET_NAME))) {
      throw new HttpError(400, "Paste a Lovable API key: this repository doesn't have it yet.");
    }
  } else {
    const url = (body.url ?? job.source.url ?? "").trim();
    if (!/^https:\/\//.test(url)) throw new HttpError(400, "Give the https:// address of the published Lovable site.");
    source = { type: "url", url };
  }

  // Keep what an earlier sync learnt (page ids, last sync) unless this conversion has newer ids.
  const next = configFromModel(job.model, source);
  const existing = await readFile(conn, repo, CONFIG_FILE, branch);
  if (existing) {
    try {
      const prev = parseConfig(existing.text);
      for (const [route, saved] of Object.entries(prev.pages)) {
        if (!next.pages[route]) continue;
        next.pages[route].hubspotPageId ??= saved.hubspotPageId;
      }
    } catch {
      // A broken file gets replaced.
    }
  }

  if (token) await setSecret(conn, repo, SECRET_NAME, token);
  if (lovableKey && source.type === "lovable") await setSecret(conn, repo, LOVABLE_SECRET_NAME, lovableKey);
  const wroteConfig = await writeFile(conn, repo, CONFIG_FILE, serializeConfig(next), "luvhub: sync settings for HubSpot", branch);
  const wroteWorkflow = await writeFile(
    conn,
    repo,
    WORKFLOW_PATH,
    workflowYaml({ branch, actionRef: config.github.actionRef(), configPath: CONFIG_FILE, hourly: source.type === "url" }),
    "luvhub: keep HubSpot in sync with this project",
    branch,
  );
  // A new or changed workflow file starts a run by itself (its push isn't on the ignore list).
  // Otherwise start one by hand, so the new settings reach HubSpot now.
  let started: "push" | "dispatch" = "push";
  if (!wroteWorkflow) {
    await dispatchWorkflow(conn, repo, "luvhub.yml", branch, { force: wroteConfig ? "true" : "false" });
    started = "dispatch";
  }

  const actionsUrl = `${info.htmlUrl}/actions/workflows/luvhub.yml`;
  job.automation = { repo, branch, source: source.type, at: new Date().toISOString(), actionsUrl };
  await saveJob(job);

  return NextResponse.json({
    repo,
    branch,
    started,
    portalId: portalId ?? null,
    actionsUrl,
    configUrl: `${info.htmlUrl}/blob/${encodeURIComponent(branch)}/${CONFIG_FILE}`,
  });
});
