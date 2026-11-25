import { HttpError, handle } from "@/lib/http";
import { pagePreview } from "@/lib/preview";
import { requireJob } from "@/lib/require-job";

export const dynamic = "force-dynamic";

/** Renders a whole converted page (?route=/about), included modules only. */
export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const job = await requireJob(ctx);
  const route = new URL(req.url).searchParams.get("route") ?? job.model.pages[0]?.route;
  const page = job.model.pages.find((p) => p.route === route);
  if (!page) throw new HttpError(404, "Page not found.");
  return pagePreview(job, page);
});
