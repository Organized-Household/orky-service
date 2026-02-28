// api/brain/forge_to_pr.js
//
// Two entrypoints:
// A) Named function export for internal orchestration (jira_scanner):
//    brainToHandsCreatePr({ repo, branchName, prTitle, prBody, commitMessage, files, labels?, meta? })
// B) Default API handler for your existing endpoint (/api/brain/forge_to_pr):
//    Accepts { instruction, contextSources, repo } and runs Forge -> GitHub PR mutator.
//
// Notes:
// - Auth: uses ORKY_API_KEY via x-orky-key or Authorization Bearer.
// - Uses /api/github/pr as the single GitHub mutation boundary.

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getProvidedKey(req) {
  const headerKey = req.headers["x-orky-key"];
  const bearer = (req.headers.authorization || "").replace("Bearer ", "");
  return headerKey || bearer;
}

function getBaseUrlFromReq(req) {
  return process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
}

/**
 * Internal: create PR by calling /api/github/pr
 * This is what jira_scanner.js should call.
 */
export async function brainToHandsCreatePr({
  baseUrl,
  apiKey,
  repo,
  branchName,
  prTitle,
  prBody,
  commitMessage,
  files,
  labels, // optional - only if your /api/github/pr supports it
}) {
  if (!baseUrl) throw new Error("brainToHandsCreatePr missing baseUrl");
  if (!apiKey) throw new Error("brainToHandsCreatePr missing apiKey");
  if (!repo) throw new Error("brainToHandsCreatePr missing repo");
  if (!prTitle) throw new Error("brainToHandsCreatePr missing prTitle");
  if (!Array.isArray(files) || files.length === 0) throw new Error("brainToHandsCreatePr missing files[]");

  const prResp = await fetch(`${baseUrl}/api/github/pr`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-orky-key": apiKey,
    },
    body: JSON.stringify({
      repo,
      branchName: branchName || undefined,
      prTitle,
      prBody,
      commitMessage,
      files,
      // Only include if your endpoint supports it; otherwise harmless to omit.
      labels: Array.isArray(labels) ? labels : undefined,
    }),
  });

  const prText = await prResp.text();
  let prJson;
  try {
    prJson = JSON.parse(prText);
  } catch {
    throw new Error(`GitHub PR endpoint returned non-JSON (status ${prResp.status}): ${prText}`);
  }

  if (!prResp.ok || !prJson?.ok) {
    throw new Error(`GitHub PR creation failed (status ${prResp.status}): ${JSON.stringify(prJson)}`);
  }

  return {
    ok: true,
    prUrl: prJson.prUrl,
    prNumber: prJson.prNumber,
    owner: prJson.owner,
    repo: prJson.repo,
    base: prJson.base,
    head: prJson.head,
  };
}

/**
 * Default API endpoint: Forge -> PR.
 * Body: { instruction: string, contextSources?: any[], repo?: string }
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

    const baseUrl = getBaseUrlFromReq(req);

    // Call Forge endpoint (internal)
    const forgeResp = await fetch(`${baseUrl}/api/brain/forge`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-orky-key": expected,
      },
      body: JSON.stringify({
        instruction,
        contextSources: Array.isArray(contextSources) ? contextSources : [],
        repo: repo || "orky-service",
      }),
    });

    const forgeText = await forgeResp.text();
    let forgeJson;
    try {
      forgeJson = JSON.parse(forgeText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "Forge endpoint returned non-JSON",
        forgeStatus: forgeResp.status,
        forgeText,
      });
    }

    if (!forgeResp.ok || !forgeJson?.ok || !forgeJson?.proposal) {
      return res.status(500).json({
        ok: false,
        error: "Forge endpoint failed",
        forgeStatus: forgeResp.status,
        forgeJson,
      });
    }

    const proposal = forgeJson.proposal;

    if (proposal.kind !== "github_pr") {
      return res.status(400).json({
        ok: false,
        error: `Unsupported proposal.kind: ${proposal.kind}`,
        proposal,
      });
    }

    const payload = proposal.payload;
    if (!payload?.repo || !Array.isArray(payload?.files) || payload.files.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Forge proposal.payload missing repo or files[]",
        proposal,
      });
    }

    // Execute PR using the internal function
    const pr = await brainToHandsCreatePr({
      baseUrl,
      apiKey: expected,
      repo: payload.repo,
      branchName: payload.branchName || undefined,
      prTitle: payload.prTitle,
      prBody: payload.prBody,
      commitMessage: payload.commitMessage,
      files: payload.files,
      labels: payload.labels, // optional, if forge includes it
    });

    return res.status(200).json({
      ok: true,
      proposal,
      pr: {
        prUrl: pr.prUrl,
        prNumber: pr.prNumber,
        owner: pr.owner,
        repo: pr.repo,
        base: pr.base,
        head: pr.head,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
