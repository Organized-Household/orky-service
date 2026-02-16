import { Express } from "express";
import { createRun, setRunCursor, getRun } from "../db/queries";

export function registerRoutes(app: Express) {
  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.post("/runs", async (req, res) => {
    try {
      const jira_key = String(req.body?.jira_key ?? "").trim();
      if (!jira_key) return res.status(400).json({ error: "jira_key required" });

      const run = await createRun(jira_key);
      res.status(201).json(run);
    } catch (e: any) {
      res.status(500).json({ error: e.message ?? String(e) });
    }
  });

  app.post("/runs/:id/start", async (req, res) => {
    try {
      const id = req.params.id;
      const run = await getRun(id);
      // “start” just keeps it in RECEIVED/INTAKE_START for Sprint 0
      const updated = await setRunCursor(run.id, "RECEIVED", "INTAKE_START", run.cursor_attempt);
      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ error: e.message ?? String(e) });
    }
  });

  app.post("/runs/:id/cancel", async (req, res) => {
    try {
      const id = req.params.id;
      const run = await getRun(id);
      const updated = await setRunCursor(run.id, "CANCELLED", "CANCELLED", run.cursor_attempt);
      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ error: e.message ?? String(e) });
    }
  });
}

