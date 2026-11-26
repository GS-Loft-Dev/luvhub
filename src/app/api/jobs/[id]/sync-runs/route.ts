import { NextResponse } from "next/server";
import { HttpError, handle } from "@/lib/http";
import { GitHubError, dispatchWorkflow, githubConnection, listWorkflowRuns } from "@/lib/integrations/github";
import { requireJob } from "@/lib/require-job";
import { getSession } from "@/lib/session";
import { WORKFLOW_PATH } from "@/lib/sync/workflow";

export const dynamic = "force-dynamic";

const WORKFLOW_FILE = WORKFLOW_PATH.split("/").pop()!;

async function context(ctx: { params: Promise<{ id: string }> }) {
  const job = await requireJob(ctx);
  if (!job.automation) throw new HttpError(409, "Sync isn't on for this conversion.");
  const conn = await githubConnection(await getSession());
  if (!conn) throw new HttpError(401, "Connect GitHub to see the sync history.");
  return { automation: job.automation, conn };
}

const fromGitHub = (e: unknown): never => {
  throw new HttpError(e instanceof GitHubError ? (e.status === 401 ? 401 : 502) : 502, (e as Error).message);
};

/** The sync history: the latest runs of the luvhub workflow in the project's repository. */
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { automation, conn } = await context(ctx);
  const runs = await listWorkflowRuns(conn, automation.repo, WORKFLOW_FILE).catch(fromGitHub);
  return NextResponse.json({ repo: automation.repo, actionsUrl: automation.actionsUrl, runs });
});

/** Starts a sync now; `force` republishes even when nothing changed. */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { automation, conn } = await context(ctx);
  const body = (await req.json().catch(() => ({}))) as { force?: boolean };
  await dispatchWorkflow(conn, automation.repo, WORKFLOW_FILE, automation.branch, { force: body.force ? "true" : "false" }).catch(fromGitHub);
  return NextResponse.json({ ok: true });
});
