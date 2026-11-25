import JSZip from "jszip";
import { writeTheme, type ThemeFiles } from "./converter/theme";
import type { ThemeModel } from "./converter/types";
import {
  designManagerUrl,
  pageEditorUrl,
  putSourceFile,
  upsertSitePage,
  uploadFile,
  validateSourceFile,
  type HubSpotConnection,
} from "./integrations/hubspot";

export interface PublishStep {
  path: string;
  status: "uploaded" | "failed" | "skipped";
  error?: string;
}

export interface PublishedPage {
  route: string;
  title: string;
  status: "created" | "updated" | "failed" | "skipped";
  id?: string;
  editUrl?: string;
  error?: string;
}

export interface PublishResult {
  ok: boolean;
  portalId: number;
  themePath: string;
  designManagerUrl: string;
  steps: PublishStep[];
  pages: PublishedPage[];
}

/** HubSpot slug for a source route, kept under the theme name so it never takes over the portal's home page. */
export function pageSlug(themeName: string, route: string): string {
  const rest = route.replace(/^\/+|\/+$/g, "");
  return rest ? `${themeName}/${rest}` : themeName;
}

/** Upload order: definitions before the files that reference them. */
function uploadOrder(path: string): number {
  if (path === "theme.json") return 0;
  if (path === "fields.json") return 1;
  if (path.startsWith("css/")) return 2;
  if (path.startsWith("images/")) return 3;
  if (path.endsWith("meta.json")) return 4;
  if (path.endsWith("fields.json")) return 5;
  if (path.endsWith("module.html")) return 6;
  if (path.startsWith("templates/layouts/")) return 7;
  return 8;
}

const VALIDATED = /(module\.html|templates\/.+\.html|\.json)$/;

/** HubSpot allows ~100 requests per 10s per app; 5 at a time stays well under. */
const CONCURRENCY = 5;

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function publishToHubSpot(
  conn: HubSpotConnection,
  model: ThemeModel,
  assetBytes: Map<string, Buffer>,
): Promise<PublishResult> {
  const steps: PublishStep[] = [];

  // 1. Images and fonts go to the File Manager, so editors can swap them.
  const urls = new Map<string, string>();
  const folder = `/lovable-to-hubspot/${model.name}`;
  const assetSteps = await pool(model.assets, CONCURRENCY, async (asset): Promise<PublishStep> => {
    const path = `${folder}/${asset.fileName}`;
    const bytes = assetBytes.get(asset.id);
    if (!bytes) return { path, status: "skipped", error: "Asset bytes missing, original URL kept." };
    try {
      urls.set(asset.id, await uploadFile(conn, { name: asset.fileName, contentType: asset.contentType, bytes }, folder));
      return { path, status: "uploaded" };
    } catch (e) {
      return { path, status: "failed", error: (e as Error).message };
    }
  });
  steps.push(...assetSteps);

  // 2. Theme files go to the Design Manager, validated first.
  const files = writeTheme(model, { kind: "url", urls });
  // Groups go in order (definitions before the files that use them); files
  // inside a group upload in parallel to stay well within function timeouts.
  const groups = new Map<number, [string, string | Buffer][]>();
  for (const entry of files) {
    const order = uploadOrder(entry[0]);
    groups.set(order, [...(groups.get(order) ?? []), entry]);
  }
  for (const order of [...groups.keys()].sort((a, b) => a - b)) {
    const entries = groups.get(order)!.sort(([a], [b]) => a.localeCompare(b));
    const results = await pool(entries, CONCURRENCY, async ([rel, content]): Promise<PublishStep> => {
      const path = `${model.name}/${rel}`;
      try {
        if (VALIDATED.test(rel)) await validateSourceFile(conn, path, content);
        await putSourceFile(conn, path, content);
        return { path, status: "uploaded" };
      } catch (e) {
        return { path, status: "failed", error: (e as Error).message };
      }
    });
    steps.push(...results);
  }

  // 3. One draft HubSpot page per source page, titled like the Lovable page.
  //    Ids are written back on the model so a later publish updates them.
  const failedPaths = new Set(steps.filter((s) => s.status === "failed").map((s) => s.path));
  const pages: PublishedPage[] = [];
  for (const page of model.pages) {
    const templatePath = `${model.name}/templates/${page.templateName}.html`;
    const base = { route: page.route, title: page.label };
    if (failedPaths.has(templatePath)) {
      pages.push({ ...base, status: "skipped", error: "Its template failed to upload." });
      continue;
    }
    try {
      const existing = page.hubspotPageId;
      const id = await upsertSitePage(
        conn,
        {
          name: page.label,
          htmlTitle: page.label,
          slug: pageSlug(model.name, page.route),
          templatePath,
          metaDescription: page.description,
          language: model.htmlLang?.slice(0, 2) || undefined,
        },
        existing,
      );
      page.hubspotPageId = id;
      pages.push({ ...base, status: existing === id ? "updated" : "created", id, editUrl: pageEditorUrl(conn.portalId, id) });
    } catch (e) {
      pages.push({ ...base, status: "failed", error: (e as Error).message });
    }
  }

  return {
    ok: steps.every((s) => s.status !== "failed") && pages.every((p) => p.status !== "failed" && p.status !== "skipped"),
    portalId: conn.portalId,
    themePath: model.name,
    designManagerUrl: designManagerUrl(conn.portalId),
    steps,
    pages,
  };
}

export async function themeZip(model: ThemeModel, assetBytes: Map<string, Buffer>): Promise<Buffer> {
  const files: ThemeFiles = writeTheme(model, { kind: "theme" }, assetBytes);
  const zip = new JSZip();
  const folder = zip.folder(model.name)!;
  for (const [path, content] of files) folder.file(path, content);
  folder.file(
    "README.txt",
    [
      `${model.label} — generated by lovable-to-hubspot`,
      "",
      "Upload with the HubSpot CLI:",
      `  npx @hubspot/cli upload ${model.name} ${model.name}`,
      "",
      "Images are in images/. Module image fields default to the original URLs;",
      "publish from the web app instead to get them in your File Manager.",
    ].join("\n"),
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
