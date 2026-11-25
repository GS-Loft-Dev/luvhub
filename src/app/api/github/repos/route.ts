import { NextResponse } from "next/server";
import { HttpError, handle } from "@/lib/http";
import { githubConnection, listRepos } from "@/lib/integrations/github";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Repositories the GitHub login can push to, for the sync setup. */
export const GET = handle(async () => {
  const conn = await githubConnection(await getSession());
  if (!conn) throw new HttpError(401, "Connect GitHub first.");
  return NextResponse.json({ login: conn.login, repos: await listRepos(conn) });
});
