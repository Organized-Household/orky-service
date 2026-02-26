import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";

/**
 * POST /api/brain/forge
 *
 * Auth: x-orky-key: <ORKY_API_KEY>
 *
 * Body:
 * {
 *   "instruction": "What you want Forge to build",
 *   "contextSources": [{...}], // optional
 *   "repo": "orky-service"     // optional (used in output payload)
 * }
 *
 * Returns:
 * Forge's strict JSON proposal (kind=github_pr)
 */

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function loadForgePromptPack() {
  // Put the prompt pack at repo root: /agents/forge.md
  const filePath = path.join(process.cwd(), "agents", "forge.md");
  return fs.readFile(filePath, "utf8");
}

const FORGE_OUTPUT_SCHEMA = {
  name: "forge_github_pr_proposal",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "summary", "payload", "quality"],
    properties: {
      kind: { type: "string", enum: ["github_pr"] },
      summary: { type: "string" },
      payload: {
        type: "object",
        additionalProperties: false,
        required: ["repo", "prTitle", "prBody", "commitMessage", "files"],
        properties: {
          repo: { type: "string" },
          prTitle: { type: "string" },
          prBody: { type: "string" },
          commitMessage: { type: "string" },
          branchName: { type: "string" },
          files: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "content"],
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
            },
          },
        },
      },
      quality: {
        type: "object",
        additionalProperties: false,
        required: ["assumptions", "risks", "testPlan", "rollbackPlan"],
        properties: {
          assumptions: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
          testPlan: { type: "array", items: { type: "string" } },
          rollbackPlan: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export default async function handler(req, res) {
  try {
    // --- Auth (same pattern as your other endpoints)
    const expected = mustGetEnv("ORKY_API_KEY");
    const provided = req.headers["x-orky-key"] || "";
    if (provided !== expected) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Use POST" });
    }

    const { instruction, contextSources, repo } = req.body || {};
    if (!instruction || typeof instruction !== "string") {
      return res.status(400).json({ ok: false, error: "Missing body.instruction (string)" });
    }

    // Load Forge prompt pack
    const forgePack = await loadForgePromptPack();

    // Build the user content Forge should act on
    const userPayload = {
      instruction,
      repo: repo || "orky-service",
      contextSources: Array.isArray(contextSources) ? contextSources : [],
    };

    const client = new OpenAI({ apiKey: mustGetEnv("OPENAI_API_KEY") });

    // Choose a model via env var so you can swap without code changes
    const model = process.env.OPENAI_MODEL || "gpt-5.2-mini";

    // Responses API with Structured Outputs (JSON Schema)
    const response = await client.responses.create({
      model,
      // Use the Forge prompt pack as system instructions
      instructions: forgePack,
      // Provide the concrete task + context as the user input
      input: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Generate a GitHub PR proposal as strict JSON per the schema. " +
                "Use the provided instruction and context. Return JSON only.\n\n" +
                JSON.stringify(userPayload, null, 2),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          ...FORGE_OUTPUT_SCHEMA,
        },
      },
    });

    // openai-node usually returns output_text; when using json_schema, it should be valid JSON.
    const raw = response.output_text?.trim();
    if (!raw) {
      return res.status(500).json({
        ok: false,
        error: "OpenAI response missing output_text",
        debug: { response_id: response.id },
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "OpenAI returned non-JSON output (unexpected)",
        raw,
        debug: { response_id: response.id },
      });
    }

    // Return the proposal (this endpoint does NOT store/email/execute yet)
    return res.status(200).json({ ok: true, proposal: parsed });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
