import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.status(200).json({
    ok: true,
    service: "orky-service",
    env: process.env.VERCEL_ENV ?? "unknown",
    timestamp: new Date().toISOString(),
  });
}
