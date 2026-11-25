import { NextResponse } from "next/server";
import { HttpError, handle } from "@/lib/http";
import { checkRepoName, githubConnection, secretExists } from "@/lib/integrations/github";
import { getSession } from "@/lib/session";
import { SECRET_NAME } from "@/lib/sync/workflow";

export const dynamic = "force-dynamic";

/** Whether the repository already holds the HubSpot token secret (its value is never readable). */
export const GET = handle(async (req: Request) => {
  const conn = await githubConnection(await getSession());
  if (!conn) throw new HttpError(401, "Connect GitHub first.");
  const repo = checkRepoName(new URL(req.url).searchParams.get("repo") ?? "");
  return NextResponse.json({ name: SECRET_NAME, exists: await secretExists(conn, repo, SECRET_NAME) });
});
