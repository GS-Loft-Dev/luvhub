"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { I, Mark, Spinner } from "./ui";

/* ------------------------------------------------------------------ types */

interface Setup {
  setup: { lovableOAuth: boolean; lovableApiKey: boolean; hubspotOAuth: boolean; hubspotToken: boolean; embedAvailable: boolean };
  lovable: { connected: boolean; viaKey: boolean };
  hubspot: { portalId: number; hubDomain?: string; viaToken: boolean } | null;
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
  theme: { name: string; label: string };
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

type DockTab = "status" | "log" | "pages" | "warnings" | "settings";

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
const H = 470;
const STEPS = ["Connect", "Convert", "Review", "Publish"];
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
  const step = !job ? (connectedAll ? 2 : 1) : !result ? 3 : 4;

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
  ) : job ? (
    <>{stats.included} modules and {stats.fields} editable fields ready. Each page becomes a draft HubSpot page titled <b>“{page?.label}”</b>. {hubspot ? "Press Publish." : "Connect HubSpot to publish."}</>
  ) : mode === "lovable" && !lovableOn && !hubspot ? (
    "Connect Lovable and HubSpot: one click each, on the L and H avatars top left, or in node 1."
  ) : mode === "url" && !url.trim() ? (
    <>Paste the address of a published Lovable site in node 1.{hubspot ? "" : " Connect HubSpot (H, top left) to publish."}</>
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
          : job && !result
            ? { cls: "p", text: "Title from Lovable", x: 420, y: 124 }
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
            const done = n === 1 ? connectedAll || Boolean(job) : n < step || (n === 4 && Boolean(result?.ok));
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
        <div className="people" aria-label="Connections">
          <span className="badge" aria-hidden><I.sparkle /></span>
          <ConnAvatar kind="lovable" on={lovableOn} href={setup?.setup.lovableOAuth && !lovableOn ? "/api/auth/lovable/login" : undefined} />
          <ConnAvatar kind="hubspot" on={Boolean(hubspot)} href={setup?.setup.hubspotOAuth && !hubspot ? "/api/auth/hubspot/login" : undefined} detail={hubspot ? `Portal ${hubspot.portalId}` : undefined} />
          <span className="more">{Number(lovableOn) + Number(Boolean(hubspot))}/2</span>
        </div>
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
                  </>
                ) : (
                  <>
                    <p className="copy">Each Lovable page becomes a HubSpot draft page, with the same title already set.</p>
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
          ] as const).map(([id, icon, label]) => (
            <button key={id} role="tab" aria-selected={dock === id} aria-label={label} title={label} className={`tool ${dock === id ? "on wide" : ""}`} onClick={() => setDock(id)}>{icon}{dock === id && <span>{label}</span>}</button>
          ))}
          <a className="tool" href="/tutorial" aria-label="Tutorial" title="Tutorial"><I.book /></a>
          <span className="sep" />
          <button role="tab" aria-selected={dock === "warnings"} aria-label="Warnings" title="Warnings" className={`tool ${dock === "warnings" ? "on wide" : ""}`} onClick={() => setDock("warnings")}><I.sun />{dock === "warnings" && <span>Warnings</span>}</button>
          <button role="tab" aria-selected={dock === "settings"} aria-label="Settings" title="Settings" className={`tool ${dock === "settings" ? "on wide" : ""}`} onClick={() => setDock("settings")}><I.gear />{dock === "settings" && <span>Settings</span>}</button>
        </div>
      </div>

      {job && current && <ModuleModal jobId={job.id} module={current} onClose={() => setOpenModule(null)} patch={patch} />}
    </div>
  );
}

function ConnAvatar({ kind, on, href, detail }: { kind: "lovable" | "hubspot"; on: boolean; href?: string; detail?: string }) {
  const name = kind === "lovable" ? "Lovable" : "HubSpot";
  const title = `${name}: ${on ? detail ?? "connected" : href ? "click to connect" : "not connected"}`;
  const inner = <>{kind === "lovable" ? "L" : "H"}<span className={`st ${on ? "on" : ""}`} /></>;
  return href ? (
    <a className={`avatar ${kind} ${on ? "" : "off"}`} href={href} title={title} aria-label={`Connect ${name}`}>{inner}</a>
  ) : (
    <span className={`avatar ${kind} ${on ? "" : "off"}`} title={title} aria-label={title}>{inner}</span>
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
