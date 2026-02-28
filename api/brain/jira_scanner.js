// jira_scanner.js
//
// Orky Jira Scanner + Orchestrator
// - Scans Jira project/space for issues in "Ready for Engineering"
// - Validates required info (hard rules)
// - Transitions Jira: Ready for Engineering -> In Progress (locks work)
// - Generates proposal via forge.js
// - Creates PR via forge_to_pr.js / pr.js
// - Transitions Jira: In Progress -> In Review (after PR is opened)
// - If validation fails AFTER In Progress, transitions to In Review with comment:
//
//   "Status transitioned from Ready for Engineering to In Review because - <reason>"
//
// Human-readable IDs only: Jira key + timestamp.
//
// Notes:
// - "Space" in Jira Cloud UI is not always addressable via API; most automation keys off PROJECT KEY.
//   Set JIRA_PROJECT_KEY accordingly for "All Ai SaaS Team" project.
// - Transition actions require Jira transition IDs; provide them via env vars (recommended).
//
// Required env vars (typical):
//   JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY
//   GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO (if PR preflight is in this file; optional)
// Optional env vars:
//   JIRA_ACCEPTANCE_CRITERIA_FIELD_ID = customfield_12345
//   DEFAULT_TARGET_REPO = ohh-web (or orky-service, etc.)
//   JIRA_TRANSITION_ID_TO_IN_PROGRESS = <id>
//   JIRA_TRANSITION_ID_TO_IN_REVIEW = <id>

import crypto from "crypto";

// --- External modules you said are working ---
import { forgeProposal } from "./forge.js"; // must return a proposal JSON object/string your system expects
import { brainToHandsCreatePr } from "./forge_to_pr.js"; // should create PR given proposal + metadata
// If you don't have brainToHandsCreatePr, replace with your existing export.

// ------------------- Config -------------------

const STATUS_READY = "Ready for Engineering";
const STATUS_IN_PROGRESS = "In Progress";
const STATUS_IN_REVIEW = "In Review";

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY;

const JIRA_AC_FIELD_ID = process.env.JIRA_ACCEPTANCE_CRITERIA_FIELD_ID || ""; // e.g. customfield_12345
const DEFAULT_TARGET_REPO = process.env.DEFAULT_TARGET_REPO || ""; // required for multi-repo
const TRANSITION_ID_TO_IN_PROGRESS = process.env.JIRA_TRANSITION_ID_TO_IN_PROGRESS || "";
const TRANSITION_ID_TO_IN_REVIEW = process.env.JIRA_TRANSITION_ID_TO_IN_REVIEW || "";

const BLOCKING_LABELS = new Set([
  "blocked",
  "needs-info",
  "do-not-automate",
  "security-review-required",
]);

// If true, require label "automation:allowed"
const REQUIRE_AUTOMATION_ALLOWED_LABEL = false;
const AUTOMATION_ALLOWED_LABEL = "automation:allowed";

// ------------------- Utilities -------------------

function humanTimestamp() {
  // YYYY-MM-DD_HH-mm-ss
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
  return {
    full,
    short: `fp_${full.slice(0, 8)}`,
  };
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

  // Some Jira endpoints return 204 no content
  if (res.status === 204) return null;
  return res.json();
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
  // 1) Prefer custom field if configured
  if (JIRA_AC_FIELD_ID && fields?.[JIRA_AC_FIELD_ID]) {
    const v = fields[JIRA_AC_FIELD_ID];
    if (typeof v === "string") return normalizeText(v);
    return normalizeText(JSON.stringify(v));
  }

  // 2) Fallback: parse from description section
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
    // If you don't provide IDs, we fail fast so you don't silently do nothing.
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

// ------------------- Hard rules (must-have story info) -------------------

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

  // Must be ready (defensive)
  if (statusName !== STATUS_READY) blockers.push(`Status is "${statusName}" not "${STATUS_READY}"`);

  // Must have summary
  if (!summary || summary.length < 8) blockers.push("Missing or too-short Summary");

  // Must have description (for codegen reliability)
  if (!description) blockers.push("Missing Description");

  // Must have Acceptance Criteria
  if (!acceptanceCriteria) blockers.push("Missing Acceptance Criteria");

  // Blocked labels
  for (const l of labelSet) {
    if (BLOCKING_LABELS.has(l)) blockers.push(`Blocking label: ${l}`);
  }

  // Optional: require automation allowed label
  if (REQUIRE_AUTOMATION_ALLOWED_LABEL && !labelSet.has(AUTOMATION_ALLOWED_LABEL)) {
    blockers.push(`Missing required label: ${AUTOMATION_ALLOWED_LABEL}`);
  }

  // Must have target repo (either mapped from Jira field OR default)
  // For now: require DEFAULT_TARGET_REPO.
  const targetRepo = DEFAULT_TARGET_REPO;
  if (!targetRepo) blockers.push("Missing target repo (set DEFAULT_TARGET_REPO or map from Jira field)");

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

// ------------------- Main Orchestrator -------------------

export async function runJiraScanner() {
  const runTs = humanTimestamp();

  const scan = await jiraSearchReadyIssues();
  const issues = scan.issues || [];

  const results = {
    runTimestamp: runTs,
    scanned: issues.length,
    processed: 0,
    skipped: 0,
    failed: 0,
    items: [],
  };

  for (const issue of issues) {
    const jiraKey = issue.key;

    try {
      // 1) Validate (hard rules) BEFORE touching status.
      const validation = validateHardRules(issue);

      if (!validation.ok) {
        // Your requested behavior:
        // "When validation fails, change the story status back to In review and log the reason..."
        //
        // In this flow we have NOT transitioned to In Progress yet.
        // But per your instruction, we WILL transition to In Review and comment why.
        const reason = validation.blockers.join("; ");
        const comment =
          `Status transitioned from ${STATUS_READY} to ${STATUS_IN_REVIEW} because - ${reason}`;

        // Transition Ready -> In Review
        await jiraTransition(jiraKey, TRANSITION_ID_TO_IN_REVIEW);
        await jiraAddComment(jiraKey, comment);

        results.skipped += 1;
        results.items.push({
          jiraKey,
          outcome: "validation_failed_moved_to_in_review",
          reason,
        });
        continue;
      }

      const {
        jiraUpdatedAt,
        jiraStatus,
        summary,
        labels,
        description,
        acceptanceCriteria,
        targetRepo,
      } = validation.extracted;

      // 2) Fingerprint (idempotency key)
      const fp = buildFingerprint({
        jiraKey,
        jiraUpdatedAt,
        jiraStatus,
        acceptanceCriteria,
        description,
      });

      // 3) Transition Ready -> In Progress (locks the work)
      await jiraTransition(jiraKey, TRANSITION_ID_TO_IN_PROGRESS);
      await jiraAddComment(
        jiraKey,
        `Orky picked up work at ${runTs} | fingerprint ${fp.short}`
      );

      // 4) Forge proposal (LLM -> proposal JSON)
      // Provide consistent input shape so forge is stable.
      const forgeInput = {
        jiraKey,
        runTimestamp: runTs,
        fingerprint: fp.full,
        fingerprintShort: fp.short,
        story: {
          summary,
          description,
          acceptanceCriteria,
          labels,
          jiraUpdatedAt,
        },
        target: {
          repo: targetRepo,
        },
      };

      const proposal = await forgeProposal(forgeInput);

      // 5) Create PR (immediate)
      // Branch must be human readable: <JIRAKEY>/<timestamp>
      // PR must be labeled created-by-orky and include fingerprint in body.
      const pr = await brainToHandsCreatePr({
        jiraKey,
        repo: targetRepo,
        timestamp: runTs,
        branchName: `${jiraKey}/${runTs}`,
        prTitle: `${jiraKey}: ${summary}`,
        labels: ["created-by-orky"],
        // Ensure your forge_to_pr.js/pr.js uses these in the PR body
        meta: {
          jiraKey,
          fingerprint: fp.full,
          fingerprintShort: fp.short,
          runTimestamp: runTs,
        },
        proposal,
      });

      // Expect pr to include { url } at minimum
      const prUrl = pr?.url || pr?.html_url || pr?.prUrl || null;
      if (!prUrl) {
        throw new Error("PR creation returned no URL (expected pr.url)");
      }

      // 6) Transition In Progress -> In Review (after PR success)
      // (Your diagram indicates PR Ready for Review path to In Review)
      await jiraTransition(jiraKey, TRANSITION_ID_TO_IN_REVIEW);
      await jiraAddComment(
        jiraKey,
        `PR opened: ${prUrl} | fingerprint ${fp.short}`
      );

      results.processed += 1;
      results.items.push({
        jiraKey,
        outcome: "pr_created_moved_to_in_review",
        prUrl,
        fingerprintShort: fp.short,
        repo: targetRepo,
        branch: `${jiraKey}/${runTs}`,
      });
    } catch (err) {
      results.failed += 1;

      const msg = String(err?.message || err);

      // If we fail after transitioning to In Progress, we should move to In Review with explanation.
      // We can attempt a best-effort transition & comment (don’t let secondary failure hide the primary failure).
      try {
        const comment =
          `Status transitioned from ${STATUS_READY} to ${STATUS_IN_REVIEW} because - ` +
          `Scanner execution failed: ${msg}`;
        await jiraTransition(jiraKey, TRANSITION_ID_TO_IN_REVIEW);
        await jiraAddComment(jiraKey, comment);
      } catch {
        // swallow to preserve original error in results
      }

      results.items.push({
        jiraKey,
        outcome: "failed",
        error: msg,
      });
    }
  }

  return results;
}

// Optional CLI usage:
// node jira_scanner.js
if (import.meta.url === `file://${process.argv[1]}`) {
  runJiraScanner()
    .then((out) => {
      console.log(JSON.stringify(out, null, 2));
      process.exit(0);
    })
    .catch((e) => {
      console.error("runJiraScanner failed:", e);
      process.exit(1);
    });
}
