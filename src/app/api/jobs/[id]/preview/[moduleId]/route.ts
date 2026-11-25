import { HttpError, handle } from "@/lib/http";
import { modulePreview } from "@/lib/preview";
import { requireJob } from "@/lib/require-job";

export const dynamic = "force-dynamic";

/** Renders one captured section with the page CSS, for the preview iframe. */
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string; moduleId: string }> }) => {
  const { moduleId } = await ctx.params;
  const res = modulePreview(await requireJob(ctx), moduleId);
  if (!res) throw new HttpError(404, "Module not found.");
  return res;
});
