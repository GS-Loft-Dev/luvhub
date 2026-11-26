/**
 * Runs the project's own server when its build isn't a static site, such as
 * Lovable's TanStack Start projects: Nitro renders the pages on a server and
 * the build has no index.html to serve as files.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export interface AppServer {
  url: string;
  command: string;
  close: () => Promise<void>;
}

/** Commands to try, in order. `{port}` is replaced by a free port. */
export function serveCommands(cwd: string, custom?: string, has: (f: string) => boolean = (f) => existsSync(join(cwd, f))): string[] {
  if (custom?.trim()) return [custom.trim()];
  if (!has("node_modules/.bin/vite")) return [];
  return [
    // The production build, as the project's own tooling previews it.
    "npx vite preview --host 127.0.0.1 --port {port} --strictPort",
    // Fallback: the development server renders the same pages.
    "npx vite --host 127.0.0.1 --port {port} --strictPort",
  ];
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((ok) => {
    if (child.exitCode !== null || child.signalCode !== null) return ok();
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // already gone
      }
      ok();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      ok();
    });
    try {
      // The whole process group: npx, vite and anything they started.
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      clearTimeout(timer);
      ok();
    }
  });
}

/** Waits until the server answers "/" with a page, or gives up. */
async function waitForPage(url: string, child: ChildProcess, timeoutMs: number): Promise<string | null> {
  const until = Date.now() + timeoutMs;
  let answering = 0;
  while (Date.now() < until) {
    if (child.exitCode !== null) return `exited with code ${child.exitCode}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const type = res.headers.get("content-type") ?? "";
      if (res.status < 500 && type.includes("html")) return null;
      // Listening but not serving the site (e.g. vite preview without a build): give up soon.
      answering ||= Date.now();
      if (Date.now() - answering > 8000) return `answered "/" with HTTP ${res.status} instead of a page`;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return `didn't answer within ${Math.round(timeoutMs / 1000)}s`;
}

/** Starts the first command that serves the site and returns its address. */
export async function startAppServer(
  cwd: string,
  opts: { custom?: string; log: (s: string) => void; timeoutMs?: number },
): Promise<AppServer> {
  const commands = serveCommands(cwd, opts.custom);
  if (!commands.length) {
    throw new Error('The build has no index.html and the project has no Vite to serve it. Set "source.outDir" or "source.serveCommand" in luvhub.json.');
  }
  const errors: string[] = [];
  for (const template of commands) {
    const port = await freePort();
    const command = template.replaceAll("{port}", String(port));
    const url = `http://127.0.0.1:${port}/`;
    opts.log(`$ ${command}`);
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "true", PORT: String(port), HOST: "127.0.0.1", BROWSER: "none" },
    });
    const tail: string[] = [];
    const keep = (d: Buffer) => {
      for (const line of d.toString().split("\n")) if (line.trim()) tail.push(line.trimEnd());
      tail.splice(0, Math.max(0, tail.length - 15));
    };
    child.stdout!.on("data", keep);
    child.stderr!.on("data", keep);
    const problem = await waitForPage(url, child, opts.timeoutMs ?? 90_000);
    if (!problem) {
      opts.log(`Serving the site at ${url}`);
      return { url, command, close: () => stop(child) };
    }
    await stop(child);
    errors.push(`"${command}" ${problem}${tail.length ? `:\n${tail.join("\n")}` : ""}`);
    opts.log(`"${command}" ${problem}.`);
  }
  throw new Error(`Couldn't start the site to render it.\n${errors.join("\n")}`);
}
