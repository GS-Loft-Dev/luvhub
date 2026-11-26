import { readFileSync } from "node:fs";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertPages } from "../src/lib/converter";
import { writeTheme } from "../src/lib/converter/theme";
import { sealSecret } from "../src/lib/integrations/github";
import { findChrome } from "../src/lib/render";
import { applyConfig, configFromModel, parseConfig, recordPages, serializeConfig, type LuvhubConfig } from "../src/lib/sync/config";
import { serveCommands } from "../src/lib/sync/app-server";
import { installCommands, runSync } from "../src/lib/sync/run";
import { serveStatic } from "../src/lib/sync/serve";
import { SECRET_NAME, workflowYaml } from "../src/lib/sync/workflow";

const html = readFileSync(join(__dirname, "fixtures/landing.html"), "utf8");
const page = (title = "Acme Fitness") => ({
  route: "/",
  url: "https://acme.lovable.app/",
  title,
  description: "Palestra",
  html,
  css: "",
  headLinks: [],
  htmlLang: "it",
  bodyAttrs: "",
  assets: [],
});

const hasChrome = (() => {
  try {
    findChrome();
    return true;
  } catch {
    return false;
  }
})();

afterEach(() => vi.unstubAllGlobals());

describe("sync layout", () => {
  it("puts sections in the template as fixed modules instead of a drag-and-drop area", () => {
    const model = convertPages([page()], { themeName: "acme" });
    const dnd = String(writeTheme(model, { kind: "theme" }).get("templates/home.html"));
    expect(dnd).toContain("{% dnd_area");

    model.layout = "sync";
    model.modules.find((m) => m.name === "features")!.included = false;
    const sync = String(writeTheme(model, { kind: "theme" }).get("templates/home.html"));
    expect(sync).not.toContain("dnd_area");
    expect(sync).toContain('{% module "hero" path="../modules/hero"');
    expect(sync).not.toContain("modules/features");
    expect(sync.indexOf("site_header")).toBeLessThan(sync.indexOf('"hero"'));
  });
});

describe("luvhub.json", () => {
  it("round-trips the choices made in the dashboard", () => {
    const model = convertPages([page()], { themeName: "acme" });
    model.modules.find((m) => m.name === "features")!.included = false;
    model.pages[0].hubspotPageId = "77";
    const untouched = configFromModel(model, { type: "build" });
    expect(untouched.pages["/"]).toEqual({ hubspotPageId: "77" });
    expect(untouched.exclude).toEqual(["features"]);

    model.pages[0].label = "Acme – Home";
    const c = parseConfig(serializeConfig(configFromModel(model, { type: "build" })));
    expect(c.pages["/"]).toEqual({ title: "Acme – Home", hubspotPageId: "77" });

    const next = applyConfig(convertPages([page("Acme Fitness v2")], { themeName: "whatever" }), c);
    expect(next.layout).toBe("sync");
    expect(next.name).toBe("acme");
    expect(next.pages[0].label).toBe("Acme – Home");
    expect(next.pages[0].hubspotPageId).toBe("77");
    expect(next.modules.find((m) => m.name === "features")!.included).toBe(false);
  });

  it("keeps the page type: landing pages unless the file says website pages", () => {
    const base = { version: 1, source: { type: "build" }, routes: ["/"], theme: { name: "acme" } };
    expect(applyConfig(convertPages([page()], { themeName: "acme" }), parseConfig(JSON.stringify(base))).pageType).toBe("landing");
    expect(applyConfig(convertPages([page()], { themeName: "acme" }), parseConfig(JSON.stringify({ ...base, pageType: "site" }))).pageType).toBe("site");
    expect(() => parseConfig(JSON.stringify({ ...base, pageType: "blog" }))).toThrow('"pageType"');
    const model = convertPages([page()], { themeName: "acme" });
    expect(configFromModel(model, { type: "build" }).pageType).toBe("landing");
  });

  it("follows the Lovable title when it wasn't edited", () => {
    const c: LuvhubConfig = { version: 1, source: { type: "build" }, routes: ["/"], theme: { name: "acme", label: "Acme" }, pages: {}, exclude: [] };
    const model = applyConfig(convertPages([page("New title from Lovable")], { themeName: "acme" }), c);
    expect(model.pages[0].label).toBe("New title from Lovable");
    model.pages[0].hubspotPageId = "9";
    expect(recordPages(c, model).pages["/"]).toEqual({ hubspotPageId: "9" });
  });

  it("rejects malformed files with a readable message", () => {
    expect(() => parseConfig("{")).toThrow("not valid JSON");
    expect(() => parseConfig(JSON.stringify({ version: 1, source: { type: "build" }, routes: ["about"], theme: { name: "x" } }))).toThrow('"routes"');
    expect(() => parseConfig(JSON.stringify({ version: 1, source: { type: "url", url: "ftp://x" }, routes: ["/"], theme: { name: "x" } }))).toThrow("source.url");
  });
});

describe("workflow", () => {
  it("runs on pushes to the default branch, ignores its own commits and reads the secret", () => {
    const yml = workflowYaml({ branch: "main", actionRef: "GS-Loft-Dev/luvhub@v1" });
    expect(yml).toContain('branches: ["main"]');
    expect(yml).toContain('paths-ignore: ["luvhub.json"]');
    expect(yml).toContain("uses: GS-Loft-Dev/luvhub@v1");
    expect(yml).toContain(`hubspot-token: \${{ secrets.${SECRET_NAME} }}`);
    expect(yml).toContain("workflow_dispatch:");
    expect(yml).toContain("contents: write");
  });
});

describe("install", () => {
  const pick = (...files: string[]) => installCommands("/x", (f) => files.includes(f));
  it("uses the project's own lockfile and always falls back to npm with --legacy-peer-deps", () => {
    expect(pick("bun.lockb")[0]).toBe("bun install --frozen-lockfile");
    expect(pick("bun.lock")[1]).toBe("bun install");
    expect(pick("package-lock.json", "bun.lockb")[0]).toBe("npm ci --no-audit --no-fund");
    expect(pick()[0]).toBe("npm install --no-audit --no-fund");
    for (const set of [pick(), pick("bun.lockb"), pick("yarn.lock"), pick("pnpm-lock.yaml"), pick("package-lock.json")]) {
      expect(set.at(-1)).toBe("npm install --no-audit --no-fund --legacy-peer-deps");
    }
  });
});

describe("server-rendered builds", () => {
  it("serves them with the project's Vite (preview, then dev) or the command in luvhub.json", () => {
    const vite = (f: string) => f === "node_modules/.bin/vite";
    expect(serveCommands("/x", undefined, vite)).toEqual([
      "npx vite preview --host 127.0.0.1 --port {port} --strictPort",
      "npx vite --host 127.0.0.1 --port {port} --strictPort",
    ]);
    expect(serveCommands("/x", "node .output/server/index.mjs", vite)).toEqual(["node .output/server/index.mjs"]);
    expect(serveCommands("/x", undefined, () => false)).toEqual([]);
  });
});

describe("GitHub secret", () => {
  it("seals the value so only the repository key can open it", async () => {
    await sodium.ready;
    const keys = sodium.crypto_box_keypair();
    const sealed = await sealSecret("pat-eu1-secret", sodium.to_base64(keys.publicKey, sodium.base64_variants.ORIGINAL));
    const opened = sodium.crypto_box_seal_open(sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL), keys.publicKey, keys.privateKey);
    expect(sodium.to_string(opened)).toBe("pat-eu1-secret");
  });
});

describe("static server", () => {
  it("serves files and falls back to index.html for app routes, never outside the folder", async () => {
    const s = await serveStatic(join(__dirname, "fixtures/site"));
    try {
      expect((await fetch(`${s.url}assets/app.css`)).headers.get("content-type")).toContain("text/css");
      expect(await (await fetch(`${s.url}pricing`)).text()).toContain("<html");
      expect((await fetch(`${s.url}assets/missing.png`)).status).toBe(404);
      expect((await fetch(`${s.url}..%2f..%2fpackage.json`)).status).not.toBe(200);
    } finally {
      await s.close();
    }
  });
});

describe.skipIf(!hasChrome)("runSync end to end", () => {
  it("creates the page, skips when nothing changed, and updates the same page when forced", async () => {
    const realFetch = globalThis.fetch;
    const calls: { url: string; method: string; body?: string }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (!url.startsWith("https://api.hubapi.com")) return realFetch(input, init);
      calls.push({ url, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : undefined });
      if (url.endsWith("/account-info/v3/details")) return Response.json({ portalId: 42 });
      if (url.endsWith("/files/v3/files")) return Response.json({ url: "https://cdn.example/x.png" });
      if (url.endsWith("/cms/v3/pages/landing-pages") && init.method === "POST") return Response.json({ id: "501" });
      return new Response("", { status: 200 });
    });

    const config: LuvhubConfig = { version: 1, source: { type: "build" }, routes: ["/"], theme: { name: "spa", label: "Spa" }, pages: {}, exclude: [] };
    const opts = { cwd: __dirname, token: "pat", prebuiltDir: join(__dirname, "fixtures/site"), log: () => undefined };

    const first = await runSync({ ...opts, config });
    expect(first.status).toBe("published");
    expect(first.config.pages["/"].hubspotPageId).toBe("501");
    expect(first.config.lastSync?.portalId).toBe(42);
    const created = calls.find((c) => c.method === "POST" && c.url.endsWith("/landing-pages"));
    expect(JSON.parse(created!.body!)).toMatchObject({ name: "Spa Test", htmlTitle: "Spa Test", templatePath: "spa/templates/home.html" });
    const template = calls.find((c) => c.url.includes("/published/content/spa/templates/home.html"));
    expect(template).toBeTruthy();

    calls.length = 0;
    const second = await runSync({ ...opts, config: first.config });
    expect(second.status).toBe("unchanged");
    expect(calls).toHaveLength(0);

    const third = await runSync({ ...opts, config: first.config, force: true });
    expect(third.status).toBe("published");
    const patch = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/landing-pages/501"));
    expect(JSON.parse(patch!.body!)).toMatchObject({ name: "Spa Test", templatePath: "spa/templates/home.html", widgets: {}, layoutSections: {} });
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/landing-pages"))).toBe(false);
  }, 90_000);
});
