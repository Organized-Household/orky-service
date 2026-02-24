// pages/api/github/pr.js
import { SignJWT, importPKCS8 } from "jose";

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function normalizePem(pem) {
  // Vercel env vars sometimes store newlines as "\n"
  if (pem.includes("\\n")) return pem.replace(/\\n/g, "\n");
  return pem;
}

async function createAppJwt() {
  const appId = mustGetEnv("GH_APP_ID");
  const pem = normalizePem(mustGetEnv("GH_APP_PRIVATE_KEY"));

  // GitHub App keys are RSA (PKCS8). Some downloads are PKCS1 ("BEGIN RSA PRIVATE KEY").
  // If your file begins with "BEGIN RSA PRIVATE KEY", convert it to PKCS8, or re-download if GitHub provided PKCS8.
  // Many GitHub App keys today are PKCS8 ("BEGIN PRIVATE KEY").
  const pkcs8 = pem;

  const key = await importPKCS8(pkcs8, "RS256");

  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 10)
    .setExpirationTime(now + 9 * 60) // max 10 minutes; keep under
    .setIssuer(appId)
    .sign(key);

  return jwt;
}

async function getInstallationToken() {
  const installationId = mustGetEnv("GH_APP_INSTALLATION_ID");
  const jwt = await createAppJwt();

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get installation token: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.token;
}

async function ghFetch(token, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${url}\n${text}`);
  }
  return res.json();
}

async function getBranchSha({ token, owner, repo, branch }) {
  const ref = await ghFetch(
    token,
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`
  );
  return ref.object.sha;
}

async function createBranch({ token, owner, repo, newBranch, fromSha }) {
  return ghFetch(token, `https://api.github.com/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({
      ref: `refs/heads/${newBranch}`,
      sha: fromSha,
    }),
  });
}

// Commit multiple files by creating blobs + tree + commit + moving the ref.
// This avoids one-commit-per-file.
async function commitFiles({
  token,
  owner,
  repo,
  branch,
  commitMessage,
  files, // [{ path, content, encoding? ("utf-8" default), mode? }]
}) {
  // 1) Get latest commit on branch (ref -> commit -> tree)
  const ref = await ghFetch(
    token,
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`
  );
  const commitSha = ref.object.sha;

  const commit = await ghFetch(
    token,
    `https://api.github.com/repos/${owner}/${repo}/git/commits/${commitSha}`
  );
  const baseTreeSha = commit.tree.sha;

  // 2) Create blobs for each file
  const treeItems = [];
  for (const f of files) {
    if (!f.path || typeof f.content !== "string") {
      throw new Error("Each file must include { path, content }");
    }
    const blob = await ghFetch(
      token,
      `https://api.github.com/repos/${owner}/${repo}/git/blobs`,
      {
        method: "POST",
        body: JSON.stringify({
          content: f.content,
          encoding: f.encoding || "utf-8",
        }),
      }
    );

    treeItems.push({
      path: f.path,
      mode: f.mode || "100644",
      type: "blob",
      sha: blob.sha,
    });
  }

  // 3) Create a new tree
  const newTree = await ghFetch(
    token,
    `https://api.github.com/repos/${owner}/${repo}/git/trees`,
    {
      method: "POST",
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: treeItems,
      }),
    }
  );

  // 4) Create commit
  const newCommit = await ghFetch(
    token,
    `https://api.github.com/repos/${owner}/${repo}/git/commits`,
    {
      method: "POST",
      body: JSON.stringify({
        message: commitMessage,
        tree: newTree.sha,
        parents: [commitSha],
      }),
    }
  );

  // 5) Update the branch ref to point to new commit
  await ghFetch(
    token,
    `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        sha: newCommit.sha,
        force: false,
      }),
    }
  );

  return newCommit.sha;
}

async function openPullRequest({ token, owner, repo, head, base, title, body }) {
  return ghFetch(token, `https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title,
      head, // branch name (or "owner:branch")
      base, // target branch
      body: body || "",
      draft: false,
    }),
  });
}

export default async function handler(req, res) {
  try {
    // Basic auth for your endpoint
    const expected = mustGetEnv("ORKY_API_KEY");
    const headerKey = req.headers["x-orky-key"];
    const bearer = (req.headers.authorization || "").replace("Bearer ", "");
    const provided = headerKey || bearer;

    if (!provided || provided !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    const owner = mustGetEnv("GH_OWNER");
    const defaultBranch = mustGetEnv("GH_DEFAULT_BRANCH");

    const {
      repo, // e.g. "ohh-web" (required)
      branchName, // optional; will auto-generate if omitted
      prTitle,
      prBody,
      commitMessage,
      files, // [{ path, content }]
    } = req.body || {};

    if (!repo) return res.status(400).json({ error: "Missing body.repo" });
    if (!Array.isArray(files) || files.length === 0)
      return res.status(400).json({ error: "Missing body.files[]" });

    const token = await getInstallationToken();

    // 1) base SHA
    const baseSha = await getBranchSha({
      token,
      owner,
      repo,
      branch: defaultBranch,
    });

    // 2) create new branch
    const safeBranch =
      branchName ||
      `orky/${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    await createBranch({ token, owner, repo, newBranch: safeBranch, fromSha: baseSha });

    // 3) commit files
    const finalCommitMessage = commitMessage || `Orky update (${safeBranch})`;
    await commitFiles({
      token,
      owner,
      repo,
      branch: safeBranch,
      commitMessage: finalCommitMessage,
      files,
    });

    // 4) open PR
    const pr = await openPullRequest({
      token,
      owner,
      repo,
      head: safeBranch,
      base: defaultBranch,
      title: prTitle || `Orky PR: ${finalCommitMessage}`,
      body: prBody || "",
    });

    return res.status(200).json({
      ok: true,
      owner,
      repo,
      base: defaultBranch,
      head: safeBranch,
      prUrl: pr.html_url,
      prNumber: pr.number,
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
