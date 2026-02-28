// api/brain/jira_scanner.js
//
// Orky Jira Scanner + Orchestrator
// Trigger model (recommended):
// - Jira Automation calls this endpoint when an issue transitions to "Ready for Engineering"
// - Body includes { jiraKey: "ORKY-123" } so we process only that ticket
//
// Behavior:
// - Validate required info (hard rules)
// - If validation fails: transition Ready for Engineering -> In Review and comment reason
// - If validation passes: transition Ready for Engineering -> In Progress
// - Forge proposal -> create PR in ohh-web -> transition to In Review with PR URL
//
// Human-readable IDs only: Jira key + timestamp.

import crypto from "crypto";

// --- External modules you said are working ---
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
const DEFAULT_TARGET_REPO = process.env.DEFAULT_TARGET_REPO || "";
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

  return jiraFetch(`/rest/api/3/search?${params.toString()}`);
}

function extractDescriptionText(fields) {
  const desc = fields?.description;
  if (!desc) return "";
  if (typeof desc === "string") return desc;

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
  const jiraKey = issue.key || issue.id || "UNKNOWN";

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
  if (!targetRepo) blockers.push("Missing target repo (set DEFAULT_TARGET_REPO or map from Jira field)");

  return {
    ok: blockers.length === 0,
    blockers,
    extracted: {
      jiraKey: issue.key,
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

  // If Jira Automation passes jiraKey, process only that issue.
  const issues = [];
  if (jiraKey) {
    const issue = await jiraGetIssue(jiraKey);
    issues.push(issue);
  } else {
    const scan = await jiraSearchReadyIssues();
    issues.push(...(scan.issues || []));
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

      const pr = await brainToHandsCreatePr({
        jiraKey: key,
        repo: targetRepo,
        timestamp: runTs,
        branchName: `${key}/${runTs}`,
        prTitle: `${key}: ${summary}`,
        labels: ["created-by-orky"],
        meta: { jiraKey: key, fingerprint: fp.full, fingerprintShort: fp.short, runTimestamp: runTs },
        proposal,
      });

      const prUrl = pr?.url || pr?.html_url || pr?.prUrl || null;
      if (!prUrl) throw new Error("PR creation returned no URL (expected pr.url)");

      await jiraTransition(key, TRANSITION_ID_TO_IN_REVIEW);
      await jiraAddComment(key, `PR opened: ${prUrl} | fingerprint ${fp.short}`);

      results.processed += 1;
      results.items.push({
        jiraKey: key,
        outcome: "pr_created_moved_to_in_review",
        prUrl,
        fingerprintShort: fp.short,
        repo: targetRepo,
        branch: `${key}/${runTs}`,
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
// Jira Automation will call POST /api/brain/jira_scanner with JSON body { jiraKey: "ORKY-123" }
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed. Use POST." });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const jiraKey = body.jiraKey ? String(body.jiraKey).trim() : "";

    const result = await runJiraScanner({ jiraKey: jiraKey || undefined });
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
