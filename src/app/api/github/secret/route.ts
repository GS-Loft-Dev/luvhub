import { NextResponse } from "next/server";
import { HttpError, handle } from "@/lib/http";
import { checkRepoName, githubConnection, secretExists } from "@/lib/integrations/github";
import { getSession } from "@/lib/session";
import { LOVABLE_SECRET_NAME, SECRET_NAME } from "@/lib/sync/workflow";

export const dynamic = "force-dynamic";

/** Whether the repository already holds the HubSpot token and Lovable key secrets (their values are never readable). */
export const GET = handle(async (req: Request) => {
  const conn = await githubConnection(await getSession());
  if (!conn) throw new HttpError(401, "Connect GitHub first.");
  const repo = checkRepoName(new URL(req.url).searchParams.get("repo") ?? "");
  const [exists, lovable] = await Promise.all([secretExists(conn, repo, SECRET_NAME), secretExists(conn, repo, LOVABLE_SECRET_NAME)]);
  return NextResponse.json({ name: SECRET_NAME, exists, lovable });
});
