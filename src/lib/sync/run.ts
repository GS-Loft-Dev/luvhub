import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { convertPages } from "../converter";
import { writeTheme } from "../converter/theme";
import type { RenderedPage, ThemeModel } from "../converter/types";
import { connectionFromToken } from "../integrations/hubspot";
import { createEmbedUrl } from "../integrations/lovable";
import { publishToHubSpot, type PublishResult } from "../publish";
import { renderRoutes } from "../render";
import { applyConfig, recordPages, type LuvhubConfig } from "./config";
import { startAppServer } from "./app-server";
import { serveStatic } from "./serve";

export interface SyncOptions {
  /** The Lovable project's checkout (where luvhub.json lives). */
  cwd: string;
  config: LuvhubConfig;
  /** HubSpot private app token. */
  token: string;
  /** Lovable API key, for the "lovable" source. */
  lovableKey?: string;
  /** Publish even when nothing changed since the last sync. */
  force?: boolean;
  log?: (line: string) => void;
  /** Tests: extra Chrome flags. */
  chromeArgs?: string[];
  /** Tests: skip install and build, serve this folder as is. */
  prebuiltDir?: string;
}

export interface SyncResult {
  status: "published" | "unchanged" | "failed";
  config: LuvhubConfig;
  hash: string;
  model: ThemeModel;
  publish?: PublishResult;
}

function run(cmd: string, cwd: string, log: (s: string) => void): Promise<void> {
  log(`$ ${cmd}`);
  return new Promise((ok, fail) => {
    const child = spawn(cmd, { cwd, shell: true, stdio: "inherit", env: { ...process.env, CI: "true" } });
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`"${cmd}" exited with code ${code}.`))));
  });
}

/**
 * Install commands to try in order, picked from the lockfile. Lovable projects
 * usually ship a bun lockfile and no package-lock.json; npm's resolver can then
 * crash ("Cannot read properties of null (reading 'edgesOut')"), so every
 * choice ends with npm and --legacy-peer-deps as a fallback.
 */
export function installCommands(cwd: string, has: (file: string) => boolean = (f) => existsSync(join(cwd, f))): string[] {
  const npmFallback = "npm install --no-audit --no-fund --legacy-peer-deps";
  if (has("package-lock.json")) return ["npm ci --no-audit --no-fund", npmFallback];
  if (has("bun.lockb") || has("bun.lock")) return ["bun install --frozen-lockfile", "bun install", npmFallback];
  if (has("pnpm-lock.yaml")) return ["npx --yes pnpm install --frozen-lockfile", npmFallback];
  if (has("yarn.lock")) return ["npx --yes yarn install --frozen-lockfile", npmFallback];
  return ["npm install --no-audit --no-fund", npmFallback];
}

async function install(cwd: string, log: (s: string) => void): Promise<void> {
  const commands = installCommands(cwd);
  for (const [i, cmd] of commands.entries()) {
    try {
      await run(cmd, cwd, log);
      return;
    } catch (e) {
      if (i === commands.length - 1) throw e;
      log(`${(e as Error).message} Trying "${commands[i + 1]}".`);
    }
  }
}

/** The static site the build produced, or null when it's a server app (no index.html). */
function findOutDir(cwd: string, configured?: string): string | null {
  const candidates = configured ? [configured] : ["dist", "build", "out"];
  for (const dir of candidates) if (existsSync(join(cwd, dir, "index.html"))) return join(cwd, dir);
  if (configured) throw new Error(`Build output not found: ${configured}/index.html. Fix "source.outDir" in luvhub.json.`);
  return null;
}

/** A stable fingerprint of what would be published: theme files, assets and page metadata. */
export function fingerprint(model: ThemeModel, assetBytes: Map<string, Buffer>): string {
  const h = createHash("sha256");
  // Assets by name and bytes, never by URL: the local server's port changes on every run.
  const stable = new Map(model.assets.map((a) => [a.id, `asset:${a.fileName}`]));
  const files = [...writeTheme(model, { kind: "url", urls: stable })].sort(([a], [b]) => a.localeCompare(b));
  for (const [path, content] of files) {
    h.update(path).update("\0").update(content).update("\0");
  }
  for (const a of [...model.assets].sort((x, y) => x.fileName.localeCompare(y.fileName))) {
    h.update(a.fileName).update("\0").update(assetBytes.get(a.id) ?? Buffer.alloc(0)).update("\0");
  }
  h.update(JSON.stringify(model.pages.map((p) => [p.route, p.label, p.description ?? "", p.templateName])));
  return h.digest("hex");
}

/**
 * One sync: get the site (Lovable's preview, the published URL or a local build), render it,
 * convert with the saved choices, and publish when something changed.
 */
export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const { config: c, cwd } = opts;

  let rendered: RenderedPage[];
  if (c.source.type === "lovable") {
    const key = opts.lovableKey?.trim();
    if (!key) throw new Error("The LUVHUB_LOVABLE_API_KEY secret is empty: save a Lovable API key again from the luvhub dashboard (node 5 Sync).");
    const { projectId, parentOrigin } = c.source;
    const url = await createEmbedUrl({ kind: "key", key }, projectId, parentOrigin).catch((e: unknown) => {
      throw new Error(`Lovable didn't give a preview of project ${projectId} (${(e as Error).message}). Check the LUVHUB_LOVABLE_API_KEY secret.`);
    });
    log(`Rendering Lovable's latest preview of the project (${c.routes.join(", ")})`);
    rendered = await renderRoutes({ url, routes: c.routes, embedParentOrigin: parentOrigin, chromeArgs: opts.chromeArgs });
  } else if (c.source.type === "url") {
    log(`Rendering ${c.source.url} (${c.routes.join(", ")})`);
    rendered = await renderRoutes({ url: c.source.url, routes: c.routes });
  } else {
    let dir: string | null | undefined = opts.prebuiltDir;
    if (!dir) {
      await install(cwd, log);
      await run(c.source.command?.trim() || "npm run build", cwd, log);
      dir = findOutDir(cwd, c.source.outDir);
      if (!dir) log("The build has no index.html (a server-rendered app): starting the project's own server.");
    }
    const server = dir ? await serveStatic(dir) : await startAppServer(cwd, { custom: c.source.serveCommand, log });
    try {
      log(`Rendering the build (${c.routes.join(", ")})`);
      rendered = await renderRoutes({ url: server.url, routes: c.routes });
    } finally {
      await server.close();
    }
  }

  const model = applyConfig(convertPages(rendered, { themeName: c.theme.name, themeLabel: c.theme.label }), c);
  const assetBytes = new Map<string, Buffer>();
  for (const page of rendered) for (const a of page.assets) assetBytes.set(a.id, Buffer.from(a.base64, "base64"));
  for (const w of model.warnings) log(`warning: ${w}`);

  const hash = fingerprint(model, assetBytes);
  const allLinked = model.pages.every((p) => p.hubspotPageId);
  if (!opts.force && c.lastSync?.hash === hash && allLinked) {
    log("No changes since the last sync: HubSpot is up to date.");
    return { status: "unchanged", config: c, hash, model };
  }

  const conn = await connectionFromToken(opts.token).catch((e: unknown) => {
    throw new Error(`HubSpot didn't accept the token in the LUVHUB_HUBSPOT_TOKEN secret (${(e as Error).message}). Create a private app with the "content" and "files" scopes and save its token again from the luvhub dashboard.`);
  });
  log(`Publishing "${model.label}" to HubSpot portal ${conn.portalId}`);
  const publish = await publishToHubSpot(conn, model, assetBytes);
  for (const p of publish.pages) log(`page ${p.route} "${p.title}": ${p.status}${p.error ? ` (${p.error})` : ""}`);
  for (const s of publish.steps.filter((x) => x.status === "failed")) log(`failed ${s.path}: ${s.error}`);

  let next = recordPages(c, model);
  if (publish.ok) next = { ...next, lastSync: { at: new Date().toISOString(), hash, portalId: conn.portalId } };
  return { status: publish.ok ? "published" : "failed", config: next, hash, model, publish };
}
