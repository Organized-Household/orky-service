import type { VercelRequest, VercelResponse } from "@vercel/node";
import { supabase } from "../src/db/client";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // Simple "can I talk to Supabase?" check using SQL via PostgREST:
    const { data, error } = await supabase.from("pg_stat_activity").select("pid").limit(1);

    // Note: pg_stat_activity may be blocked by permissions depending on setup.
    // If it errors, we still return useful diagnostics.
    if (error) {
      return res.status(500).json({
        ok: false,
        env: process.env.VERCEL_ENV || "unknown",
        message: "Supabase query failed",
        error: error.message,
      });
    }

    return res.status(200).json({
      ok: true,
      env: process.env.VERCEL_ENV || "unknown",
      message: "Supabase reachable",
      sample: data ?? null,
    });
  } catch (e: any) {
    return res.status(500).json({
      ok: false,
      env: process.env.VERCEL_ENV || "unknown",
      message: "Server exception",
      error: e?.message || String(e),
    });
  }
}
