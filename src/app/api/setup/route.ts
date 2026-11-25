import { NextResponse } from "next/server";
import { publicSetup } from "@/lib/config";
import { handle } from "@/lib/http";
import { githubConnection } from "@/lib/integrations/github";
import { hubspotConnection } from "@/lib/integrations/hubspot";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const session = await getSession();
  const setup = publicSetup();
  let hubspot: { portalId: number; hubDomain?: string; viaToken: boolean } | null = null;
  try {
    const conn = await hubspotConnection(session);
    if (conn) hubspot = { portalId: conn.portalId, hubDomain: conn.hubDomain, viaToken: !session.hubspot };
  } catch {
    hubspot = null;
  }
  let github: { login: string; viaToken: boolean } | null = null;
  try {
    const gh = await githubConnection(session);
    if (gh) github = { login: gh.login, viaToken: !session.github };
  } catch {
    github = null;
  }
  return NextResponse.json({
    setup,
    lovable: { connected: Boolean(session.lovable), viaKey: !session.lovable && setup.lovableApiKey },
    hubspot,
    github,
  });
});
