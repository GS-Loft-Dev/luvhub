import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertPages } from "../src/lib/converter";
import { writeTheme } from "../src/lib/converter/theme";
import type { LiveApp, ThemeModel } from "../src/lib/converter/types";
import { findRefs, rewriteApp, routeShim, storagePath } from "../src/lib/live-app";
import { publishToHubSpot } from "../src/lib/publish";

const entryJs =
  'const fC="modulepreload",hC=function(e){return"/"+e};' +
  'const m=["assets/Footer-abc.js","assets/Footer-abc.css"];import("./Hero-x.js");' +
  'const logo="/assets/logo.png",video="/__l5e/assets-v1/u1/hero loop.mp4",api="/api/send";';
const app: LiveApp = {
  entry: "assets/index-1.js",
  scripts: ["https://widget.example/tp.js"],
  files: [
    { path: "assets/index-1.js", contentType: "text/javascript", text: entryJs },
    { path: "assets/Footer-abc.css", contentType: "text/css", text: ".f{background:url(/assets/logo.png)}" },
    { path: "assets/logo.png", contentType: "image/png", base64: "AA==" },
    { path: "__l5e/assets-v1/u1/hero loop.mp4", contentType: "video/mp4", base64: "AA==" },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("Lovable's app", () => {
  it("finds the chunks, styles and media a file loads", () => {
    expect(findRefs(entryJs, "https://p.lovable.app/assets/index-1.js").sort()).toEqual([
      "__l5e/assets-v1/u1/hero loop.mp4",
      "assets/Footer-abc.css",
      "assets/Footer-abc.js",
      "assets/Hero-x.js",
      "assets/logo.png",
    ]);
    expect(findRefs("@font-face{src:url(../fonts/a.woff2)}", "https://p.lovable.app/assets/x.css")).toEqual(["fonts/a.woff2"]);
  });

  it("points root paths and Vite's preload base at the uploaded folder", () => {
    const base = "https://cdn.example/hubfs/1/luvhub/app/";
    const out = new Map(rewriteApp(app, base).map((f) => [f.path, f.text]));
    const js = out.get("assets/index-1.js")!;
    expect(js).toContain(`hC=function(e){return"${base}"+e}`);
    expect(js).toContain(`logo="${base}assets/logo.png"`);
    expect(js).toContain(`video="${base}l5e/assets-v1/u1/hero-loop.mp4"`);
    expect(js).toContain('api="/api/send"');
    expect(js).toContain('import("./Hero-x.js")');
    expect(out.get("assets/Footer-abc.css")).toBe(`.f{background:url(${base}assets/logo.png)}`);
    expect(storagePath("__l5e/a b/c.mp4")).toBe("l5e/a-b/c.mp4");
  });

  it("lets the app's router see its own route, then puts the address back", () => {
    const shim = routeShim("/");
    expect(shim).toContain('var route = "/"');
    expect(shim).toContain("history.replaceState(history.state, \"\", real)");
    expect(shim).not.toMatch(/\{\{|\{%|\{#/);
  });
});

describe("synced page with Lovable's app", () => {
  const html = readFileSync(join(__dirname, "fixtures/landing.html"), "utf8");
  const fresh = (): ThemeModel => {
    const m = convertPages([{ route: "/", url: "https://acme.lovable.app/", title: "Acme", html, css: "", headLinks: [], htmlLang: "it", bodyAttrs: "", assets: [], app }], { themeName: "acme" });
    m.layout = "sync";
    return m;
  };

  it("uploads the app and starts it on #root, after the converted HTML", async () => {
    const uploads: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/files/v3/files")) {
        const form = init.body as FormData;
        const path = `${String(form.get("folderPath")).replace(/^\//, "")}/${form.get("fileName")}`;
        uploads.push(path);
        return Response.json({ url: `https://cdn.example/hubfs/1/${path}` });
      }
      if (url.endsWith("/cms/v3/pages/landing-pages")) return Response.json({ id: "9" });
      return new Response("", { status: 200 });
    });
    const model = fresh();
    const r = await publishToHubSpot({ token: "t", portalId: 1 }, model, new Map());
    expect(r.ok).toBe(true);
    expect(uploads).toContain("lovable-to-hubspot/acme/app/assets/index-1.js");
    expect(uploads).toContain("lovable-to-hubspot/acme/app/l5e/assets-v1/u1/hero-loop.mp4");
    expect(model.appEntryUrl).toBe("https://cdn.example/hubfs/1/lovable-to-hubspot/acme/app/assets/index-1.js");

    const files = writeTheme(model, { kind: "url", urls: new Map() });
    const template = String(files.get("templates/home.html"));
    expect(template).toMatch(/\{% block body %\}\n<div id="root">/);
    expect(template).toContain(`<script type="module" crossorigin src="${model.appEntryUrl}"></script>`);
    expect(template.indexOf('var route = "/"')).toBeGreaterThan(0);
    expect(template.indexOf('var route = "/"')).toBeLessThan(template.indexOf('type="module"'));
    const base = String(files.get("templates/layouts/base.html"));
    expect(base).toContain('<script src="https://widget.example/tp.js" async></script>');
    expect(base).not.toContain("luvhub-closed");
  });

  it("keeps the converted page alone when HubSpot refuses the app's code", async () => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/files/v3/files")) {
        const name = String((init.body as FormData).get("fileName"));
        if (name.endsWith(".js")) return new Response(JSON.stringify({ message: "type not allowed" }), { status: 400 });
        return Response.json({ url: `https://cdn.example/hubfs/1/x/${name}` });
      }
      if (url.endsWith("/cms/v3/pages/landing-pages")) return Response.json({ id: "9" });
      return new Response("", { status: 200 });
    });
    const model = fresh();
    const r = await publishToHubSpot({ token: "t", portalId: 1 }, model, new Map());
    expect(r.ok).toBe(true);
    expect(model.appEntryUrl).toBeUndefined();
    expect(r.steps.some((s) => s.status === "skipped" && s.error?.startsWith("Lovable app"))).toBe(true);
    expect(String(writeTheme(model, { kind: "url", urls: new Map() }).get("templates/home.html"))).not.toContain('id="root"');
  });
});
