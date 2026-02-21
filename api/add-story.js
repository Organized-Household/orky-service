// api/add-story.js
//
// POST /api/add-story
// Creates a Story under an EXISTING Epic (team-managed) using parent: { key: EPIC-KEY }.
//
// Required env vars:
// - JIRA_BASE_URL
// - JIRA_EMAIL
// - JIRA_API_TOKEN
// - JIRA_PROJECT_KEY
//
// Body JSON:
// {
//   "epicKey": "ORKY-6",
//   "storySummary": "My Story",
//   "storyDescription": "Optional"
// }

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

function adf(text) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

async function getCreateMetaFields(jira, projectKey, issueTypeName) {
  const qs = new URLSearchParams({
    projectKeys: projectKey,
    issuetypeNames: issueTypeName,
    expand: "projects.issuetypes.fields",
  }).toString();

  const meta = await jiraFetch(jira, `/rest/api/3/issue/createmeta?${qs}`);
  const proj = meta?.projects?.[0];
  const it = proj?.issuetypes?.[0];
  return it?.fields || {};
}

async function getMyAccountId(jira) {
  const me = await jiraFetch(jira, "/rest/api/3/myself", { method: "GET" });
  const accountId = me?.accountId;
  if (!accountId) throw new Error("Could not determine Jira accountId from /myself");
  return accountId;
}

function missingRequired(fieldsMeta, fieldsPayload) {
  return Object.entries(fieldsMeta)
    .filter(([, def]) => def?.required)
    .filter(([fieldId]) => fieldsPayload[fieldId] === undefined)
    .map(([fieldId, def]) => ({ fieldId, name: def?.name }));
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

    const epicKey = req.body?.epicKey;
    if (!epicKey || typeof epicKey !== "string") {
      return res.status(400).json({ ok: false, error: "Missing required body field: epicKey (e.g., ORKY-6)" });
    }

    const storySummary = req.body?.storySummary || `Story under ${epicKey}`;
    const storyDescription = req.body?.storyDescription || `Created by Orky API under Epic ${epicKey}.`;

    // Validate the epic exists (optional but helpful)
    // If epicKey is wrong, this will throw cleanly.
    await jiraFetch(jira, `/rest/api/3/issue/${encodeURIComponent(epicKey)}?fields=key,issuetype`, { method: "GET" });

    const myAccountId = await getMyAccountId(jira);

    // Discover required fields for Story in THIS project
    const storyMeta = await getCreateMetaFields(jira, jira.projectKey, "Story");

    const storyFields = {
      project: { key: jira.projectKey },
      summary: storySummary,
      issuetype: { name: "Story" },
      description: adf(storyDescription),
      parent: { key: epicKey }, // team-managed epic -> story relationship
    };

    // Auto-fill Reporter if required
    if (storyMeta["reporter"]?.required) {
      storyFields.reporter = { accountId: myAccountId };
    }

    const missing = missingRequired(storyMeta, storyFields);
    if (missing.length > 0) {
      return res.status(400).json({
        ok: false,
        error: "Jira reports additional required fields for Story.",
        missingRequired: missing,
      });
    }

    const created = await jiraFetch(jira, "/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify({ fields: storyFields }),
    });

    return res.status(200).json({
      ok: true,
      story: created,
      epicKey,
    });
  } catch (e) {
    console.error("[add-story] error:", e?.message, e?.details || e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "Unknown error",
      jiraDetails: e?.details || null,
    });
  }
}
