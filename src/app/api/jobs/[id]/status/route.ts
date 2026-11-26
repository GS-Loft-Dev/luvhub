import { NextResponse } from "next/server";
import { conversionStatus } from "@/lib/conversion";
import { HttpError, handle } from "@/lib/http";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Whether a conversion started in the background is ready, still running, or failed. */
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const status = await conversionStatus(id, (await getSession()).sid!);
  if (!status) throw new HttpError(404, "Conversion not found or expired.");
  return NextResponse.json(status);
});
