// api/brain/forge_to_pr.js
export default async function handler(req, res) {
  try {
    // Auth (same as your other endpoints)
    const expected = process.env.ORKY_API_KEY;
    if (!expected) throw new Error("Missing env var: ORKY_API_KEY");

    const headerKey = req.headers["x-orky-key"];
    const bearer = (req.headers.authorization || "").replace("Bearer ", "");
    const provided = headerKey || bearer;

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

    // Call Forge Brain endpoint (internal)
    const baseUrl =
      process.env.PUBLIC_BASE_URL ||
      `https://${req.headers.host}`; // works on Vercel

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

    // Validate minimal proposal shape before executing
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

    // Execute PR by calling existing GitHub mutator
    const prResp = await fetch(`${baseUrl}/api/github/pr`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-orky-key": expected,
      },
      body: JSON.stringify({
        repo: payload.repo,
        branchName: payload.branchName || undefined,
        prTitle: payload.prTitle,
        prBody: payload.prBody,
        commitMessage: payload.commitMessage,
        files: payload.files,
      }),
    });

    const prText = await prResp.text();
    let prJson;
    try {
      prJson = JSON.parse(prText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "GitHub PR endpoint returned non-JSON",
        prStatus: prResp.status,
        prText,
      });
    }

    if (!prResp.ok || !prJson?.ok) {
      return res.status(500).json({
        ok: false,
        error: "GitHub PR creation failed",
        prStatus: prResp.status,
        prJson,
      });
    }

    // Success: return proposal + PR info
    return res.status(200).json({
      ok: true,
      proposal,
      pr: {
        prUrl: prJson.prUrl,
        prNumber: prJson.prNumber,
        owner: prJson.owner,
        repo: prJson.repo,
        base: prJson.base,
        head: prJson.head,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
