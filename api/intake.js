// api/intake.js
//
// POST /api/intake
// Creates Epic (and optionally Story) in TEAM-MANAGED Jira.
// Auto-fills required "Reporter" by using the authenticated Jira user (/myself).

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

function findEpicNameFieldId(fields) {
  for (const [fieldId, def] of Object.entries(fields)) {
    const name = (def?.name || "").toLowerCase();
    if (name.includes("epic") && name.includes("name")) return fieldId;
  }
  return null;
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

    const CREATE_STORY_UNDER_EPIC =
      (process.env.CREATE_STORY_UNDER_EPIC || "false").toLowerCase() === "true";

    const epicSummary = req.body?.epicSummary || "Orky - First API Epic";
    const epicDescription =
      req.body?.epicDescription || "Created by Orky via Vercel API (no DB logging yet).";

    const storySummary = req.body?.storySummary || "Orky - First API Story";
    const storyDescription =
      req.body?.storyDescription || "Created under the Epic using parent=Epic (team-managed).";

    // Fetch authenticated user accountId once; use it to satisfy required Reporter
    const myAccountId = await getMyAccountId(jira);

    // ---- EPIC ----
    const epicMeta = await getCreateMetaFields(jira, jira.projectKey, "Epic");

    const epicFields = {
      project: { key: jira.projectKey },
      summary: epicSummary,
      issuetype: { name: "Epic" },
      description: adf(epicDescription),
    };

    // Auto-fill Epic Name if Jira requires it
    const epicNameFieldId = findEpicNameFieldId(epicMeta);
    if (epicNameFieldId && epicMeta[epicNameFieldId]?.required) {
      epicFields[epicNameFieldId] = epicSummary;
    }

    // Auto-fill Reporter if required
    if (epicMeta["reporter"]?.required) {
      epicFields.reporter = { accountId: myAccountId };
    }

    const epicMissing = missingRequired(epicMeta, epicFields);
    if (epicMissing.length > 0) {
      return res.status(400).json({
        ok: false,
        error: "Jira reports additional required fields for Epic.",
        missingRequired: epicMissing,
      });
    }

    const epicCreate = await jiraFetch(jira, "/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify({ fields: epicFields }),
    });

    const epicKey = epicCreate?.key;

    // ---- STORY (optional) ----
    let storyCreate = null;
    if (CREATE_STORY_UNDER_EPIC) {
      const storyMeta = await getCreateMetaFields(jira, jira.projectKey, "Story");

      const storyFields = {
        project: { key: jira.projectKey },
        summary: storySummary,
        issuetype: { name: "Story" },
        description: adf(storyDescription),
        parent: { key: epicKey },
      };

      if (storyMeta["reporter"]?.required) {
        storyFields.reporter = { accountId: myAccountId };
      }

      const storyMissing = missingRequired(storyMeta, storyFields);
      if (storyMissing.length > 0) {
        return res.status(400).json({
          ok: false,
          error: "Jira reports additional required fields for Story.",
          epic: epicCreate,
          missingRequired: storyMissing,
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
