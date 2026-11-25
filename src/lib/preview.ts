import { ASSET_SCHEME, type PageDef } from "./converter/types";
import type { Job } from "./jobs";

/**
 * Preview documents for the web app's iframes. Scripts are disabled by CSP:
 * the markup comes from a third-party page.
 */

const CSP = "default-src 'self' https: data:; script-src 'none'; style-src 'self' 'unsafe-inline' https:; frame-ancestors 'self'";

function resolver(job: Job): (s: string) => string {
  const assetRe = new RegExp(`${ASSET_SCHEME}([A-Za-z0-9_-]+)`, "g");
  return (s) => s.replace(assetRe, (_m, id: string) => `/api/jobs/${job.id}/asset/${id}`);
}

function documentFor(job: Job, body: string, extraCss = ""): Response {
  const resolve = resolver(job);
  const html = `<!doctype html>
<html lang="${job.model.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${job.model.headLinks.join("\n")}
<style>${resolve(job.model.css).replace(/<\/style/gi, "<\\/style")}</style>
<style>.fixed{position:relative!important}${extraCss}</style>
</head>
<body ${job.model.bodyAttrs}>${resolve(body)}</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "x-content-type-options": "nosniff" },
  });
}

/** One section with the page CSS. */
export function modulePreview(job: Job, moduleId: string): Response | null {
  const mod = job.model.modules.find((m) => m.id === moduleId);
  if (!mod) return null;
  const page = job.model.pages.find((p) => p.layout.some((n) => (n.type === "static" ? n.moduleId === mod.id : n.moduleIds.includes(mod.id))));
  return documentFor(job, `${page?.wrapperOpen.join("") ?? ""}${mod.previewHtml}${page?.wrapperClose.join("") ?? ""}`, "html,body{min-height:0!important}");
}

/** A whole page, rebuilt from its included modules in source order. */
export function pagePreview(job: Job, page: PageDef): Response {
  const byId = new Map(job.model.modules.map((m) => [m.id, m]));
  const html = (id: string) => {
    const m = byId.get(id);
    return m && m.included ? m.previewHtml : "";
  };
  const parts = page.layout.map((n) => (n.type === "static" ? html(n.moduleId) : `${n.open}${n.moduleIds.map(html).join("")}${n.close}`));
  return documentFor(job, `${page.wrapperOpen.join("")}${parts.join("")}${page.wrapperClose.join("")}`);
}
