import { NextResponse } from "next/server";
import { HttpError, handle } from "@/lib/http";
import { githubConnection, listRepos } from "@/lib/integrations/github";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Accounts and repositories the GitHub login can push to, for the sync setup. */
export const GET = handle(async () => {
  const session = await getSession();
  const conn = await githubConnection(session);
  if (!conn) throw new HttpError(401, "Connect GitHub first.");
  const { repos, owners } = await listRepos(conn);
  return NextResponse.json({ login: conn.login, viaToken: !session.github, owners, repos });
});
