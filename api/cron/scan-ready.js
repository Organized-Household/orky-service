// api/cron/scan-ready.js
import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function normalizePem(pem) {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

async function getOctokitAsInstallation() {
  const appId = mustGetEnv("GH_APP_ID");
  const installationId = mustGetEnv("GH_APP_INSTALLATION_ID");
  const privateKey = normalizePem(mustGetEnv("GH_APP_PRIVATE_KEY"));

  const auth = createAppAuth({
    appId,
    privateKey,
    installationId,
  });

  const { token } = await auth({ type: "installation" });
  return new Octokit({ auth: token });
}

function getBaseUrl(req) {
  // Recommended: set PUBLIC_BASE_URL in env for stability.
  // Fallback: use request host.
  return process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
}

function extractContextSources(descriptionText) {
  // Optional convention: allow embedding JSON in Jira description
  // === CONTEXT_SOURCES_JSON ===
  // { ... }
  // === /CONTEXT_SOURCES_JSON ===
  if (!descriptionText || typeof descriptionText !== "string") return [];
  const start = "=== CONTEXT_SOURCES_JSON ===";
  const end = "=== /CONTEXT_SOURCES_JSON ===";

  const s = descriptionText.indexOf(start);
  const e = descriptionText.indexOf(end);

  if (s === -1 || e === -1 || e <= s) return [];

  const jsonText = descriptionText.slice(s + start.length, e).trim();
  try {
    const parsed = JSON.parse(jsonText);
    // Accept either {contextSources:[...]} or just [...]
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.contextSources)) return parsed.contextSources;
    return [];
  } catch {
    return [];
  }
}

async function jiraSearchReadyIssues() {
  const baseUrl = mustGetEnv("JIRA_BASE_URL").replace(/\/+$/, "");
  const email = mustGetEnv("JIRA_EMAIL");
  const token = mustGetEnv("JIRA_API_TOKEN");
 
