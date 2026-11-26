/**
 * The workflow luvhub writes into the Lovable project's repository. It runs
 * on every push to the default branch (Lovable pushes each edit there) and
 * by hand, and skips the commits the Action makes to luvhub.json.
 */

export const WORKFLOW_PATH = ".github/workflows/luvhub.yml";
export const SECRET_NAME = "LUVHUB_HUBSPOT_TOKEN";
/** Lovable API key, for the "lovable" source (Lovable's preview of the latest edit). */
export const LOVABLE_SECRET_NAME = "LUVHUB_LOVABLE_API_KEY";

/**
 * `hourly` also checks every hour: for the published site, which changes when
 * you press Publish in Lovable without a push to the repository.
 */
export function workflowYaml(opts: { branch: string; actionRef: string; configPath?: string; hourly?: boolean }): string {
  const config = opts.configPath ?? "luvhub.json";
  const schedule = opts.hourly ? `\n  schedule:\n    - cron: "17 * * * *"` : "";
  return `# Keeps the HubSpot pages in sync with this Lovable project.
# Written by luvhub (https://github.com/GS-Loft-Dev/luvhub). The HubSpot token
# is the ${SECRET_NAME} repository secret, the Lovable API key ${LOVABLE_SECRET_NAME}. Run it by hand from the Actions tab,
# with "force" to republish even when nothing changed.
name: luvhub

on:
  push:
    branches: [${JSON.stringify(opts.branch)}]
    paths-ignore: [${JSON.stringify(config)}]
  workflow_dispatch:
    inputs:
      force:
        description: Republish even when nothing changed
        type: boolean
        default: false${schedule}

permissions:
  contents: write

concurrency:
  group: luvhub
  cancel-in-progress: false

jobs:
  sync:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: ${opts.actionRef}
        with:
          hubspot-token: \${{ secrets.${SECRET_NAME} }}
          lovable-api-key: \${{ secrets.${LOVABLE_SECRET_NAME} }}
          config: ${JSON.stringify(config)}
          force: \${{ inputs.force || false }}
`;
}
