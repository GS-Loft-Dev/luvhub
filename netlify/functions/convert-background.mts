/**
 * Netlify background function (up to 15 minutes): renders and converts the
 * Lovable pages the dashboard asked for, then stores the job. The dashboard
 * started it through src/lib/conversion.ts and polls the job's status.
 */
import { runBackgroundConversion } from "../../src/lib/conversion";

// Jobs live in Netlify Blobs, like in the app itself.
process.env.STORAGE ??= "netlify";

export default async (req: Request): Promise<Response> => {
  try {
    await runBackgroundConversion(await req.json());
  } catch (e) {
    console.error(`[luvhub] conversion: ${(e as Error).message}`);
  }
  return new Response(null, { status: 202 });
};
