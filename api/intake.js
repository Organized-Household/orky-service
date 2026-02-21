// api/intake.js
//
// Vercel Serverless Function: POST /api/intake
//
// Creates 1 Epic in a TEAM-MANAGED Jira project.
// Optionally creates 1 Story under that Epic using `parent: { key: epicKey }`.
//
// Required env vars (you already have these):
// - JIRA_BASE_URL        e.g. https://your-domain.atlassian.net
// - JIRA_EMAIL
// - JIRA_API_TOKEN
// - JIRA_PROJECT_KEY
//
// Optional env var:
// - CREATE_STORY_UNDER_EPIC  "true" | "false" (default false)

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function authHeader(email, token) {
  const basic = Buffer.from(`${email}:${token}`).toString("base64");
  return `Basic ${basic}`;
}

async function jiraFetch(jira, path, init = {}) {
  const res = await fetch(`${jira.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(jira.email, jira.apiToken),
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`Jira error ${res.status}: ${res.statusText}`);
    err.details = json;
    throw err;
  }
  return json;
}

// Atlassian Document Format (ADF) for description
function adf(text) {
  return {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text }] },
    ],
  };
}

// Discover required fields for (projectKey, issueTypeName)
async function getCreateMetaFields(jira, projectKey, issueTypeName) {
  const qs = new URLSearchParams({
    projectKeys: projectKey,
    issuetypeNames: issueTypeName,
    expand: "projects.issuetypes.fields",
  }).toString();

  const meta = await jiraFetch(jira, `/rest/api/3/issue/createmeta?${qs}`);
  const proj = meta?.projects?.[0];
  const it = proj?.issuetypes?.[0];
  const fields = it?.fields || {};
  return fields;
}

// Heuristic: find an "Epic name" field if it exists
function findEpicNameFieldId(fields) {
  for (const [fieldId, def] of Object.entries(fields)) {
    const name = (def?.name || "").toLowerCase();
    if (name.includes("epic") && name.includes("name")) return fieldId;
  }
  return null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Use POST" });
    }

    const jira = {
      baseUrl: mustEnv("JIRA_BASE_URL"),
      email: mustEnv("JIRA_EMAIL"),
      apiToken: mustEnv("JIRA_API_TOKEN"),
      projectKey: mustEnv("JIRA_PROJECT_KEY"),
    };

    const CREATE_STORY_UNDER_EPIC =
      (process.env.CREATE_STORY_UNDER_EPIC || "false").toLowerCase() === "true";

    // Optional request body overrides for fast testing
    const epicSummary = req.body?.epicSummary || "Orky - First API Epic";
    const epicDescription =
      req.body?.epicDescription || "Created by Orky via Vercel API (no DB logging yet).";

    const storySummary = req.body?.storySummary || "Orky - First API Story";
    const storyDescription =
      req.body?.storyDescription || "Created under the Epic using parent=Epic (team-managed).";

    // ---- 1) Create Epic (with createmeta required-field detection) ----
    const epicMetaFields = await getCreateMetaFields(jira, jira.projectKey, "Epic");

    const epicFields = {
      project: { key: jira.projectKey },
      summary: epicSummary,
      issuetype: { name: "Epic" },
      description: adf(epicDescription),
    };

    // If Jira requires an Epic Name field, populate it automatically
    const epicNameFieldId = findEpicNameFieldId(epicMetaFields);
    if (epicNameFieldId && epicMetaFields[epicNameFieldId]?.required) {
      epicFields[epicNameFieldId] = epicSummary;
    }

    // If Jira reports other required fields, fail early with a helpful response
    const missingEpicRequired = Object.entries(epicMetaFields)
      .filter(([, def]) => def?.required)
      .filter(([fieldId]) => epicFields[fieldId] === undefined)
      .map(([fieldId, def]) => ({ fieldId, name: def?.name }));

    if (missingEpicRequired.length > 0) {
      return res.status(400).json({
        ok: false,
        error: "Jira reports additional required fields for Epic.",
        missingRequired: missingEpicRequired,
        tip: "Reply with this JSON and I’ll update intake.js to include those fields safely.",
      });
    }

    const epicCreate = await jiraFetch(jira, "/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify({ fields: epicFields }),
    });

    const epicKey = epicCreate?.key;

    // ---- 2) Optionally create Story under Epic (TEAM-MANAGED uses parent) ----
    let storyCreate = null;

    if (CREATE_STORY_UNDER_EPIC) {
      const storyMetaFields = await getCreateMetaFields(jira, jira.projectKey, "Story");

      const storyFields = {
        project: { key: jira.projectKey },
        summary: storySummary,
        issuetype: { name: "Story" },
        description: adf(storyDescription),
        parent: { key: epicKey }, // team-managed link
      };

      const missingStoryRequired = Object.entries(storyMetaFields)
        .filter(([, def]) => def?.required)
        .filter(([fieldId]) => storyFields[fieldId] === undefined)
        .map(([fieldId, def]) => ({ fieldId, name: def?.name }));

      if (missingStoryRequired.length > 0) {
        return res.status(400).json({
          ok: false,
          error: "Jira reports additional required fields for Story.",
          epic: epicCreate,
          missingRequired: missingStoryRequired,
        });
      }

      storyCreate = await jiraFetch(jira, "/rest/api/3/issue", {
        method: "POST",
        body: JSON.stringify({ fields: storyFields }),
      });
    }

    return res.status(200).json({
      ok: true,
      epic: epicCreate,
      story: storyCreate,
      createdStory: CREATE_STORY_UNDER_EPIC,
    });
  } catch (e) {
    console.error("[intake] error:", e?.message, e?.details || e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "Unknown error",
      jiraDetails: e?.details || null,
    });
  }
}
