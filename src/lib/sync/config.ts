import { DEFAULT_PAGE_TYPE, type PageType, type ThemeModel } from "../converter/types";

/**
 * luvhub.json: what the GitHub Action needs to rebuild the same theme and
 * update the same HubSpot pages on every change. It lives at the root of the
 * Lovable project's repository; the dashboard writes it, the Action keeps the
 * page ids and the last sync up to date.
 */
export interface LuvhubConfig {
  version: 1;
  /**
   * Where the pages come from. The first two use Lovable's own render, the
   * same one the dashboard converted:
   * "lovable": the latest preview of the project (every edit), through the
   * Lovable API with the LUVHUB_LOVABLE_API_KEY secret.
   * "url": the published site (changes after Publish in Lovable).
   * "build": builds the code in the repository instead (legacy: the result can
   * differ from what Lovable shows). `outDir` is the static output;
   * `serveCommand` serves a server-rendered app, with {port} for the port.
   */
  source:
    | { type: "lovable"; projectId: string; parentOrigin: string }
    | { type: "url"; url: string }
    | { type: "build"; command?: string; outDir?: string; serveCommand?: string };
  routes: string[];
  theme: { name: string; label: string };
  /** HubSpot page type: "landing" pages (default) or website ("site") pages. */
  pageType?: PageType;
  /** Per route: a title that overrides the source <title>, and the HubSpot page id. */
  pages: Record<string, { title?: string; hubspotPageId?: string }>;
  /** Module folder names to leave out. */
  exclude: string[];
  lastSync?: { at: string; hash: string; portalId: number };
}

export const CONFIG_FILE = "luvhub.json";

const ROUTE_RE = /^\/[\w\-./~%]*$/;

/** Parses and checks a luvhub.json; throws a readable error on bad input. */
export function parseConfig(text: string): LuvhubConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${CONFIG_FILE} is not valid JSON.`);
  }
  const c = raw as Partial<LuvhubConfig>;
  const fail = (msg: string): never => {
    throw new Error(`${CONFIG_FILE}: ${msg}`);
  };
  if (c.version !== 1) fail('"version" must be 1.');
  const src = c.source as LuvhubConfig["source"] | undefined;
  if (!src || !["lovable", "url", "build"].includes(src.type)) fail('"source.type" must be "lovable", "url" or "build".');
  if (src!.type === "url" && !/^https?:\/\//.test(src!.url ?? "")) fail('"source.url" must be an http(s) address.');
  if (src!.type === "lovable" && (!src!.projectId?.trim() || !/^https:\/\//.test(src!.parentOrigin ?? ""))) {
    fail('"source.projectId" and an https "source.parentOrigin" are required.');
  }
  if (!Array.isArray(c.routes) || c.routes.length === 0 || c.routes.some((r) => typeof r !== "string" || !ROUTE_RE.test(r))) {
    fail('"routes" must list paths like "/" or "/about".');
  }
  if (!c.theme || typeof c.theme.name !== "string" || !c.theme.name.trim()) fail('"theme.name" is required.');
  if (c.pageType !== undefined && c.pageType !== "landing" && c.pageType !== "site") fail('"pageType" must be "landing" or "site".');
  return {
    version: 1,
    source: src!,
    routes: [...new Set(c.routes!)],
    theme: { name: c.theme!.name.trim(), label: (c.theme!.label ?? c.theme!.name).trim() },
    ...(c.pageType ? { pageType: c.pageType } : {}),
    pages: c.pages && typeof c.pages === "object" ? c.pages : {},
    exclude: Array.isArray(c.exclude) ? c.exclude.filter((e) => typeof e === "string") : [],
    lastSync: c.lastSync,
  };
}

export function serializeConfig(c: LuvhubConfig): string {
  return `${JSON.stringify(c, null, 2)}\n`;
}

/**
 * Applies the saved choices to a fresh conversion: sync layout, theme name,
 * excluded modules, title overrides and the HubSpot page ids to update.
 */
export function applyConfig(model: ThemeModel, c: LuvhubConfig): ThemeModel {
  model.layout = "sync";
  model.pageType = c.pageType ?? DEFAULT_PAGE_TYPE;
  model.name = c.theme.name;
  model.label = c.theme.label || model.label;
  const excluded = new Set(c.exclude);
  for (const m of model.modules) m.included = !excluded.has(m.name);
  for (const p of model.pages) {
    const saved = c.pages[p.route];
    if (saved?.title?.trim()) p.label = saved.title.trim();
    if (saved?.hubspotPageId) p.hubspotPageId = saved.hubspotPageId;
  }
  return model;
}

/** Writes the page ids a publish produced back into the config. */
export function recordPages(c: LuvhubConfig, model: ThemeModel): LuvhubConfig {
  const pages = { ...c.pages };
  for (const p of model.pages) {
    if (!p.hubspotPageId) continue;
    pages[p.route] = { ...pages[p.route], hubspotPageId: p.hubspotPageId };
  }
  return { ...c, pages };
}

/**
 * The config for a conversion reviewed in the dashboard. Titles are stored
 * only when they were edited, so untouched pages keep following Lovable.
 */
export function configFromModel(model: ThemeModel, source: LuvhubConfig["source"]): LuvhubConfig {
  const pages: LuvhubConfig["pages"] = {};
  for (const p of model.pages) {
    const entry: { title?: string; hubspotPageId?: string } = {};
    if (p.sourceTitle !== undefined && p.label !== p.sourceTitle) entry.title = p.label;
    if (p.hubspotPageId) entry.hubspotPageId = p.hubspotPageId;
    pages[p.route] = entry;
  }
  return {
    version: 1,
    source,
    routes: model.pages.map((p) => p.route),
    theme: { name: model.name, label: model.label },
    pageType: model.pageType ?? DEFAULT_PAGE_TYPE,
    pages,
    exclude: model.modules.filter((m) => !m.included).map((m) => m.name),
  };
}
