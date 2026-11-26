/**
 * Running a conversion: render the Lovable pages, convert them, store the job.
 *
 * On Netlify a normal function has about 30 seconds, and a heavy Lovable page
 * (videos, large images, sections that load on scroll) takes longer. There
 * the work runs in a background function (up to 15 minutes): the dashboard
 * gets the job id at once and asks for its status until it is ready.
 * Everywhere else it runs inline, as before.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { convertPages } from "./converter";
import { createJob, loadJob, type Job } from "./jobs";
import { renderRoutes } from "./render";
import { getStore, storageKind } from "./storage";

export interface ConversionInput {
  owner: string;
  source: Job["source"];
  /** The page to render: the published URL, or the Lovable embed URL with its token. */
  url: string;
  embedParentOrigin?: string;
  routes: string[];
  themeName: string;
}

export type ConversionStatus = { state: "running" } | { state: "ready" } | { state: "failed"; error: string };

interface StatusRecord {
  owner: string;
  state: "running" | "failed";
  error?: string;
  at: string;
}

/** Longer than a background function may run: a "running" record older than this died. */
const STALE_MS = 16 * 60 * 1000;
export const BACKGROUND_FUNCTION = "convert-background";

const statusKey = (id: string) => `jobs/${id}/status.json`;

export function newJobId(): string {
  return randomBytes(9).toString("base64url");
}

/** Background functions exist only on Netlify (LUVHUB_INLINE_CONVERT=1 turns them off). */
export function runsInBackground(): boolean {
  return storageKind() === "netlify" && !/^(1|true|yes)$/i.test(process.env.LUVHUB_INLINE_CONVERT ?? "");
}

/** Renders, converts and stores the job under `id`. */
export async function runConversion(id: string, input: ConversionInput): Promise<void> {
  const pages = await renderRoutes({ url: input.url, routes: input.routes, embedParentOrigin: input.embedParentOrigin });
  const model = convertPages(pages, { themeName: input.themeName });
  await createJob(input.owner, input.source, model, pages, id);
}

function sign(id: string, owner: string): string {
  return createHmac("sha256", config.sessionSecret()).update(`convert:${id}:${owner}`).digest("base64url");
}

function validSignature(id: string, owner: string, sig: string): boolean {
  const want = Buffer.from(sign(id, owner));
  const got = Buffer.from(sig ?? "");
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * Starts a conversion. Returns its id; `pending` means it is still running in
 * the background and conversionStatus() tells when it is done.
 */
export async function startConversion(input: ConversionInput): Promise<{ id: string; pending: boolean }> {
  const id = newJobId();
  if (!runsInBackground()) {
    await runConversion(id, input);
    return { id, pending: false };
  }
  const record: StatusRecord = { owner: input.owner, state: "running", at: new Date().toISOString() };
  await getStore().setJSON(statusKey(id), record);
  const res = await fetch(`${new URL(config.appUrl()).origin}/.netlify/functions/${BACKGROUND_FUNCTION}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, input, sig: sign(id, input.owner) }),
  });
  if (res.status !== 202 && !res.ok) {
    await getStore().setJSON(statusKey(id), { ...record, state: "failed", error: `The conversion couldn't start (HTTP ${res.status}).` });
    throw new Error(`The conversion couldn't start (HTTP ${res.status}).`);
  }
  return { id, pending: true };
}

/** The background function's body: checks the signature, runs, records a failure. */
export async function runBackgroundConversion(body: { id?: string; input?: ConversionInput; sig?: string }): Promise<void> {
  const { id, input, sig } = body;
  if (!id || !/^[\w-]{2,64}$/.test(id) || !input?.owner || !validSignature(id, input.owner, sig ?? "")) {
    throw new Error("Refused: unsigned conversion request.");
  }
  try {
    await runConversion(id, input);
  } catch (e) {
    const record: StatusRecord = { owner: input.owner, state: "failed", error: (e as Error).message, at: new Date().toISOString() };
    await getStore().setJSON(statusKey(id), record);
  }
}

export async function conversionStatus(id: string, owner: string): Promise<ConversionStatus | null> {
  if (!/^[\w-]{2,64}$/.test(id)) return null;
  if (await loadJob(id, owner)) return { state: "ready" };
  const record = await getStore().getJSON<StatusRecord>(statusKey(id)).catch(() => null);
  if (!record || record.owner !== owner) return null;
  if (record.state === "failed") return { state: "failed", error: record.error ?? "The conversion failed." };
  if (Date.now() - Date.parse(record.at) > STALE_MS) return { state: "failed", error: "The conversion took too long and was stopped." };
  return { state: "running" };
}
