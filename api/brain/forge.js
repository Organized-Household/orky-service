import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";

/**
 * POST /api/brain/forge
 *
 * Returns:
 * { ok: true, proposal: <Forge strict JSON> }
 */

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getProvidedKey(req) {
  const headerKey = req.headers["x-orky-key"];
  if (headerKey && String(headerKey).trim()) return String(headerKey).trim();

  const auth = req.headers["authorization"];
  if (auth && typeof auth === "string") {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}

async function loadForgePromptPack() {
  // Prompt pack at repo root: /agents/forge.md
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
        required: ["repo", "prTitle", "prBody", "commitMessage", "branchName", "files"],
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

/**
 * Named export for internal orchestration (jira_scanner).
 * This is the function your scanner should call.
 */
export async function forgeProposal({ instruction, contextSources, repo }) {
  if (!instruction || typeof instruction !== "string") {
    throw new Error("forgeProposal: instruction (string) is required");
  }

  const forgePack = await loadForgePromptPack();

  const userPayload = {
    instruction,
    repo: repo || "orky-service",
    contextSources: Array.isArray(contextSources) ? contextSources : [],
  };

  const client = new OpenAI({ apiKey: mustGetEnv("OPENAI_API_KEY") });
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";

  const response = await client.responses.create({
    model,
    instructions: forgePack,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
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

  const raw = response.output_text?.trim();
  if (!raw) {
    throw new Error(`OpenAI response missing output_text (response_id=${response.id})`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`OpenAI returned non-JSON output (response_id=${response.id})`);
  }

  return parsed; // <-- returns proposal object directly
}

/**
 * Default API route handler remains intact.
 * Calls forgeProposal() and wraps with { ok: true, proposal }.
 */
export default async function handler(req, res) {
  try {
    const expected = mustGetEnv("ORKY_API_KEY");
    const provided = getProvidedKey(req);
    if (!provided || provided !== expected) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Use POST" });
    }

    const { instruction, contextSources, repo } = req.body || {};
    if (!instruction || typeof instruction !== "string") {
      return res.status(400).json({ ok: false, error: "Missing body.instruction (string)" });
    }

    const proposal = await forgeProposal({ instruction, contextSources, repo });
    return res.status(200).json({ ok: true, proposal });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
