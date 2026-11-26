/**
 * Lovable's own app on the HubSpot page.
 *
 * The converted HTML shows the page at once (and to search engines), but it
 * has none of the page's JavaScript: countdowns stand still, forms don't send,
 * banners don't close. So luvhub also copies the app itself (its JS and CSS
 * chunks and the media they load) to the HubSpot File Manager, and the page
 * starts it on top of the converted HTML: from then on it is exactly the page
 * Lovable shows.
 *
 * Files keep their folder layout, so the chunks' relative imports still work;
 * paths that start at the site root ("/assets/logo.png", Vite's preload base)
 * are rewritten to the uploaded copies.
 */
import type { Frame } from "playwright-core";
import type { AppFile, LiveApp } from "./converter/types";

const CODE = /\.(m?js|css)$/i;
const MEDIA = "png|jpe?g|webp|gif|svg|avif|ico|bmp|mp4|webm|mov|m4v|mp3|wav|ogg|woff2?|ttf|otf|eot|pdf";
const MAX_FILES = 300;
const MAX_BYTES = 80 * 1024 * 1024;
const MAX_FILE_BYTES = 30 * 1024 * 1024;

/** Paths (no leading slash) referenced by a JS or CSS file, resolved against the file's own URL. */
export function findRefs(text: string, fileUrl: string): string[] {
  const origin = new URL(fileUrl).origin;
  const out = new Set<string>();
  const add = (spec: string, base: string) => {
    try {
      const u = new URL(spec, base);
      if (u.origin === origin) out.add(decodeURIComponent(u.pathname.replace(/^\/+/, "")));
    } catch {
      // not a URL
    }
  };
  // Relative imports between chunks: "./Footer-abc.js", "../x.css".
  for (const m of text.matchAll(/(["'`])(\.{1,2}\/[^"'`\s]+?\.(?:m?js|css))\1/g)) add(m[2], fileUrl);
  // Vite's preload list: "assets/Footer-abc.js" from the site root.
  for (const m of text.matchAll(/(["'`])(assets\/[^"'`\s]+?\.(?:m?js|css))\1/g)) add(`/${m[2]}`, origin);
  // Files from the site root: "/assets/logo.png", "/__l5e/assets-v1/…/hero.mp4".
  const rooted = new RegExp(`(["'\`(])(\\/[^"'\`()\\n?#]+?\\.(?:m?js|css|${MEDIA}))(?=["'\`)?#])`, "gi");
  for (const m of text.matchAll(rooted)) add(m[2], origin);
  // CSS url(…), relative to the stylesheet.
  if (/\.css$/i.test(new URL(fileUrl).pathname)) {
    for (const m of text.matchAll(/url\(\s*["']?([^"')]+?)["']?\s*\)/g)) if (!m[1].startsWith("data:")) add(m[1], fileUrl);
  }
  return [...out];
}

/** Folder-safe version of a path for the File Manager ("__l5e/x y.mp4" → "l5e/x-y.mp4"). */
export function storagePath(path: string): string {
  return path
    .split("/")
    .map((seg) => seg.replace(/[^\w.-]+/g, "-").replace(/^[_.-]+/, "") || "x")
    .join("/");
}

/**
 * The app's text files pointed at `base` (the uploaded folder, ending in "/"):
 * root paths of captured files, and Vite's preload base.
 */
export function rewriteApp(app: LiveApp, base: string): AppFile[] {
  const known = new Set(app.files.map((f) => f.path));
  const rooted = /(["'`(])\/([^"'`()\n?#]+)(?=["'`)?#])/g;
  return app.files.map((f) => {
    if (f.text === undefined) return f;
    let text = f.text.replace(rooted, (m, q: string, p: string) => {
      const path = decodeURIComponent(p);
      return known.has(path) ? `${q}${base}${storagePath(path)}` : m;
    });
    // Vite: const x=function(e){return"/"+e} turns "assets/chunk.js" into a root URL.
    text = text.replace(/function\((\w+)\)\{return"\/"\+\1\}/g, (_m, v: string) => `function(${v}){return${JSON.stringify(base)}+${v}}`);
    return { ...f, text };
  });
}

/**
 * Copies the app the page runs: its entry module and everything reachable
 * from it, fetched inside the page (same origin, same cookies as the render).
 */
export async function captureLiveApp(frame: Frame): Promise<LiveApp | undefined> {
  const info = await frame.evaluate(async () => {
    const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
    // Third-party scripts from the page's own HTML; the ones the app adds while
    // running (pixels, tag managers) come back by themselves when it runs.
    let scripts: string[] = [];
    try {
      const doc = new DOMParser().parseFromString(await (await fetch(location.href)).text(), "text/html");
      scripts = [...doc.querySelectorAll("head script[src]")]
        .map((s) => new URL(s.getAttribute("src")!, location.href))
        .filter((u) => /^https?:$/.test(u.protocol) && u.origin !== location.origin)
        .map((u) => u.href);
    } catch {
      // no scripts then
    }
    return { entry: entry?.src ?? null, scripts };
  });
  if (!info.entry) return undefined;
  const entryUrl = new URL(info.entry);
  const origin = entryUrl.origin;
  const entry = entryUrl.pathname.replace(/^\/+/, "");

  const files = new Map<string, AppFile>();
  const seen = new Set<string>([entry]);
  let queue = [entry];
  let bytes = 0;
  while (queue.length && files.size < MAX_FILES) {
    const batch = queue.splice(0, 12);
    const got = await frame.evaluate(
      async ({ urls, maxFile }) =>
        Promise.all(
          urls.map(async (u) => {
            try {
              const r = await fetch(u);
              if (!r.ok) return null;
              const type = (r.headers.get("content-type") ?? "").split(";")[0].trim();
              if (/\.(m?js|css)$/i.test(new URL(u).pathname)) return { type, text: await r.text() };
              const buf = new Uint8Array(await r.arrayBuffer());
              if (buf.length > maxFile) return null;
              let bin = "";
              for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
              return { type, base64: btoa(bin) };
            } catch {
              return null;
            }
          }),
        ),
      { urls: batch.map((p) => `${origin}/${p}`), maxFile: MAX_FILE_BYTES },
    );
    const next: string[] = [];
    batch.forEach((path, i) => {
      const r = got[i];
      if (!r) return;
      const size = r.text?.length ?? Math.floor(((r.base64?.length ?? 0) * 3) / 4);
      if (bytes + size > MAX_BYTES) return;
      bytes += size;
      const contentType = r.type || (CODE.test(path) ? (path.endsWith(".css") ? "text/css" : "text/javascript") : "application/octet-stream");
      files.set(path, r.text !== undefined ? { path, contentType, text: r.text } : { path, contentType, base64: r.base64 });
      if (r.text !== undefined) {
        for (const ref of findRefs(r.text, `${origin}/${path}`)) {
          if (!seen.has(ref)) {
            seen.add(ref);
            next.push(ref);
          }
        }
      }
    });
    queue = [...queue, ...next];
  }
  if (!files.has(entry)) return undefined;
  return { entry, files: [...files.values()], scripts: info.scripts };
}

/**
 * Runs before the app: the app's router knows the Lovable route ("/"), not the
 * HubSpot address, so the address shows the route while the app reads it and
 * is put back as soon as the app has drawn the page.
 */
export function routeShim(route: string): string {
  return `(function () {
  var route = ${JSON.stringify(route)}, real = location.pathname + location.search + location.hash;
  if (location.pathname === route) return;
  history.replaceState(history.state, "", route + location.search + location.hash);
  var done = false, root = document.getElementById("root");
  function back() { if (!done) { done = true; history.replaceState(history.state, "", real); } }
  if (root && window.MutationObserver) new MutationObserver(function () { setTimeout(back, 0); }).observe(root, { childList: true });
  setTimeout(back, 5000);
})();`;
}
