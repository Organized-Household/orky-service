// api/intake/batch.js
//
// POST /api/intake/batch
// Creates MANY Epics and Stories (team-managed) in ONE request.
// Continues on per-record errors and returns a success/failure report.
//
// Auth (your own, NOT Vercel):
//   Authorization: Bearer <ORKY_API_KEY>
//
// Required env vars:
// - ORKY_API_KEY
// - JIRA_BASE_URL
// - JIRA_EMAIL
// - JIRA_API_TOKEN
// - JIRA_PROJECT_KEY
//
// Payload shape (high-level):
// {
//   "epics": [
//     {
//       "epicSummary": "Epic title",
//       "epicDescription": "Optional",
//       "fields": { "labels": ["foo"], "components": [{"name":"Backend"}], "priority": {"name":"Medium"} },
//       "stories": [
//         {
//           "storySummary": "Story title",
//           "storyDescription": "Optional",
//           "fields": { "labels": ["foo-story"] }
//         }
//       ]
//     }
//   ],
//   "options": { "dryRun": false }
// }
//
// Notes:
// - Team-managed story->epic link uses: fields.parent = { key: EPIC_KEY }
// - You can pass additional Jira fields in `fields` (including customfield_XXXXX).
// - Protected keys (project, issuetype, parent, summary, description) cannot be overridden via `fields`.

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function requireBearer(req) {
  const expected = mustEnv("ORKY_API_KEY");
  const auth = req.headers?.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const got = m?.[1] || "";
  if (!got || got !== expected) {
    const e = new Error("Unauthorized");
    e.statusCode = 401;
    throw e;
  }
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
    err.statusCode = res.status;
    err.details = json;
    throw err;
  }
  return json;
}

function adf(text) {
  const safe = (text ?? "").toString();
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: safe ? [{ type: "text", text: safe }] : [{ type: "text", text: "" }],
      },
    ],
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
  for (const [fieldId, def] of Object.entries(fields || {})) {
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
  return Object.entries(fieldsMeta || {})
    .filter(([, def]) => def?.required)
    .filter(([fieldId]) => fieldsPayload[fieldId] === undefined)
    .map(([fieldId, def]) => ({ fieldId, name: def?.name }));
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function mergeAllowed(baseFields, extraFields) {
  if (!isPlainObject(extraFields)) return baseFields;

  // Protect critical routing keys from being overridden by payload.
  const PROTECTED = new Set(["project", "issuetype", "parent", "summary", "description"]);

  const merged = { ...baseFields };
  for (const [k, v] of Object.entries(extraFields)) {
    if (PROTECTED.has(k)) continue;
    merged[k] = v;
  }
  return merged;
}

function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  return String(v);
}

export default async function handler(req, res) {
  const startedAt = new Date().toISOString();

  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Use POST" });
    }

    // Your own auth gate (so Orky can call without Vercel Deployment Protection).
    requireBearer(req);

    const jira = {
      baseUrl: mustEnv("JIRA_BASE_URL"),
      email: mustEnv("JIRA_EMAIL"),
      apiToken: mustEnv("JIRA_API_TOKEN"),
      projectKey: mustEnv("JIRA_PROJECT_KEY"),
    };

    const body = req.body || {};
    const epics = Array.isArray(body.epics) ? body.epics : [];
    const dryRun = !!body?.options?.dryRun;

    if (epics.length === 0) {
      return res.status(400).json({ ok: false, error: "Body must include epics: [] with at least one item." });
    }

    const myAccountId = await getMyAccountId(jira);

    // Fetch metadata once (faster + consistent required-field detection).
    const epicMeta = await getCreateMetaFields(jira, jira.projectKey, "Epic");
    const storyMeta = await getCreateMetaFields(jira, jira.projectKey, "Story");
    const epicNameFieldId = findEpicNameFieldId(epicMeta);

    const results = [];
    let createdEpics = 0;
    let createdStories = 0;
    let failedEpics = 0;
    let failedStories = 0;

    for (let i = 0; i < epics.length; i++) {
      const item = epics[i] || {};
      const epicSummary = safeString(item.epicSummary, "").trim();

      if (!epicSummary) {
        failedEpics++;
        results.push({
          index: i,
          ok: false,
          epic: null,
          error: "Missing epicSummary",
          stories: [],
        });
        continue;
      }

      const epicDescription = safeString(item.epicDescription, "Created by Orky batch API.");
      const epicExtraFields = item.fields;

      // Build base epic fields (then allow merges).
      let epicFields = {
        project: { key: jira.projectKey },
        summary: epicSummary,
        issuetype: { name: "Epic" },
        description: adf(epicDescription),
      };

      // Epic Name field (team-managed still has it; Jira varies by config)
      if (epicNameFieldId && epicMeta?.[epicNameFieldId]?.required) {
        epicFields[epicNameFieldId] = epicSummary;
      }

      // Reporter (only if Jira requires)
      if (epicMeta?.reporter?.required) {
        epicFields.reporter = { accountId: myAccountId };
      }

      epicFields = mergeAllowed(epicFields, epicExtraFields);

      const epicMissing = missingRequired(epicMeta, epicFields);
      if (epicMissing.length > 0) {
        failedEpics++;
        results.push({
          index: i,
          ok: false,
          epic: null,
          error: "Jira requires additional fields for Epic.",
          missingRequired: epicMissing,
          stories: [],
        });
        continue;
      }

      // Create epic (or simulate)
      let epicCreate = null;
      let epicKey = null;

      try {
        if (dryRun) {
          epicCreate = { key: "(dry-run)", fields: { summary: epicSummary } };
          epicKey = "(dry-run)";
        } else {
          epicCreate = await jiraFetch(jira, "/rest/api/3/issue", {
            method: "POST",
            body: JSON.stringify({ fields: epicFields }),
          });
          epicKey = epicCreate?.key || null;
        }

        createdEpics++;

        const stories = Array.isArray(item.stories) ? item.stories : [];
        const storyResults = [];

        for (let j = 0; j < stories.length; j++) {
          const s = stories[j] || {};
          const storySummary = safeString(s.storySummary, "").trim();

          if (!storySummary) {
            failedStories++;
            storyResults.push({
              index: j,
              ok: false,
              story: null,
              error: "Missing storySummary",
            });
            continue;
          }

          const storyDescription = safeString(
            s.storyDescription,
            epicKey && epicKey !== "(dry-run)" ? `Created by Orky batch API under Epic ${epicKey}.` : "Created by Orky batch API."
          );

          let storyFields = {
            project: { key: jira.projectKey },
            summary: storySummary,
            issuetype: { name: "Story" },
            description: adf(storyDescription),
            parent: { key: epicKey && epicKey !== "(dry-run)" ? epicKey : "ORKY-EXAMPLE" },
          };

          // Reporter if required
          if (storyMeta?.reporter?.required) {
            storyFields.reporter = { accountId: myAccountId };
          }

          storyFields = mergeAllowed(storyFields, s.fields);

          const storyMissing = missingRequired(storyMeta, storyFields);
          if (storyMissing.length > 0) {
            failedStories++;
            storyResults.push({
              index: j,
              ok: false,
              story: null,
              error: "Jira requires additional fields for Story.",
              missingRequired: storyMissing,
            });
            continue;
          }

          try {
            let storyCreate = null;
            if (dryRun) {
              storyCreate = { key: "(dry-run)" };
            } else {
              storyCreate = await jiraFetch(jira, "/rest/api/3/issue", {
                method: "POST",
                body: JSON.stringify({ fields: storyFields }),
              });
            }
            createdStories++;
            storyResults.push({
              index: j,
              ok: true,
              story: storyCreate,
            });
          } catch (e) {
            failedStories++;
            storyResults.push({
              index: j,
              ok: false,
              story: null,
              error: e?.message || "Story create failed",
              jiraDetails: e?.details || null,
              statusCode: e?.statusCode || 500,
            });
          }
        }

        results.push({
          index: i,
          ok: true,
          epic: epicCreate,
          epicKey,
          stories: storyResults,
        });
      } catch (e) {
        failedEpics++;
        results.push({
          index: i,
          ok: false,
          epic: null,
          error: e?.message || "Epic create failed",
          jiraDetails: e?.details || null,
          statusCode: e?.statusCode || 500,
          stories: [],
        });
      }
    }

    const finishedAt = new Date().toISOString();

    return res.status(200).json({
      ok: true,
      mode: "batch",
      dryRun,
      startedAt,
      finishedAt,
      totals: {
        epicsRequested: epics.length,
        epicsCreated: createdEpics,
        epicsFailed: failedEpics,
        storiesCreated: createdStories,
        storiesFailed: failedStories,
      },
      results,
    });
  } catch (e) {
    const status = e?.statusCode || 500;
    return res.status(status).json({
      ok: false,
      error: e?.message || "Unknown error",
      startedAt,
    });
  }
}
