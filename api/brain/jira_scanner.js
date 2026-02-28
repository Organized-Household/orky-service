// api/brain/jira_scanner.js
//
// Triggered by Jira Automation "Issue transitioned" -> To: Ready for Engineering
// Jira sends POST with body: { "jiraKey": "ORKY-123" }
//
// Behavior:
// - Validate required fields
// - If validation fails: Ready -> In Review with comment
// - Else: Ready -> In Progress, forge proposal, create PR in ohh-web, then In Review

import crypto from "crypto";
import { forgeProposal } from "./forge.js";
import { brainToHandsCreatePr } from "./forge_to_pr.js";

// ------------------- Config -------------------

const STATUS_READY = "Ready for Engineering";
const STATUS_IN_PROGRESS = "In Progress";
const STATUS_IN_REVIEW = "In Review";

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY;

const JIRA_AC_FIELD_ID = process.env.JIRA_ACCEPTANCE_CRITERIA_FIELD_ID || "";
const DEFAULT_TARGET_REPO = process.env.DEFAULT_TARGET_REPO || "ohh-web";

const TRANSITION_ID_TO_IN_PROGRESS = process.env.JIRA_TRANSITION_ID_TO_IN_PROGRESS || "";
const TRANSITION_ID_TO_IN_REVIEW = process.env.JIRA_TRANSITION_ID_TO_IN_REVIEW || "";

const BLOCKING_LABELS = new Set([
  "blocked",
  "needs-info",
  "do-not-automate",
  "security-review-required",
]);

const REQUIRE_AUTOMATION_ALLOWED_LABEL = false;
const AUTOMATION_ALLOWED_LABEL = "automation:allowed";

// ------------------- Utilities -------------------

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function humanTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

function normalizeText(s) {
  return (s || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function buildFingerprint({ jiraKey, jiraUpdatedAt, jiraStatus, acceptanceCriteria, description }) {
  const payload = [
    `jiraKey=${jiraKey}`,
    `updatedAt=${jiraUpdatedAt || ""}`,
    `status=${jiraStatus || ""}`,
    `ac=${normalizeText(acceptanceCriteria)}`,
    `desc=${normalizeText(description)}`,
  ].join("\n");

  const full = sha256Hex(payload);
  return { full, short: `fp_${full.slice(0, 8)}` };
}

// ------------------- Jira helpers -------------------

function jiraAuthHeader() {
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error("Missing Jira env vars: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN");
  }
  const token = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  return `Basic ${token}`;
}

async function jiraFetch(path, { method = "GET", body = null } = {}) {
  const url = `${JIRA_BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: jiraAuthHeader(),
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : null,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jira ${method} ${path} failed ${res.status}: ${text}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

async function jiraGetIssue(jiraKey) {
  const fields = [
    "summary",
    "status",
    "labels",
    "updated",
    "description",
    ...(JIRA_AC_FIELD_ID ? [JIRA_AC_FIELD_ID] : []),
  ];
  const params = new URLSearchParams({ fields: fields.join(",") });
  return jiraFetch(`/rest/api/3/issue/${encodeURIComponent(jiraKey)}?${params.toString()}`);
}

async function jiraSearchReadyIssues() {
  if (!JIRA_PROJECT_KEY) throw new Error("Missing JIRA_PROJECT_KEY");
  const jql = `project = "${JIRA_PROJECT_KEY}" AND status = "${STATUS_READY}" ORDER BY updated DESC`;

  const fields = [
    "summary",
    "status",
    "labels",
    "updated",
    "description",
    ...(JIRA_AC_FIELD_ID ? [JIRA_AC_FIELD_ID] : []),
  ];

  const params = new URLSearchParams({
    jql,
    maxResults: "50",
    fields: fields.join(","),
  });

  const resp = await jiraFetch(`/rest/api/3/search?${params.toString()}`);
  return resp.issues || [];
}

function extractDescriptionText(fields) {
  const desc = fields?.description;
  if (!desc) return "";
  if (typeof desc === "string") return desc;

  // Atlassian Document Format (ADF) naive extraction
  if (typeof desc === "object") {
    try {
      const chunks = [];
      const walk = (node) => {
        if (!node) return;
        if (node.type === "text" && typeof node.text === "string") chunks.push(node.text);
        if (Array.isArray(node.content)) node.content.forEach(walk);
      };
      walk(desc);
      return chunks.join(" ");
    } catch {
      return "";
    }
  }
  return "";
}

function extractAcceptanceCriteria(fields) {
  if (JIRA_AC_FIELD_ID && fields?.[JIRA_AC_FIELD_ID]) {
    const v = fields[JIRA_AC_FIELD_ID];
    if (typeof v === "string") return normalizeText(v);
    return normalizeText(JSON.stringify(v));
  }

  const desc = normalizeText(extractDescriptionText(fields));
  const m = desc.match(/Acceptance Criteria\s*:?\s*\n([\s\S]*?)(\n[A-Z][^\n]{0,60}\n|$)/i);
  if (m && m[1]) return normalizeText(m[1]);
  return "";
}

async function jiraAddComment(jiraKey, bodyText) {
  await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(jiraKey)}/comment`, {
    method: "POST",
    body: { body: bodyText },
  });
}

async function jiraTransition(jiraKey, transitionId) {
  if (!transitionId) {
    throw new Error(
      `Missing transition id for Jira transition. Set env vars: ` +
        `JIRA_TRANSITION_ID_TO_IN_PROGRESS and JIRA_TRANSITION_ID_TO_IN_REVIEW.`
    );
  }

  await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(jiraKey)}/transitions`, {
    method: "POST",
    body: { transition: { id: transitionId } },
  });
}

// ------------------- Hard rules -------------------

function validateHardRules(issue) {
  const fields = issue.fields || {};
  const jiraKey = issue.key;

  const statusName = fields.status?.name || "";
  const summary = normalizeText(fields.summary);
  const labels = (fields.labels || []).map((x) => String(x).toLowerCase());
  const labelSet = new Set(labels);

  const description = normalizeText(extractDescriptionText(fields));
  const acceptanceCriteria = normalizeText(extractAcceptanceCriteria(fields));
  const jiraUpdatedAt = fields.updated || "";

  const blockers = [];

  if (statusName !== STATUS_READY) blockers.push(`Status is "${statusName}" not "${STATUS_READY}"`);
  if (!summary || summary.length < 8) blockers.push("Missing or too-short Summary");
  if (!description) blockers.push("Missing Description");
  if (!acceptanceCriteria) blockers.push("Missing Acceptance Criteria");

  for (const l of labelSet) {
    if (BLOCKING_LABELS.has(l)) blockers.push(`Blocking label: ${l}`);
  }

  if (REQUIRE_AUTOMATION_ALLOWED_LABEL && !labelSet.has(AUTOMATION_ALLOWED_LABEL)) {
    blockers.push(`Missing required label: ${AUTOMATION_ALLOWED_LABEL}`);
  }

  const targetRepo = DEFAULT_TARGET_REPO;
  if (!targetRepo) blockers.push("Missing target repo (DEFAULT_TARGET_REPO)");

  return {
    ok: blockers.length === 0,
    blockers,
    extracted: {
      jiraKey,
      jiraStatus: statusName,
      jiraUpdatedAt,
      summary,
      labels,
      description,
      acceptanceCriteria,
      targetRepo,
    },
  };
}

// ------------------- Core runner -------------------

export async function runJiraScanner({ jiraKey } = {}) {
  const runTs = humanTimestamp();
  const expectedKey = mustGetEnv("ORKY_API_KEY");

  const issues = [];
  if (jiraKey) {
    issues.push(await jiraGetIssue(jiraKey));
  } else {
    issues.push(...(await jiraSearchReadyIssues()));
  }

  const results = {
    runTimestamp: runTs,
    mode: jiraKey ? "single_issue" : "scan_ready_status",
    scanned: issues.length,
    processed: 0,
    skipped: 0,
    failed: 0,
    items: [],
  };

  for (const issue of issues) {
    const key = issue.key;

    try {
      const validation = validateHardRules(issue);

      if (!validation.ok) {
        const reason = validation.blockers.join("; ");
        const comment = `Status transitioned from ${STATUS_READY} to ${STATUS_IN_REVIEW} because - ${reason}`;

        await jiraTransition(key, TRANSITION_ID_TO_IN_REVIEW);
        await jiraAddComment(key, comment);

        results.skipped += 1;
        results.items.push({ jiraKey: key, outcome: "validation_failed_moved_to_in_review", reason });
        continue;
      }

      const { jiraUpdatedAt, jiraStatus, summary, labels, description, acceptanceCriteria, targetRepo } =
        validation.extracted;

      const fp = buildFingerprint({
        jiraKey: key,
        jiraUpdatedAt,
        jiraStatus,
        acceptanceCriteria,
        description,
      });

      await jiraTransition(key, TRANSITION_ID_TO_IN_PROGRESS);
      await jiraAddComment(key, `Orky picked up work at ${runTs} | fingerprint ${fp.short}`);

      const forgeInput = {
        jiraKey: key,
        runTimestamp: runTs,
        fingerprint: fp.full,
        fingerprintShort: fp.short,
        story: { summary, description, acceptanceCriteria, labels, jiraUpdatedAt },
        target: { repo: targetRepo },
      };

      const proposal = await forgeProposal(forgeInput);

      // Expect forgeProposal to either return a proposal object,
      // or { ok, proposal }. Normalize.
      const normalizedProposal =
        proposal?.proposal ? proposal.proposal : proposal;

      // If forge returns a github_pr proposal, extract payload. Otherwise, fail clearly.
      if (!normalizedProposal || normalizedProposal.kind !== "github_pr" || !normalizedProposal.payload) {
        throw new Error("forgeProposal did not return a github_pr proposal with payload");
      }

      const payload = normalizedProposal.payload;

      // Create PR in ohh-web
      const pr = await brainToHandsCreatePr({
        baseUrl: process.env.PUBLIC_BASE_URL || undefined, // optional; handler will use req host, but here we call function, so pass explicitly below
        apiKey: expectedKey,
        // We'll build baseUrl here (PUBLIC_BASE_URL required for server-to-server call)
        baseUrl: mustGetEnv("PUBLIC_BASE_URL"),
        repo: targetRepo,
        branchName: payload.branchName || `${key}/${runTs}`,
        prTitle: payload.prTitle || `${key}: ${summary}`,
        prBody:
          (payload.prBody || "") +
          `\n\nJira: ${key}\nFingerprint: ${fp.full}\nFingerprintShort: ${fp.short}\n`,
        commitMessage: payload.commitMessage || `Orky: ${key}`,
        files: payload.files,
        labels: ["created-by-orky"],
      });

      if (!pr?.prUrl) throw new Error("PR creation returned no prUrl");

      await jiraTransition(key, TRANSITION_ID_TO_IN_REVIEW);
      await jiraAddComment(key, `PR opened: ${pr.prUrl} | fingerprint ${fp.short}`);

      results.processed += 1;
      results.items.push({
        jiraKey: key,
        outcome: "pr_created_moved_to_in_review",
        prUrl: pr.prUrl,
        fingerprintShort: fp.short,
        repo: targetRepo,
        branch: payload.branchName || `${key}/${runTs}`,
      });
    } catch (err) {
      results.failed += 1;
      const msg = String(err?.message || err);

      try {
        const comment =
          `Status transitioned from ${STATUS_READY} to ${STATUS_IN_REVIEW} because - ` +
          `Scanner execution failed: ${msg}`;
        await jiraTransition(key, TRANSITION_ID_TO_IN_REVIEW);
        await jiraAddComment(key, comment);
      } catch {
        // ignore secondary failure
      }

      results.items.push({ jiraKey: key, outcome: "failed", error: msg });
    }
  }

  return results;
}

// ------------------- Vercel route handler -------------------
// Jira Automation calls POST /api/brain/jira_scanner with JSON body { jiraKey: "ORKY-123" }
export default async function jiraScannerHandler(req, res) {
  try {
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

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const jiraKey = body.jiraKey ? String(body.jiraKey).trim() : "";

    const result = await runJiraScanner({ jiraKey: jiraKey || undefined });
    return res.status(200).json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
