import { NextResponse } from "next/server";
import { HttpError, handle } from "@/lib/http";
import { saveJob, type Job } from "@/lib/jobs";
import { requireJob } from "@/lib/require-job";
import { slugify } from "@/lib/converter/util";
import { DEFAULT_PAGE_TYPE, type PageType } from "@/lib/converter/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** What the UI needs: the model without the heavy HubL and preview markup. */
function summary(job: Job) {
  const { model } = job;
  return {
    id: job.id,
    source: job.source,
    createdAt: job.createdAt,
    automation: job.automation ?? null,
    theme: { name: model.name, label: model.label },
    pageType: model.pageType ?? DEFAULT_PAGE_TYPE,
    warnings: model.warnings,
    assets: model.assets.length,
    pages: model.pages.map((p) => ({
      route: p.route,
      label: p.label,
      description: p.description ?? "",
      templateName: p.templateName,
      hubspotPageId: p.hubspotPageId ?? null,
    })),
    modules: model.modules.map((m) => ({
      id: m.id,
      name: m.name,
      label: m.label,
      kind: m.kind,
      included: m.included,
      fields: m.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        children: f.type === "group" ? f.children.map((c) => ({ name: c.name, type: c.type, label: c.label })) : undefined,
        items: f.type === "group" ? f.default.length : undefined,
      })),
    })),
  };
}

export const GET = handle(async (_req: Request, ctx: Ctx) => NextResponse.json(summary(await requireJob(ctx))));

interface Patch {
  theme?: { name?: string; label?: string };
  modules?: { id: string; name?: string; label?: string; included?: boolean }[];
  pages?: { route: string; label?: string }[];
  pageType?: PageType;
}

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const job = await requireJob(ctx);
  const patch = (await req.json()) as Patch;

  if (patch.theme?.name !== undefined) {
    const name = slugify(patch.theme.name, 8);
    if (!name) throw new HttpError(400, "Theme name can't be empty.");
    job.model.name = name;
  }
  if (patch.theme?.label !== undefined) job.model.label = patch.theme.label.trim().slice(0, 100) || job.model.label;

  for (const change of patch.modules ?? []) {
    const mod = job.model.modules.find((m) => m.id === change.id);
    if (!mod) continue;
    if (change.included !== undefined) mod.included = Boolean(change.included);
    if (change.label !== undefined) mod.label = change.label.trim().slice(0, 80) || mod.label;
    if (change.name !== undefined) {
      const name = slugify(change.name, 8);
      if (!name) throw new HttpError(400, "Module name can't be empty.");
      if (job.model.modules.some((m) => m.id !== mod.id && m.name === name)) {
        throw new HttpError(409, `Another module is already called "${name}".`);
      }
      mod.name = name;
    }
  }

  if (patch.pageType !== undefined) {
    if (patch.pageType !== "landing" && patch.pageType !== "site") throw new HttpError(400, 'Page type must be "landing" or "site".');
    job.model.pageType = patch.pageType;
  }

  for (const change of patch.pages ?? []) {
    const page = job.model.pages.find((p) => p.route === change.route);
    if (page && change.label !== undefined) page.label = change.label.trim().slice(0, 255) || page.label;
  }

  await saveJob(job);
  return NextResponse.json(summary(job));
});
