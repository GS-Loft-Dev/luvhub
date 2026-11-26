"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { I, Mark, Spinner } from "./ui";

/* ------------------------------------------------------------------ types */

interface Setup {
  setup: {
    lovableOAuth: boolean;
    lovableApiKey: boolean;
    hubspotOAuth: boolean;
    hubspotToken: boolean;
    githubOAuth: boolean;
    githubToken: boolean;
    embedAvailable: boolean;
  };
  lovable: { connected: boolean; viaKey: boolean };
  hubspot: { portalId: number; hubDomain?: string; viaToken: boolean } | null;
  github: { login: string; viaToken: boolean } | null;
}

interface Project {
  id: string;
  name: string;
  description: string | null;
  isPublished: boolean;
  screenshotUrl: string | null;
  lastEditedAt: string | null;
}

interface FieldSummary { name: string; label: string; type: string; children?: { name: string; type: string }[]; items?: number }
interface ModuleSummary { id: string; name: string; label: string; kind: "header" | "footer" | "section"; included: boolean; fields: FieldSummary[] }
interface PageSummary { route: string; label: string; description: string; templateName: string; hubspotPageId: string | null }
interface JobSummary {
  id: string;
  source: { kind: string; label: string; url?: string };
  createdAt?: string;
  automation?: { repo: string; branch: string; source: "lovable" | "build" | "url"; at: string; actionsUrl: string } | null;
  theme: { name: string; label: string };
  pageType: "landing" | "site";
  warnings: string[];
  assets: number;
  pages: PageSummary[];
  modules: ModuleSummary[];
}

interface PublishedPage { route: string; title: string; status: "created" | "updated" | "failed" | "skipped"; id?: string; editUrl?: string; error?: string }
interface PublishResult {
  ok: boolean;
  portalId: number;
  themePath: string;
  designManagerUrl: string;
  steps: { path: string; status: "uploaded" | "failed" | "skipped"; error?: string }[];
  pages: PublishedPage[];
}

type DockTab = "status" | "log" | "pages" | "sync" | "warnings" | "settings";

/* ------------------------------------------------------------------ helpers */

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

const commitOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key === "Enter") e.currentTarget.blur();
};
const pad = (n: number) => String(n).padStart(2, "0");
const clock = (s: number) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;

/* Canvas geometry, in design units; the canvas is scaled to fit the window. */
const W = 1010;
const H = 500;
const STEPS = ["Connect", "Convert", "Review", "Publish", "Sync"];
const WIRES: [string, string][] = [
  ["src.site", "conv.source"],
  ["src.pages", "pages.in"],
  ["src.mods", "excl.in"],
  ["pages.out", "conv.pages"],
  ["excl.out", "conv.mods"],
  ["conv.theme", "prev.in"],
];

function Port({ id, c }: { id?: string; c: "y" | "g" | "r" | "b" }) {
  return <span className={`port ${c}`} data-port={id} />;
}

function Caret() {
  return <span className="caret" aria-hidden />;
}

/* ------------------------------------------------------------------ page */

export default function Studio() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [job, setJob] = useState<JobSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // source
  const [mode, setMode] = useState<"lovable" | "url">("lovable");
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [url, setUrl] = useState("");
  const [routes, setRoutes] = useState("/");
  const [themeName, setThemeName] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [lastSeconds, setLastSeconds] = useState(0);

  // review and publish
  const [pageIdx, setPageIdx] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [openModule, setOpenModule] = useState<string | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  // canvas chrome
  const [dock, setDock] = useState<DockTab>("status");
  const [zoom, setZoom] = useState(1);
  const [showWires, setShowWires] = useState(true);
  const [showGlow, setShowGlow] = useState(true);
  const [size, setSize] = useState({ w: 1200, h: 700 });
  const [paths, setPaths] = useState<string[]>([]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  /* -------------------------------------------------------------- data */

  const refreshSetup = useCallback(async () => {
    try {
      const s = await api<Setup>("/api/setup");
      setSetup(s);
      if (!(s.setup.lovableOAuth || s.setup.lovableApiKey)) setMode("url");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refreshSetup();
    const params = new URLSearchParams(location.search);
    const auth = params.get("auth");
    if (auth?.endsWith(":denied")) setError("Login was cancelled.");
    const jobId = params.get("job");
    if (jobId) api<JobSummary>(`/api/jobs/${jobId}`).then(setJob).catch(() => undefined);
    // Back from the GitHub login started in the sync panel: reopen it.
    if (jobId && params.get("automate")) {
      setSyncOpen(true);
      params.delete("automate");
      history.replaceState(null, "", `${location.pathname}?${params}`);
    }
    if (auth) {
      params.delete("auth");
      history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
    }
  }, [refreshSetup]);

  const lovableOn = Boolean(setup && (setup.lovable.connected || setup.lovable.viaKey));
  const lovableAvailable = Boolean(setup && (setup.setup.lovableOAuth || setup.setup.lovableApiKey));
  const hubspot = setup?.hubspot ?? null;

  useEffect(() => {
    if (!lovableOn || mode !== "lovable" || job) return;
    api<{ projects: Project[] }>("/api/lovable/projects")
      .then((r) => setProjects(r.projects))
      .catch((e) => setError(e.message));
  }, [lovableOn, mode, job]);

  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(t);
  }, [busy]);

  const project = projects?.find((p) => p.id === projectId) ?? null;
  const routeList = routes.split(/[,\s]+/).filter(Boolean);
  const canConvert = !job && !busy && (mode === "url" ? url.trim().length > 4 : Boolean(project));
  const target = mode === "url" ? url.trim().replace(/^https?:\/\//, "").replace(/\/$/, "") : project?.name ?? "";

  const setJobAndUrl = (j: JobSummary | null) => {
    setJob(j);
    setResult(null);
    setPageIdx(0);
    setDock("status");
    const params = new URLSearchParams(location.search);
    if (j) params.set("job", j.id);
    else params.delete("job");
    history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  };

  const convert = async () => {
    if (!canConvert) return;
    setError(null);
    setBusy(true);
    const started = performance.now();
    try {
      const { id } = await api<{ id: string }>("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          source: mode,
          url: mode === "url" ? url : undefined,
          projectId: project?.id,
          projectName: project?.name,
          routes: routeList,
          themeName: themeName || project?.name || undefined,
        }),
      });
      setJobAndUrl(await api<JobSummary>(`/api/jobs/${id}`));
      setLastSeconds((performance.now() - started) / 1000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const patch = useCallback(
    async (body: unknown) => {
      if (!job) return;
      try {
        setJob(await api<JobSummary>(`/api/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify(body) }));
        setPreviewKey((k) => k + 1);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [job],
  );

  const publish = async () => {
    if (!job) return;
    setError(null);
    setPublishing(true);
    setDock("status");
    try {
      const r = await api<PublishResult>(`/api/jobs/${job.id}/publish`, { method: "POST" });
      setResult(r);
      if (!r.ok) setDock("log");
      setJob(await api<JobSummary>(`/api/jobs/${job.id}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPublishing(false);
    }
  };

  /* -------------------------------------------------------------- canvas */

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const flow = size.w < 900;
  const fit = Math.max(0.6, Math.min(1.45, (size.w - 190) / W, (size.h - 160) / H));
  const scale = flow ? 1 : fit * zoom;

  // Wires follow the ports wherever the layout puts them.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || flow) return;
    const box = canvas.getBoundingClientRect();
    const at = (id: string) => {
      const el = canvas.querySelector<HTMLElement>(`[data-port="${id}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: (r.left + r.width / 2 - box.left) / scale, y: (r.top + r.height / 2 - box.top) / scale };
    };
    const next = WIRES.flatMap(([a, b]) => {
      const p = at(a);
      const q = at(b);
      if (!p || !q) return [];
      const dx = Math.max(40, Math.abs(q.x - p.x) / 2);
      return [`M${p.x},${p.y} C${p.x + dx},${p.y} ${q.x - dx},${q.y} ${q.x},${q.y}`];
    });
    if (next.join() !== paths.join()) setPaths(next);
  });

  /* -------------------------------------------------------------- derived */

  const stats = useMemo(() => {
    const mods = job?.modules ?? [];
    const included = mods.filter((m) => m.included);
    return { included: included.length, total: mods.length, fields: included.reduce((n, m) => n + m.fields.length, 0) };
  }, [job]);
  const page = job?.pages[Math.min(pageIdx, job.pages.length - 1)] ?? null;
  const openUrl = result?.pages.find((p) => p.route === page?.route)?.editUrl ?? result?.pages.find((p) => p.editUrl)?.editUrl;
  const current = job?.modules.find((m) => m.id === openModule) ?? null;
  const pagesOk = result?.pages.filter((p) => p.editUrl).length ?? 0;
  // Connected means: a source to read from (Lovable, or a plain URL) and HubSpot to publish to.
  const connectedAll = Boolean(hubspot) && (lovableOn || mode === "url");
  const synced = Boolean(job?.automation);
  const doneSteps = [connectedAll || Boolean(job), Boolean(job), Boolean(result) || synced, Boolean(result?.ok) || synced, synced];
  const step = doneSteps.indexOf(false) + 1 || 5;

  const status: ReactNode = !setup ? (
    "Loading…"
  ) : busy ? (
    <>Rendering <b>{target}</b> · {clock(elapsed)}. A headless browser opens the page, scrolls it and captures DOM, CSS and images.</>
  ) : publishing ? (
    "Publishing to HubSpot: images to the File Manager, the theme to the Design Manager, then the draft pages."
  ) : result ? (
    result.ok ? (
      <>Published. {pagesOk} draft page{pagesOk === 1 ? "" : "s"} in HubSpot, already titled: {result.pages.filter((p) => p.editUrl).map((p, i) => (
        <span key={p.route}>{i > 0 && ", "}<a href={p.editUrl} target="_blank" rel="noreferrer">{p.title}</a></span>
      ))}.</>
    ) : (
      <>Published with issues: {result.steps.filter((s) => s.status === "failed").length} files and {result.pages.length - pagesOk} pages failed. See the log.</>
    )
  ) : job?.automation ? (
    <>Sync is on: every change pushed to <b>{job.automation.repo}</b> updates the HubSpot pages. <button className="linkish" onClick={() => setDock("sync")}>See the sync history</button>.</>
  ) : job ? (
    <>{stats.included} modules and {stats.fields} editable fields ready. Each page becomes a draft HubSpot {job.pageType === "site" ? "website page" : "landing page"} titled <b>“{page?.label}”</b>. {hubspot ? "Press Publish." : "Connect HubSpot to publish."}</>
  ) : mode === "lovable" && !lovableOn && !hubspot ? (
    "Connect Lovable in node 1 and HubSpot with the button top right: one click each."
  ) : mode === "url" && !url.trim() ? (
    <>Paste the address of a published Lovable site in node 1.{hubspot ? "" : " Connect HubSpot (top right) to publish."}</>
  ) : mode === "lovable" && !project ? (
    lovableOn ? "Pick a Lovable project in the Source node." : "Connect Lovable, or switch the Source node to URL."
  ) : (
    <>Ready to convert <b>{target}</b>: press Convert.</>
  );

  const hint: { cls: string; text: string; x: number; y: number } | null = flow || busy
    ? null
    : !job && mode === "lovable" && !lovableOn && setup?.setup.lovableOAuth
      ? { cls: "y", text: "Connect", x: 160, y: 318 }
      : !job && mode === "lovable" && lovableOn && !project
        ? { cls: "y", text: "Pick a project", x: 160, y: 318 }
        : canConvert
          ? { cls: "b", text: "Convert", x: 452, y: 14 }
          : job && !result && !synced
            ? { cls: "p", text: "Title from Lovable", x: 420, y: 124 }
            : job && result?.ok && !synced
              ? { cls: "y", text: "Keep it in sync", x: 168, y: 470 }
              : null;

  /* -------------------------------------------------------------- render */

  return (
    <div className="studio">
      {/* top bar */}
      <header className="tb">
        <div className="tb-left">
          <a href="/" className="brand keep" aria-label="luvhub home" style={{ marginRight: 10 }}><Mark size={24} /><span className="brand-word">luvhub</span></a>
          <button className="pill-btn" onClick={() => setJobAndUrl(null)} disabled={!job || busy || publishing} title="Close this conversion and start a new one"><I.plus /> New conversion</button>
          <button className={`pill-btn ${dock === "settings" ? "on" : ""}`} onClick={() => setDock("settings")} title="Routes and theme name"><I.gear /> Settings</button>
          <a className="pill-btn" href="/tutorial" title="Step-by-step guide"><I.book /> Help</a>
        </div>

        <ol className="steps" aria-label="Progress">
          {STEPS.map((label, i) => {
            const n = i + 1;
            const done = doneSteps[i];
            const state = done ? "done" : n === step ? "now" : "next";
            return (
              <li key={label} className={state} aria-current={state === "now" ? "step" : undefined}>
                <span className="n">{state === "done" ? <I.check /> : n}</span> {label}
              </li>
            );
          })}
        </ol>

        <div className="tb-right">
          {job ? (
            <span className="pill-btn tab" title={job.source.label}>
              <I.file /> {job.theme.label}
              <button className="x" aria-label="Close this conversion" title="Close this conversion" onClick={() => setJobAndUrl(null)} disabled={busy || publishing}><I.close width={11} height={11} /></button>
            </span>
          ) : (
            <button className="pill-btn primary" onClick={convert} disabled={!canConvert} title={canConvert ? `Convert ${target}` : "Pick a source first"}>
              {busy ? <Spinner /> : <I.play />} {busy ? `Converting · ${clock(elapsed)}` : "Convert"}
            </button>
          )}
        </div>
      </header>

      {/* sub bar */}
      <div className="sb">
        <div aria-hidden />
        <div className="sb-title">{job ? `${job.source.label} → hubspot · ${job.theme.name}/` : "lovable → hubspot · luvhub"}</div>
        <div className="sb-right">
          {!hubspot && setup?.setup.hubspotOAuth ? (
            <a className="btn-white" href="/api/auth/hubspot/login"><I.login /> Connect HubSpot</a>
          ) : (
            <button className="btn-white" onClick={publish} disabled={!job || !hubspot || publishing || stats.included === 0}>
              {publishing ? <Spinner /> : <I.share />} {result ? "Publish again" : "Publish"}
            </button>
          )}
          {openUrl ? (
            <a className="pill-btn tall" href={openUrl} target="_blank" rel="noreferrer"><I.external /> Open in HubSpot</a>
          ) : job ? (
            <a className="pill-btn tall" href={`/api/jobs/${job.id}/zip`}><I.download /> Download .zip</a>
          ) : (
            <button className="pill-btn tall" disabled><I.download /> Download .zip</button>
          )}
        </div>
      </div>

      {error && (
        <div className="toast" role="alert">
          <div>{error}</div>
          <button className="icon-btn" onClick={() => setError(null)} aria-label="Dismiss"><I.close /></button>
        </div>
      )}

      {/* canvas */}
      <div className={`viewport ${flow ? "flowmode" : ""}`} ref={viewportRef}>
        <div className="canvas" ref={canvasRef} style={flow ? undefined : { width: W, height: H, transform: `translateX(-50%) scale(${scale})`, top: 24 }}>
          {showGlow && (
            <>
              <span className="glow" style={{ left: 600, top: 70, width: 150, height: 120, background: "#c25bb7" }} />
              <span className="glow" style={{ left: 880, top: 20, width: 120, height: 110, background: "#4d8fd6" }} />
              <span className="glow" style={{ left: 560, top: 150, width: 120, height: 90, background: "#5a3f9b" }} />
            </>
          )}

          {showWires && (
            <svg className={`wires ${busy || publishing ? "flow" : ""}`} width={W} height={H} aria-hidden>
              {paths.map((d, i) => <path key={i} d={d} />)}
            </svg>
          )}

          {/* Source node */}
          <div className="node" style={{ left: 0, top: 150, width: 205 }}>
            <div className="node-title"><span><span className="num">1</span> Source <em>where the site is</em></span></div>
            <div className={`frame ${!job ? "active" : ""}`}>
              <div className="inner">
                <div className="io">
                  {!job && setup && lovableAvailable ? (
                    <div className="mini-tabs" role="tablist" aria-label="Source type" style={{ alignSelf: "start" }}>
                      <button role="tab" aria-selected={mode === "lovable"} className={mode === "lovable" ? "on" : ""} onClick={() => setMode("lovable")}>Lovable</button>
                      <button role="tab" aria-selected={mode === "url"} className={mode === "url" ? "on" : ""} onClick={() => setMode("url")}>URL</button>
                    </div>
                  ) : <span />}
                  <div className="ports right">
                    <div>site <Port id="src.site" c="y" /></div>
                    <div>pages <Port id="src.pages" c="g" /></div>
                    <div>modules <Port id="src.mods" c="r" /></div>
                  </div>
                </div>
                {job ? (
                  <div className="nf big"><I.source /><span className="val">{job.source.label}</span></div>
                ) : !setup ? (
                  <div className="nf big"><Spinner /> <span className="val muted">Loading…</span></div>
                ) : mode === "url" ? (
                  <label className="nf big">
                    <I.source />
                    <span className="sr-only">Published site URL</span>
                    <input type="url" placeholder="your-project.lovable.app" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && convert()} />
                  </label>
                ) : !lovableAvailable ? (
                  <a className="nf big" href="/tutorial#setup"><I.book /><span className="val">Lovable login not set up</span></a>
                ) : !lovableOn ? (
                  <a className="nf big" href="/api/auth/lovable/login"><I.login /><span className="val">Connect Lovable</span><Caret /></a>
                ) : (
                  <label className="nf big">
                    <I.layers />
                    <span className="val">{project?.name ?? (projects ? "Choose a project" : "Loading projects…")}</span>
                    <Caret />
                    <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Lovable project">
                      <option value="">Choose a project</option>
                      {projects?.map((p) => <option key={p.id} value={p.id}>{p.name}{p.isPublished ? "" : " (draft)"}</option>)}
                    </select>
                  </label>
                )}
              </div>
            </div>
          </div>

          {/* Pages group */}
          <div className="node group-label" style={{ left: 258, top: 0, width: 207 }}>
            <div className="node-title" style={{ margin: 0 }}>
              <span><span className="num">2</span> Pages <em>titles</em></span>
              <button className="chip-go" onClick={convert} disabled={!canConvert}>{busy ? <Spinner /> : <I.sparkle />} Convert</button>
            </div>
          </div>

          <div className="node" style={{ left: 255, top: 30, width: 210 }}>
            <div className="frame">
              <div className="inner">
                <div className="inner-head">
                  <span><Port id="pages.in" c="g" /> Title</span>
                  <Port id="pages.out" c="g" />
                </div>
                {job && page ? (
                  <>
                    <p className="copy">{page.description || `Read from the <title> of ${page.route}. It becomes the HubSpot page name and SEO title.`}</p>
                    <input
                      className="nf"
                      type="text"
                      aria-label={`Title of ${page.route}`}
                      placeholder="Type the page title"
                      defaultValue={page.label}
                      key={`t-${page.route}-${page.label}`}
                      onKeyDown={commitOnEnter}
                      onBlur={(e) => e.target.value.trim() && e.target.value !== page.label && patch({ pages: [{ route: page.route, label: e.target.value }] })}
                    />
                    <div className="mini-tabs page-type" role="tablist" aria-label="HubSpot page type">
                      <button role="tab" aria-selected={job.pageType !== "site"} className={job.pageType !== "site" ? "on" : ""} onClick={() => job.pageType === "site" && patch({ pageType: "landing" })}>Landing page</button>
                      <button role="tab" aria-selected={job.pageType === "site"} className={job.pageType === "site" ? "on" : ""} onClick={() => job.pageType !== "site" && patch({ pageType: "site" })}>Website page</button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="copy">Each Lovable page becomes a draft HubSpot landing page, with the same title already set.</p>
                    <input className="nf mono" type="text" aria-label="Routes to convert" placeholder="Type the routes: / , /about" value={routes} onChange={(e) => setRoutes(e.target.value)} disabled={busy} />
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Exclude node */}
          <div className="node" style={{ left: 255, top: 232, width: 210 }}>
            <div className="frame">
              <div className="inner">
                <div className="inner-head">
                  <span><Port id="excl.in" c="r" /> Exclude</span>
                  <Port id="excl.out" c="r" />
                </div>
                <p className="copy">Header, sections and footer become modules. Switch off what you don&apos;t want on HubSpot.</p>
                {job ? (
                  <div className="mods">
                    {job.modules.map((m) => (
                      <div key={m.id} className={`mod ${m.included ? "" : "off"}`}>
                        <button className="name" onClick={() => setOpenModule(m.id)} title="Open module">{m.label}</button>
                        <small>{m.fields.length}</small>
                        <label className="switch">
                          <input type="checkbox" checked={m.included} aria-label={`Include ${m.label}`} onChange={(e) => patch({ modules: [{ id: m.id, included: e.target.checked }] })} />
                          <i />
                        </label>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="nf"><span className="val muted">Modules appear after the conversion</span></div>
                )}
              </div>
            </div>
          </div>

          {/* Sync node */}
          <div className="node" style={{ left: 0, top: 338, width: 205 }}>
            <div className="node-title"><span><span className="num">5</span> Sync <em>Lovable → HubSpot, always</em></span></div>
            <div className={`frame ${job && !synced && result?.ok ? "active" : ""}`}>
              <div className="inner">
                <div className="inner-head">
                  <span><Port c={synced ? "g" : "r"} /> {synced ? "On" : "Off"}</span>
                  {job?.automation && <code>{job.automation.source === "url" ? "on publish" : "every edit"}</code>}
                </div>
                <p className="copy">
                  {job?.automation ? <>Every push to <b>{job.automation.repo}</b> updates the HubSpot pages.</> : "A GitHub Action updates the HubSpot pages after every Lovable edit."}
                </p>
                <button className="nf" onClick={() => setSyncOpen(true)} disabled={!job}>
                  <I.refresh /><span className="val">{synced ? "Sync settings" : job ? "Set up sync" : "Available after converting"}</span>{job && <Caret />}
                </button>
              </div>
            </div>
          </div>

          {/* Converter node */}
          <div className="node" style={{ left: 505, top: 98, width: 210 }}>
            <div className="node-title"><span><span className="num">3</span> Theme <em>what HubSpot receives</em></span></div>
            <div className="frame">
              <div className="inner">
                <div className="io">
                  <div className="ports">
                    <div><Port id="conv.source" c="y" /> source</div>
                    <div><Port id="conv.pages" c="g" /> pages</div>
                    <div><Port id="conv.mods" c="r" /> modules</div>
                  </div>
                  <div className="ports right"><div>theme <Port id="conv.theme" c="b" /></div></div>
                </div>

                <div className="row">
                  <span>Theme name</span>
                  {job ? (
                    <input className="nf" type="text" aria-label="Theme label" defaultValue={job.theme.label} key={`tl-${job.theme.label}`} onKeyDown={commitOnEnter} onBlur={(e) => e.target.value !== job.theme.label && patch({ theme: { label: e.target.value } })} />
                  ) : (
                    <input className="nf" type="text" aria-label="Theme name" placeholder={project?.name ?? "my-landing"} value={themeName} onChange={(e) => setThemeName(e.target.value)} disabled={busy} />
                  )}
                </div>
                <div className="row">
                  <span>Folder</span>
                  {job ? (
                    <input className="nf mono" type="text" aria-label="Theme folder" defaultValue={job.theme.name} key={`tn-${job.theme.name}`} onKeyDown={commitOnEnter} onBlur={(e) => e.target.value !== job.theme.name && patch({ theme: { name: e.target.value } })} />
                  ) : (
                    <div className="nf mono"><span className="val muted">auto</span></div>
                  )}
                </div>
                <div className="row">
                  <span>Page</span>
                  <div className="step">
                    <button aria-label="Previous page" disabled={!job || pageIdx === 0} onClick={() => setPageIdx((i) => i - 1)}><I.left /></button>
                    <div className="nf"><span className="val">{job ? `${pageIdx + 1}/${job.pages.length}` : routeList.length}</span></div>
                    <button aria-label="Next page" disabled={!job || pageIdx >= job.pages.length - 1} onClick={() => setPageIdx((i) => i + 1)}><I.right /></button>
                  </div>
                </div>
                <div className="row">
                  <span>Modules</span>
                  <div className="nf"><span className="val">{job ? `${stats.included} / ${stats.total}` : "—"}</span></div>
                </div>
                <div className="row">
                  <span>{busy ? "Time" : "Fields"}</span>
                  <div className="nf"><span className="val">{busy ? clock(elapsed) : job ? stats.fields : "—"}</span></div>
                </div>
              </div>
            </div>
          </div>

          {/* Preview node */}
          <div className="node" style={{ left: 775, top: 6, width: 235 }}>
            <div className="node-title"><span><span className="num">4</span> Preview <em>the page on HubSpot</em></span></div>
            <div className="frame">
              <div className="inner" style={{ padding: 8 }}>
                <div className="inner-head" style={{ margin: "2px 2px 8px" }}><span><Port id="prev.in" c="b" /> page</span>{job && <code>{page?.route}</code>}</div>
                <div className="shot">
                  {job && page ? (
                    <iframe key={`${page.route}-${previewKey}`} src={`/api/jobs/${job.id}/page-preview?route=${encodeURIComponent(page.route)}`} title={`Preview of ${page.label}`} sandbox="allow-same-origin" />
                  ) : project?.screenshotUrl && !busy ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={project.screenshotUrl} alt="" />
                  ) : (
                    <>
                      <span className="blob" />
                      {busy && <span className="empty-msg"><span style={{ display: "grid", gap: 8, justifyItems: "center" }}><Spinner /> Rendering…</span></span>}
                    </>
                  )}
                  <div className="veil">
                    <h4>{job && page ? page.label : target || "Final result"}</h4>
                    <p>{job && page ? page.description || `${job.source.label}${page.route}` : "The Lovable page appears here, then lands on HubSpot with its title already set."}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="toolbar-wrap" style={{ position: "absolute", left: 775, top: 410 }}>
            <div className="toolbar">
              {job && page ? (
                <a className="tool" href={`/api/jobs/${job.id}/page-preview?route=${encodeURIComponent(page.route)}`} target="_blank" rel="noreferrer" aria-label="Open the preview full size"><I.fit /></a>
              ) : (
                <button className="tool" disabled aria-label="Open the preview full size"><I.fit /></button>
              )}
              <button className="tool" aria-label="Reload preview" disabled={!job} onClick={() => setPreviewKey((k) => k + 1)}><I.refresh /></button>
              <button className="tool" aria-label="Copy page title" disabled={!page} onClick={() => page && navigator.clipboard?.writeText(page.label)}><I.file /></button>
              <button className="tool" aria-label="Open modules" disabled={!job} onClick={() => job && setOpenModule(job.modules[0]?.id ?? null)}><I.eye /></button>
              <label className="tool wide">
                {page?.route ?? "/"} <I.chevron className="chev" />
                <select aria-label="Page" value={pageIdx} onChange={(e) => setPageIdx(Number(e.target.value))} disabled={!job}>
                  {job?.pages.map((p, i) => <option key={p.route} value={i}>{p.route}</option>)}
                </select>
              </label>
              {job ? (
                <a className="tool" href={`/api/jobs/${job.id}/zip`} aria-label="Download theme .zip"><I.download /></a>
              ) : (
                <button className="tool" disabled aria-label="Download theme .zip"><I.download /></button>
              )}
            </div>
          </div>

          {hint && (
            <div className={`hint ${hint.cls}`} style={{ left: hint.x, top: hint.y }} aria-hidden>
              <I.cursor style={{ rotate: "-80deg" }} />
              <span>{hint.text}</span>
            </div>
          )}
        </div>
      </div>

      {/* zoom rail */}
      <div className="zoom" role="toolbar" aria-label="Canvas">
        <button className="tool" aria-label="Zoom in" title="Zoom in" onClick={() => setZoom((z) => Math.min(1.6, z + 0.1))}><I.plus /></button>
        <button className="tool" aria-label="Zoom out" title="Zoom out" onClick={() => setZoom((z) => Math.max(0.6, z - 0.1))}><I.minus /></button>
        <button className="tool" aria-label="Fit to screen" title="Fit to screen" onClick={() => setZoom(1)}><I.fit /></button>
        <button className={`tool ${showWires ? "on" : ""}`} aria-label="Show wires" title="Show or hide the wires" aria-pressed={showWires} onClick={() => setShowWires((v) => !v)}><I.eye /></button>
        <button className={`tool ${showGlow ? "on" : ""}`} aria-label="Show glow" title="Show or hide the glow" aria-pressed={showGlow} onClick={() => setShowGlow((v) => !v)}><I.layers /></button>
      </div>

      {/* corner stats */}
      <div className="stats l" aria-label="Conversion stats">
        <span>T: {lastSeconds.toFixed(2)}s</span>
        <span>P: {job?.pages.length ?? routeList.length}</span>
        <span>M: {stats.included} ({stats.total})</span>
        <span>F: {stats.fields}</span>
      </div>
      <div className="stats r" aria-label="Connection stats">
        <span>L: {lovableOn ? "on" : "off"}</span>
        <span>H: {hubspot ? hubspot.portalId : "off"}</span>
        <span>A: {job?.assets ?? 0}</span>
        <span>S: {busy ? "render" : publishing ? "publish" : result ? (result.ok ? "live" : "issues") : job ? "review" : "idle"}</span>
      </div>

      {/* status dock */}
      <div className="dock">
        <div className="dock-body" aria-live="polite">
          {dock === "status" && (<><div className="lbl">Status</div><div className="txt">{status}</div></>)}
          {dock === "log" && (
            <>
              <div className="lbl">Publish log</div>
              {result ? (
                <div className="log">
                  {result.steps.map((s) => (
                    <div key={s.path} className={s.status === "failed" ? "bad" : s.status === "skipped" ? "skip" : ""} title={s.path}>
                      {s.status === "uploaded" ? "✓" : s.status === "failed" ? "✗" : "–"} {s.path}{s.error ? ` — ${s.error}` : ""}
                    </div>
                  ))}
                  {result.pages.map((p) => (
                    <div key={p.route} className={p.editUrl ? "" : "bad"}>{p.editUrl ? "✓" : "✗"} page {p.route} “{p.title}” {p.status}{p.error ? ` — ${p.error}` : ""}</div>
                  ))}
                </div>
              ) : <div className="txt muted">Nothing published yet.</div>}
            </>
          )}
          {dock === "pages" && (
            <>
              <div className="lbl">HubSpot pages</div>
              {job ? (
                <ul className="txt">
                  {job.pages.map((p) => {
                    const out = result?.pages.find((r) => r.route === p.route);
                    return <li key={p.route}><code>{p.route}</code> “{p.label}” {out?.editUrl ? <a href={out.editUrl} target="_blank" rel="noreferrer">open draft</a> : p.hubspotPageId ? `linked #${p.hubspotPageId}` : "not published yet"}</li>;
                  })}
                </ul>
              ) : <div className="txt muted">Pages appear after the conversion.</div>}
            </>
          )}
          {dock === "sync" && <SyncHistory job={job} onSetUp={() => setSyncOpen(true)} />}
          {dock === "warnings" && (
            <>
              <div className="lbl">Warnings</div>
              {job?.warnings.length ? <ul className="txt">{job.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : <div className="txt muted">No warnings.</div>}
            </>
          )}
          {dock === "settings" && (
            <>
              <div className="lbl">Settings</div>
              <div className="grid2">
                <label>Routes to convert<input className="nf mono" value={routes} onChange={(e) => setRoutes(e.target.value)} disabled={Boolean(job) || busy} /></label>
                <label>Theme name<input className="nf" placeholder={project?.name ?? "my-landing"} value={job ? job.theme.label : themeName} onChange={(e) => setThemeName(e.target.value)} disabled={Boolean(job) || busy} /></label>
              </div>
            </>
          )}
        </div>
        <div className="dock-tools" role="tablist" aria-label="Dock">
          {([
            ["status", <I.history key="i" />, "Status"],
            ["log", <I.file key="i" />, "Publish log"],
            ["pages", <I.cube key="i" />, "HubSpot pages"],
            ["sync", <I.refresh key="i" />, "Sync history"],
          ] as const).map(([id, icon, label]) => (
            <button key={id} role="tab" aria-selected={dock === id} aria-label={label} title={label} className={`tool ${dock === id ? "on wide" : ""}`} onClick={() => setDock(id)}>{icon}{dock === id && <span>{label}</span>}</button>
          ))}
          <a className="tool" href="/tutorial" aria-label="Tutorial" title="Tutorial"><I.book /></a>
          <span className="sep" />
          <button role="tab" aria-selected={dock === "warnings"} aria-label="Warnings" title="Warnings" className={`tool ${dock === "warnings" ? "on wide" : ""}`} onClick={() => setDock("warnings")}><I.sun />{dock === "warnings" && <span>Warnings</span>}</button>
          <button role="tab" aria-selected={dock === "settings"} aria-label="Settings" title="Settings" className={`tool ${dock === "settings" ? "on wide" : ""}`} onClick={() => setDock("settings")}><I.gear />{dock === "settings" && <span>Settings</span>}</button>
        </div>
      </div>

      {job && setup && syncOpen && (
        <SyncPanel
          job={job}
          setup={setup}
          onClose={() => setSyncOpen(false)}
          onDone={(j) => setJob(j)}
          onGithubChange={refreshSetup}
        />
      )}

      {job && current && <ModuleModal jobId={job.id} module={current} onClose={() => setOpenModule(null)} patch={patch} />}
    </div>
  );
}

interface SyncRun {
  id: number;
  status: string;
  conclusion: string | null;
  event: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  sha: string;
  message: string | null;
  actor: string | null;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

function runState(r: SyncRun): { icon: string; label: string; cls: string } {
  if (r.status !== "completed") return { icon: "…", label: r.status === "queued" ? "queued" : "running", cls: "skip" };
  if (r.conclusion === "success") return { icon: "✓", label: "done", cls: "" };
  if (r.conclusion === "cancelled" || r.conclusion === "skipped") return { icon: "–", label: r.conclusion, cls: "skip" };
  return { icon: "✗", label: "failed", cls: "bad" };
}

/** Latest runs of the luvhub workflow in the project's repository, refreshed while one is running. */
function SyncHistory({ job, onSetUp }: { job: JobSummary | null; onSetUp: () => void }) {
  const [runs, setRuns] = useState<SyncRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const id = job?.automation ? job.id : null;

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setRuns((await api<{ runs: SyncRun[] }>(`/api/jobs/${id}/sync-runs`)).runs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    setRuns(null);
    void load();
  }, [load]);

  const active = runs?.some((r) => r.status !== "completed") ?? false;
  useEffect(() => {
    if (!active && !starting) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [active, starting, load]);

  if (!job?.automation) {
    return (
      <>
        <div className="lbl">Sync history</div>
        <div className="txt muted">
          {job ? <>Sync is off. <button className="linkish" onClick={onSetUp}>Set up sync</button> to update HubSpot after every Lovable edit.</> : "Convert a project and turn on sync to see its history here."}
        </div>
      </>
    );
  }

  const syncNow = async () => {
    setStarting(true);
    try {
      await api(`/api/jobs/${job.id}/sync-runs`, { method: "POST", body: JSON.stringify({ force: true }) });
      // GitHub lists a dispatched run after a few seconds.
      setTimeout(() => { void load(); setStarting(false); }, 4000);
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  };

  return (
    <>
      <div className="lbl hist-head">
        <span>Sync history · {job.automation.repo}</span>
        <span>
          <button className="linkish" onClick={() => void load()}>Refresh</button>
          {" · "}
          <button className="linkish" onClick={() => void syncNow()} disabled={starting || active}>{starting ? "Starting…" : "Sync now"}</button>
          {" · "}
          <a href={job.automation.actionsUrl} target="_blank" rel="noreferrer">All runs on GitHub</a>
        </span>
      </div>
      {error ? (
        <div className="txt bad-txt">{error}</div>
      ) : !runs ? (
        <div className="txt muted"><Spinner /> Loading…</div>
      ) : runs.length === 0 ? (
        <div className="txt muted">No runs yet. The first one starts a few seconds after sync is turned on.</div>
      ) : (
        <div className="log">
          {runs.map((r) => {
            const st = runState(r);
            return (
              <div key={r.id} className={st.cls} title={`${r.sha} · ${r.event}${r.actor ? ` · ${r.actor}` : ""}`}>
                {st.icon} {when(r.createdAt)} · {st.label} · {r.event === "workflow_dispatch" ? "manual" : r.message ?? r.sha}{" "}
                <a href={r.url} target="_blank" rel="noreferrer">log</a>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ module modal */

function ModuleModal({ jobId, module: m, onClose, patch }: { jobId: string; module: ModuleSummary; onClose: () => void; patch: (b: unknown) => void }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={m.label} onClick={(e) => e.stopPropagation()}>
        <div className="inner">
          <div className="inner-head" style={{ margin: 0 }}>
            <span><Port c={m.kind === "section" ? "g" : "y"} /> {m.label} · {m.kind === "section" ? "drag-and-drop section" : `fixed ${m.kind}`}</span>
            <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
              <label className="switch" title="Include">
                <input type="checkbox" checked={m.included} aria-label={`Include ${m.label}`} onChange={(e) => patch({ modules: [{ id: m.id, included: e.target.checked }] })} />
                <i />
              </label>
              <button className="icon-btn" onClick={onClose} aria-label="Close" autoFocus><I.close /></button>
            </span>
          </div>
        </div>
        <div className="preview"><iframe src={`/api/jobs/${jobId}/preview/${m.id}`} title={`Preview of ${m.label}`} sandbox="allow-same-origin" /></div>
        <div className="inner" style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <input className="nf" aria-label="Module label" defaultValue={m.label} key={`l-${m.label}`} onKeyDown={commitOnEnter} onBlur={(e) => e.target.value !== m.label && patch({ modules: [{ id: m.id, label: e.target.value }] })} />
            <input className="nf mono" aria-label="Module folder" defaultValue={m.name} key={`n-${m.name}`} onKeyDown={commitOnEnter} onBlur={(e) => e.target.value !== m.name && patch({ modules: [{ id: m.id, name: e.target.value }] })} />
          </div>
          <div className="chips">
            {m.fields.length === 0 && <span className="chip">Static, no editable fields</span>}
            {m.fields.map((f) => (
              <span key={f.name} className="chip" title={f.label}>
                <i className={`t-${f.type}`} />
                {f.type === "group" ? `${f.items}× ${f.children?.map((ch) => ch.type).join(", ")}` : f.label.replace(/^[A-Za-z]+ \d+ – /, "")}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ sync panel */

interface RepoSummary { fullName: string; owner: string; private: boolean; defaultBranch: string; pushedAt: string | null; description: string | null }
interface OwnerSummary { login: string; kind: "user" | "org"; avatarUrl: string; repos: number }
interface AutomateResult { repo: string; branch: string; started: "push" | "dispatch"; portalId: number | null; actionsUrl: string; configUrl: string }

/**
 * Sets up the GitHub Action from the dashboard: GitHub login, the repository
 * Lovable syncs the project to, when to update, and the HubSpot token, which
 * goes straight into an encrypted repository secret.
 */
function SyncPanel({ job, setup, onClose, onDone, onGithubChange }: {
  job: JobSummary;
  setup: Setup;
  onClose: () => void;
  onDone: (j: JobSummary) => void;
  onGithubChange: () => void;
}) {
  const gh = setup.github;
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [owners, setOwners] = useState<OwnerSummary[] | null>(null);
  // The account is always asked for, unless this conversion already syncs somewhere.
  const [owner, setOwner] = useState(job.automation?.repo.split("/")[0] ?? "");
  const [repo, setRepo] = useState(job.automation?.repo ?? "");
  const [filter, setFilter] = useState("");
  // Always Lovable's own render: the project's preview (every edit) or the published site.
  const fromProject = job.source.kind === "lovable";
  const [url, setUrl] = useState(job.source.url?.startsWith("https://") ? job.source.url : "");
  const [token, setToken] = useState("");
  const [lovableKey, setLovableKey] = useState("");
  const [secret, setSecret] = useState<boolean | null>(null);
  const [lovableSecret, setLovableSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<AutomateResult | null>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  useEffect(() => {
    if (!gh) return;
    api<{ repos: RepoSummary[]; owners: OwnerSummary[] }>("/api/github/repos")
      .then((r) => {
        setRepos(r.repos);
        setOwners(r.owners);
      })
      .catch((e) => setErr(e.message));
  }, [gh]);

  useEffect(() => {
    setSecret(null);
    if (!gh || !repo) return;
    api<{ exists: boolean; lovable?: boolean }>(`/api/github/secret?repo=${encodeURIComponent(repo)}`)
      .then((r) => {
        setSecret(r.exists);
        setLovableSecret(Boolean(r.lovable));
      })
      .catch(() => setSecret(false));
  }, [gh, repo]);

  const loginHref = `/api/auth/github/login?return=${encodeURIComponent(`/?job=${job.id}&automate=1`)}`;
  const shown = repos?.filter((r) => r.owner === owner && (!filter || r.fullName.toLowerCase().includes(filter.toLowerCase()))) ?? [];
  const chooseOwner = (login: string) => {
    setOwner(login);
    if (!repo.startsWith(`${login}/`)) setRepo("");
  };
  const needsToken = secret === false;
  const sourceReady = fromProject ? lovableSecret || Boolean(lovableKey.trim()) : /^https:\/\//.test(url);
  const ready = Boolean(gh && owner && repo && sourceReady && (!needsToken || token.trim()) && secret !== null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<AutomateResult>(`/api/jobs/${job.id}/automate`, {
        method: "POST",
        body: JSON.stringify({
          repo,
          url: fromProject ? undefined : url,
          hubspotToken: token.trim() || undefined,
          lovableKey: fromProject ? lovableKey.trim() || undefined : undefined,
        }),
      });
      setDone(r);
      setToken("");
      setLovableKey("");
      onDone(await api<JobSummary>(`/api/jobs/${job.id}`));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onClick={() => !busy && onClose()}>
      <div className="modal sync" role="dialog" aria-modal="true" aria-label="Keep HubSpot in sync" onClick={(e) => e.stopPropagation()}>
        <div className="inner">
          <div className="inner-head" style={{ margin: 0 }}>
            <span><span className="num-badge">5</span> Keep HubSpot in sync with Lovable</span>
            <button className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close"><I.close /></button>
          </div>
          <p className="copy" style={{ margin: "8px 0 0" }}>
            A GitHub Action in your Lovable project&apos;s repository reads the page as Lovable renders it, exactly like this conversion, and updates the same HubSpot pages after every change, titles included.
          </p>
        </div>

        {done ? (
          <div className="inner sync-done">
            <span className="tag-ok"><I.check /> Sync is on</span>
            <p className="copy">
              {done.started === "push" ? "The workflow was added to" : "The settings were updated in"} <b>{done.repo}</b> and the first sync is running.
              From now on every change pushed to <code>{done.branch}</code> updates HubSpot{done.portalId ? ` (portal ${done.portalId})` : ""}.
            </p>
            <div className="sync-actions">
              <a className="btn-white" href={done.actionsUrl} target="_blank" rel="noreferrer"><I.external /> Watch the sync</a>
              <a className="pill-btn tall" href={done.configUrl} target="_blank" rel="noreferrer"><I.file /> luvhub.json</a>
              <button className="pill-btn tall" onClick={onClose}>Close</button>
            </div>
          </div>
        ) : (
          <>
            <div className="inner sync-row">
              <span className="sn">1</span>
              <div>
                <b>GitHub account</b>
                <small>
                  {!gh ? (
                    "Sign in with your GitHub account: luvhub writes the workflow and its settings to the repository you pick."
                  ) : !gh.viaToken ? (
                    <>Signed in with your account <b className="inline">@{gh.login}</b>. Pick who owns the project&apos;s repository.</>
                  ) : setup.setup.githubOAuth ? (
                    <>Using the server&apos;s GitHub token (<b className="inline">@{gh.login}</b>) because nobody is signed in. Sign in to use your own account.</>
                  ) : (
                    <>Using the server&apos;s GitHub token (<b className="inline">@{gh.login}</b>). To let each person sign in with their own account, set <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code>.</>
                  )}
                </small>
              </div>
              {gh ? (
                <div className="owners" role="radiogroup" aria-label="GitHub account">
                  {gh.viaToken && setup.setup.githubOAuth && (
                    <a className="btn-white" href={loginHref}><I.login /> Sign in with your GitHub</a>
                  )}
                  {!owners ? (
                    <span className="sync-who"><Spinner /> Loading accounts…</span>
                  ) : owners.length === 0 ? (
                    <span className="sync-who">No repositories you can push to.</span>
                  ) : (
                    owners.map((o) => (
                      <button key={o.login} role="radio" aria-checked={owner === o.login} className={`owner ${owner === o.login ? "on" : ""}`} onClick={() => chooseOwner(o.login)}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`${o.avatarUrl}${o.avatarUrl.includes("?") ? "&" : "?"}s=48`} alt="" />
                        <span className="who">{o.login}<small>{o.kind === "org" ? "Organization" : "Personal"} · {o.repos} repo{o.repos === 1 ? "" : "s"}</small></span>
                        {owner === o.login && <I.check />}
                      </button>
                    ))
                  )}
                </div>
              ) : setup.setup.githubOAuth ? (
                <a className="btn-white" href={loginHref}><I.login /> Connect GitHub</a>
              ) : (
                <small className="warn">GitHub login isn&apos;t configured on this server (<code>GITHUB_CLIENT_ID</code>). <a href="/tutorial">How to set it up</a></small>
              )}
            </div>

            <div className={`inner sync-row ${gh && owner ? "" : "dim"}`}>
              <span className="sn">2</span>
              <div>
                <b>Repository</b>
                <small>The one Lovable syncs this project to (in Lovable: GitHub, Connect project).</small>
              </div>
              <div className="sync-field">
                <input className="nf" type="search" placeholder="Filter repositories" value={filter} onChange={(e) => setFilter(e.target.value)} disabled={!gh || !owner} aria-label="Filter repositories" />
                <label className="nf">
                  <I.cube />
                  <span className="val">{repo || (!gh ? "Connect GitHub first" : !owner ? "Choose an account first" : repos ? (shown.length ? "Choose a repository" : "No repositories here") : "Loading…")}</span>
                  <Caret />
                  <select value={repo} onChange={(e) => setRepo(e.target.value)} disabled={!gh || !repos || !owner} aria-label="Repository">
                    <option value="">Choose a repository</option>
                    {shown.map((r) => <option key={r.fullName} value={r.fullName}>{r.fullName.split("/")[1]}{r.private ? " (private)" : ""}</option>)}
                  </select>
                </label>
              </div>
            </div>

            <div className={`inner sync-row ${repo ? "" : "dim"}`}>
              <span className="sn">3</span>
              {fromProject ? (
                <>
                  <div>
                    <b>Lovable API key</b>
                    <small>
                      luvhub asks Lovable for the preview of your latest edit, the same render you converted here, so HubSpot updates after every edit.
                      Create it in Lovable: <i>Workspace settings → API keys</i>. It is stored encrypted as a GitHub secret.
                    </small>
                  </div>
                  <div className="sync-field">
                    {lovableSecret ? <span className="sync-who"><span className="dot-ok" /> Already saved in this repository</span> : null}
                    <input
                      className="nf mono"
                      type="password"
                      autoComplete="off"
                      placeholder={lovableSecret ? "Paste a new key to replace it" : "Lovable API key"}
                      value={lovableKey}
                      onChange={(e) => setLovableKey(e.target.value)}
                      disabled={!repo}
                      aria-label="Lovable API key"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <b>Published Lovable site</b>
                    <small>luvhub reads the live site, the same render you converted here: HubSpot updates after you press Publish in Lovable (checked every hour and at every edit).</small>
                  </div>
                  <div className="sync-field">
                    <input className="nf" type="url" placeholder="https://your-project.lovable.app" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Published site address" />
                  </div>
                </>
              )}
            </div>

            <div className={`inner sync-row ${repo ? "" : "dim"}`}>
              <span className="sn">4</span>
              <div>
                <b>HubSpot token</b>
                <small>
                  A private app token with the <code>content</code> and <code>files</code> scopes.{" "}
                  <a href="/tutorial#sync" target="_blank" rel="noreferrer">How to create the &quot;luvhub&quot; token</a>. It is stored encrypted as a GitHub secret; luvhub doesn&apos;t keep it.
                </small>
              </div>
              <div className="sync-field">
                {secret ? <span className="sync-who"><span className="dot-ok" /> Already saved in this repository</span> : null}
                <input
                  className="nf mono"
                  type="password"
                  autoComplete="off"
                  placeholder={secret ? "Paste a new token to replace it" : "pat-eu1-…"}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={!repo}
                  aria-label="HubSpot private app token"
                />
              </div>
            </div>

            <div className="inner sync-warn">
              <b>Lovable becomes the source.</b> The pages switch to fixed sections: each sync rewrites them, so changes made to their content in HubSpot are replaced.
              SEO title and URL can still be set in HubSpot, and pages stay drafts until you publish them there.
            </div>

            {err && <div className="inner sync-err" role="alert">{err}</div>}

            <div className="sync-actions" style={{ padding: "2px 4px 4px" }}>
              <button className="btn-white" onClick={submit} disabled={!ready || busy}>{busy ? <Spinner /> : <I.refresh />} {job.automation ? "Update sync" : "Turn on sync"}</button>
              <button className="pill-btn tall" onClick={onClose} disabled={busy}>Cancel</button>
              {gh && !gh.viaToken && (
                <button className="pill-btn tall" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => api("/api/auth/github/logout", { method: "POST" }).then(onGithubChange)}>
                  Disconnect GitHub
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
