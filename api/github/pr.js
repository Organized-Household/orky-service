// api/github/pr.js
import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function normalizePem(pem) {
  // If stored as single line with literal \n in Vercel env
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

async function getOctokitAsInstallation() {
  const appId = mustGetEnv("GH_APP_ID");
  const installationId = mustGetEnv("GH_APP_INSTALLATION_ID");
  const privateKey = normalizePem(mustGetEnv("GH_APP_PRIVATE_KEY"));

  const auth = createAppAuth({
    appId,
    privateKey, // works with "-----BEGIN RSA PRIVATE KEY-----"
    installationId,
  });

  const { token } = await auth({ type: "installation" });
  return new Octokit({ auth: token });
}

export default async function handler(req, res) {
  try {
    // Auth your endpoint (same idea as your Jira endpoint)
    const expected = mustGetEnv("ORKY_API_KEY");
    const headerKey = req.headers["x-orky-key"];
    const bearer = (req.headers.authorization || "").replace("Bearer ", "");
    const provided = headerKey || bearer;

    if (!provided || provided !== expected) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Use POST" });
    }

    const owner = mustGetEnv("GH_OWNER");
    const base = mustGetEnv("GH_DEFAULT_BRANCH");

    const {
      repo,               // required: "ohh-web"
      branchName,         // optional
      prTitle,            // optional
      prBody,             // optional
      commitMessage,      // optional
      files,              // required: [{ path, content }]
    } = req.body || {};

    if (!repo) return res.status(400).json({ ok: false, error: "Missing body.repo" });
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ ok: false, error: "Missing body.files[]" });
    }

    const octokit = await getOctokitAsInstallation();

    const head =
      branchName || `orky/${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    // 1) Base SHA (default branch)
    const baseRef = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner,
      repo,
      ref: `heads/${base}`,
    });
    const baseSha = baseRef.data.object.sha;

    // 2) Create branch
    await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner,
      repo,
      ref: `refs/heads/${head}`,
      sha: baseSha,
    });

    // 3) Build a single commit with multiple files
    const commit0 = await octokit.request(
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      { owner, repo, commit_sha: baseSha }
    );
    const baseTreeSha = commit0.data.tree.sha;

    const tree = [];
    for (const f of files) {
      if (!f?.path || typeof f?.content !== "string") {
        return res.status(400).json({
          ok: false,
          error: "Each file must include { path, content }",
        });
      }
      const blob = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
        owner,
        repo,
        content: f.content,
        encoding: "utf-8",
      });
      tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.data.sha });
    }

    const newTree = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
      owner,
      repo,
      base_tree: baseTreeSha,
      tree,
    });

    const msg = commitMessage || `Orky update (${head})`;
    const newCommit = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
      owner,
      repo,
      message: msg,
      tree: newTree.data.sha,
      parents: [baseSha],
    });

    await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      owner,
      repo,
      ref: `heads/${head}`,
      sha: newCommit.data.sha,
      force: false,
    });

    // 4) Open PR
    const pr = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner,
      repo,
      title: prTitle || `Orky PR: ${msg}`,
      head,
      base,
      body: prBody || "",
      draft: false,
    });

    return res.status(200).json({
      ok: true,
      owner,
      repo,
      base,
      head,
      prUrl: pr.data.html_url,
      prNumber: pr.data.number,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
