/**
 * luvhub sync: keeps HubSpot pages in step with a Lovable project.
 * Run by the luvhub GitHub Action from the project's checkout:
 *
 *   HUBSPOT_ACCESS_TOKEN=... npx tsx scripts/luvhub-sync.ts --config luvhub.json [--force]
 *
 * Updates luvhub.json with the HubSpot page ids and the last sync, writes a
 * job summary and the `status` output, and exits non-zero when publishing failed.
 */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CONFIG_FILE, parseConfig, serializeConfig } from "../src/lib/sync/config";
import { runSync } from "../src/lib/sync/run";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const configPath = resolve(arg("config") ?? process.env.LUVHUB_CONFIG ?? CONFIG_FILE);
  const force = process.argv.includes("--force") || /^(1|true|yes)$/i.test(process.env.LUVHUB_FORCE ?? "");
  const token = (process.env.HUBSPOT_ACCESS_TOKEN ?? "").trim();
  if (!token) throw new Error("HUBSPOT_ACCESS_TOKEN is empty: add the HubSpot private app token as a repository secret.");

  const before = await readFile(configPath, "utf8");
  const config = parseConfig(before);
  const result = await runSync({ cwd: dirname(configPath), config, token, force });

  const after = serializeConfig(result.config);
  if (after !== before) await writeFile(configPath, after);

  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `status=${result.status}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = (result.publish?.pages ?? []).map(
      (p) => `| \`${p.route}\` | ${p.title.replace(/\|/g, "\\|")} | ${p.editUrl ? `[${p.status}](${p.editUrl})` : `${p.status}${p.error ? `: ${p.error}` : ""}`} |`,
    );
    const failed = result.publish?.steps.filter((s) => s.status === "failed") ?? [];
    const lines = [
      `## luvhub · ${result.model.label}`,
      "",
      result.status === "unchanged"
        ? "No changes since the last sync: HubSpot is already up to date."
        : result.status === "published"
          ? `Published to HubSpot portal ${result.publish!.portalId}. Pages are drafts: publish them from HubSpot when ready.`
          : `Published with errors: ${failed.length} file(s) failed.`,
      "",
      ...(rows.length ? ["| Route | Title | HubSpot page |", "| --- | --- | --- |", ...rows, ""] : []),
      ...failed.map((s) => `- \`${s.path}\`: ${s.error}`),
    ];
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }

  console.log(`luvhub: ${result.status}`);
  if (result.status === "failed") process.exitCode = 1;
}

main().catch((e) => {
  console.error(`luvhub: ${(e as Error).message}`);
  process.exitCode = 1;
});
