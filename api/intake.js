// api/intake.js
//
// POST /api/intake
//
// Auth (required):
//   Header: x-orky-key: <ORKY_API_KEY>   (recommended)
//   OR
//   Authorization: Bearer <ORKY_API_KEY>
//
// Supported payload modes:
//
// A) Single Epic create:
//    Body: {
//      "PDEEpicID": "EPIC-1",
//      "title": "EPIC-1 — Example Epic",
//      "description": "Epic description"
//    }
//
// B) Single Story create under existing Epic by Jira key:
//    Body: {
//      "epicKey": "OHHFIN-1",
//      "PDEStoryID": "STORY-1.1",
//      "PDEEpicID": "EPIC-1",
//      "title": "STORY-1.1 — Example Story",
//      "description": "Story description",
//      "acceptanceCriteria": ["One", "Two", "Three"]
//    }
//
// C) Batch create (merged epic + nested stories):
//    Body: {
//      "epics": [
//        {
//          "PDEEpicID": "EPIC-1",
//          "title": "EPIC-1 — Example Epic",
//          "description": "Epic description",
//          "stories": [
//            {
//              "PDEStoryID": "STORY-1.1",
//              "PDEEpicID": "EPIC-1",
//              "title": "STORY-1.1 — Example Story",
//              "description": "Story description",
//              "acceptanceCriteria": ["One", "Two"]
//            }
//          ]
//        }
//      ],
//      "options": { "dryRun": false }
//    }
//
// Required env vars:
// - ORKY_API_KEY
// - JIRA_BASE_URL
// - JIRA_EMAIL
// - JIRA_API_TOKEN
// - JIRA_PROJECT_KEY
//
// Recommended env vars for custom fields:
// - JIRA_FIELD_PDE_EPIC_ID
// - JIRA_FIELD_PDE_STORY_ID
// - JIRA_FIELD_ACCEPTANCE_CRITERIA

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getOptionalEnv(name) {
  return process.env[name] || null;
}

function safeStr(v, max = 120) {
  const s = String(v ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}

function getProvidedOrkyKey(req) {
  const hdr =
    req.headers["x-orky-key"] ||
    req.headers["X-Orky-Key"] ||
    req.headers["x-orky-Key"];

  const auth = req.headers["authorization"] || req.headers["Authorization"];
  if (auth && typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  if (hdr && typeof hdr === "string") return hdr.trim();
  return null;
}

function assertOrkyAuth(req) {
  const expected = mustEnv("ORKY_API_KEY");
  const provided = getProvidedOrkyKey(req);
  if (!provided || provided !== expected) {
    const err = new Error(
      "Unauthorized. Missing required authorization (Authorization: Bearer <ORKY_API_KEY> or x-orky-key)."
    );
    err.statusCode = 401;
    throw err;
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
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: String(text || "") }],
      },
    ],
  };
}

function normalizeAcceptanceCriteria(value) {
  if (!value) return "";
  if (Array.isArray(value)) {
    return value.map((x) => `• ${String(x)}`).join("\n");
  }
  return String(value);
}

function applyCustomFields(targetFields, input = {}) {
  const pdeEpicField = getOptionalEnv("JIRA_FIELD_PDE_EPIC_ID");
  const pdeStoryField = getOptionalEnv("JIRA_FIELD_PDE_STORY_ID");
  const acField = getOptionalEnv("JIRA_FIELD_ACCEPTANCE_CRITERIA");

  if (pdeEpicField && input.PDEEpicID) {
    targetFields[pdeEpicField] = String(input.PDEEpicID);
  }

  if (pdeStoryField && input.PDEStoryID) {
    targetFields[pdeStoryField] = String(input.PDEStoryID);
  }

  if (acField && input.acceptanceCriteria) {
    targetFields[acField] = normalizeAcceptanceCriteria(input.acceptanceCriteria);
  }

  return targetFields;
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

function mergeExtraFields(baseFields, extraFields) {
  if (!extraFields || typeof extraFields !== "object") return baseFields;

  const protectedKeys = new Set([
    "project",
    "summary",
    "issuetype",
    "description",
    "parent",
    "reporter",
  ]);

  for (const [k, v] of Object.entries(extraFields)) {
    if (protectedKeys.has(k)) continue;
    baseFields[k] = v;
  }
  return baseFields;
}

async function createEpic(jira, myAccountId, input, { dryRun = false } = {}) {
  const epicTitle = input?.title || "Orky - Epic";
  const epicDescription = input?.description || "Created by Orky API.";
  const extraFields = input?.fields;

  const epicMeta = await getCreateMetaFields(jira, jira.projectKey, "Epic");

  const epicFields = {
    project: { key: jira.projectKey },
    summary: epicTitle,
    issuetype: { name: "Epic" },
    description: adf(epicDescription),
  };

  const epicNameFieldId = findEpicNameFieldId(epicMeta);
  if (epicNameFieldId && epicMeta[epicNameFieldId]?.required) {
    epicFields[epicNameFieldId] = epicTitle;
  }

  if (epicMeta["reporter"]?.required) {
    epicFields.reporter = { accountId: myAccountId };
  }

  mergeExtraFields(epicFields, extraFields);
  applyCustomFields(epicFields, input);

  const epicMissing = missingRequired(epicMeta, epicFields);
  if (epicMissing.length > 0) {
    const e = new Error("Jira reports additional required fields for Epic.");
    e.statusCode = 400;
    e.details = { missingRequired: epicMissing };
    throw e;
  }

  if (dryRun) {
    return { dryRun: true, fields: epicFields };
  }

  return jiraFetch(jira, "/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify({ fields: epicFields }),
  });
}

async function createStoryUnderEpic(jira, myAccountId, epicKey, input, { dryRun = false } = {}) {
  if (!dryRun) {
    await jiraFetch(
      jira,
      `/rest/api/3/issue/${encodeURIComponent(epicKey)}?fields=key,issuetype`,
      { method: "GET" }
    );
  }

  const storyTitle = input?.title || `Story under ${epicKey}`;
  const storyDescription = input?.description || `Created by Orky API under Epic ${epicKey}.`;
  const extraFields = input?.fields;

  const storyMeta = await getCreateMetaFields(jira, jira.projectKey, "Story");

  const storyFields = {
    project: { key: jira.projectKey },
    summary: storyTitle,
    issuetype: { name: "Story" },
    description: adf(storyDescription),
    parent: { key: epicKey },
  };

  if (storyMeta["reporter"]?.required) {
    storyFields.reporter = { accountId: myAccountId };
  }

  mergeExtraFields(storyFields, extraFields);
  applyCustomFields(storyFields, input);

  const missing = missingRequired(storyMeta, storyFields);
  if (missing.length > 0) {
    const e = new Error("Jira reports additional required fields for Story.");
    e.statusCode = 400;
    e.details = { missingRequired: missing };
    throw e;
  }

  if (dryRun) {
    return { dryRun: true, fields: storyFields };
  }

  return jiraFetch(jira, "/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify({ fields: storyFields }),
  });
}

export default async function handler(req, res) {
  try {
    const hasXOrky = !!req.headers["x-orky-key"];
    const hasAuth = !!req.headers["authorization"];
    const provided = getProvidedOrkyKey(req);
    console.log("[intake] hit", {
      method: req.method,
      url: req.url,
      contentType: req.headers["content-type"],
      hasXOrky,
      hasAuth,
      providedKeyLen: provided ? String(provided).length : 0,
      bodyType: typeof req.body,
      hasEpicsArray: Array.isArray(req.body?.epics),
      hasEpicKey: !!req.body?.epicKey,
      hasTitle: !!req.body?.title,
      hasPDEEpicID: !!req.body?.PDEEpicID,
      hasPDEStoryID: !!req.body?.PDEStoryID,
    });
  } catch (e) {
    console.log("[intake] hit-log-failed", e?.message || e);
  }

  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Use POST" });
    }

    assertOrkyAuth(req);

    const jira = {
      baseUrl: mustEnv("JIRA_BASE_URL"),
      email: mustEnv("JIRA_EMAIL"),
      apiToken: mustEnv("JIRA_API_TOKEN"),
      projectKey: mustEnv("JIRA_PROJECT_KEY"),
    };

    const myAccountId = await getMyAccountId(jira);

    // MODE C: Batch merged payload
    if (Array.isArray(req.body?.epics)) {
      const dryRun = !!req.body?.options?.dryRun;

      const report = {
        ok: true,
        mode: "batch",
        dryRun,
        totals: {
          epicsRequested: req.body.epics.length,
          epicsCreated: 0,
          epicsFailed: 0,
          storiesRequested: 0,
          storiesCreated: 0,
          storiesFailed: 0,
        },
        epics: [],
      };

      for (let i = 0; i < req.body.epics.length; i++) {
        const epicIn = req.body.epics[i] || {};
        const epicItem = {
          index: i,
          PDEEpicID: epicIn.PDEEpicID || null,
          title: epicIn.title || null,
          epic: null,
          epicError: null,
          stories: [],
        };

        const storiesIn = Array.isArray(epicIn.stories) ? epicIn.stories : [];
        report.totals.storiesRequested += storiesIn.length;

        let epicKey = null;
        try {
          const createdEpic = await createEpic(jira, myAccountId, epicIn, { dryRun });
          epicItem.epic = createdEpic;
          epicKey = createdEpic?.key || null;
          report.totals.epicsCreated += 1;
        } catch (e) {
          report.totals.epicsFailed += 1;
          epicItem.epicError = {
            message: e?.message || "Epic create failed",
            statusCode: e?.statusCode || 500,
            details: e?.details || null,
          };
        }

        for (let j = 0; j < storiesIn.length; j++) {
          const storyIn = storiesIn[j] || {};
          const storyItem = {
            index: j,
            PDEStoryID: storyIn.PDEStoryID || null,
            PDEEpicID: storyIn.PDEEpicID || null,
            title: storyIn.title || null,
            story: null,
            storyError: null,
          };

          if (!epicKey && !dryRun) {
            report.totals.storiesFailed += 1;
            storyItem.storyError = {
              message: "Skipped because Epic was not created.",
              statusCode: 424,
              details: null,
            };
            epicItem.stories.push(storyItem);
            continue;
          }

          try {
            const keyToUse = dryRun ? "DRYRUN-EPIC" : epicKey;
            const createdStory = await createStoryUnderEpic(
              jira,
              myAccountId,
              keyToUse,
              storyIn,
              { dryRun }
            );
            storyItem.story = createdStory;
            report.totals.storiesCreated += 1;
          } catch (e) {
            report.totals.storiesFailed += 1;
            storyItem.storyError = {
              message: e?.message || "Story create failed",
              statusCode: e?.statusCode || 500,
              details: e?.details || null,
            };
          }

          epicItem.stories.push(storyItem);
        }

        report.epics.push(epicItem);
      }

      return res.status(200).json(report);
    }

    // MODE B: Single story under existing Epic Jira key
    if (req.body?.epicKey) {
      const created = await createStoryUnderEpic(jira, myAccountId, req.body.epicKey, req.body, {
        dryRun: false,
      });

      return res.status(200).json({
        ok: true,
        mode: "add-story",
        epicKey: req.body.epicKey,
        story: created,
      });
    }

    // MODE A: Single Epic create
    const createdEpic = await createEpic(jira, myAccountId, req.body || {}, { dryRun: false });

    return res.status(200).json({
      ok: true,
      mode: "create-epic",
      epic: createdEpic,
    });
  } catch (e) {
    const status = e?.statusCode || 500;
    console.error("[intake] error:", e?.message, e?.details || e);
    return res.status(status).json({
      ok: false,
      error: e?.message || "Unknown error",
      jiraDetails: e?.details || null,
    });
  }
}
