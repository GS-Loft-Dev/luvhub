import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.STORAGE = "fs";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "luvhub-conv-"));
process.env.SESSION_SECRET = "x".repeat(40);

const { conversionStatus, newJobId, runBackgroundConversion } = await import("../src/lib/conversion");
const { getStore } = await import("../src/lib/storage");

afterAll(() => vi.restoreAllMocks());

describe("background conversion", () => {
  const input = { owner: "me", source: { kind: "url" as const, label: "x" }, url: "https://x.lovable.app/", routes: ["/"], themeName: "x" };

  it("refuses requests that weren't signed by this app", async () => {
    await expect(runBackgroundConversion({ id: "abc123", input, sig: "nope" })).rejects.toThrow("unsigned");
  });

  it("reports running, then failed with the reason, only to the owner", async () => {
    const id = newJobId();
    await getStore().setJSON(`jobs/${id}/status.json`, { owner: "me", state: "running", at: new Date().toISOString() });
    expect(await conversionStatus(id, "me")).toEqual({ state: "running" });
    expect(await conversionStatus(id, "someone-else")).toBeNull();
    await getStore().setJSON(`jobs/${id}/status.json`, { owner: "me", state: "failed", error: "boom", at: new Date().toISOString() });
    expect(await conversionStatus(id, "me")).toEqual({ state: "failed", error: "boom" });
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await getStore().setJSON(`jobs/${id}/status.json`, { owner: "me", state: "running", at: old });
    expect((await conversionStatus(id, "me"))?.state).toBe("failed");
  });
});
