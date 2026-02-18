import { supabase } from "../db/client";

export default async function handler(req: any, res: any) {
  try {
    const { data, error } = await supabase.rpc("version");

    if (error) throw error;

    res.status(200).json({
      ok: true,
      service: "orky-service",
      db: "connected",
      env: process.env.VERCEL_ENV,
      time: new Date().toISOString()
    });

  } catch (err: any) {
    res.status(500).json({
      ok: false,
      service: "orky-service",
      db: "failed",
      error: err.message,
      env: process.env.VERCEL_ENV,
    });
  }
}
