// api/debug-jira-auth.js
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function authHeader(email, token) {
  const basic = Buffer.from(`${email}:${token}`).toString("base64");
  return `Basic ${basic}`;
}

async function jiraFetchRaw(baseUrl, email, token, path) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: {
      Authorization: authHeader(email, token),
      Accept: "application/json",
    },
  });

  const text = await res.text();
  return {
    status: res.status,
    ok: res.ok,
    body: text,
  };
}

export default async function handler(req, res) {
  try {
    const baseUrl = mustEnv("JIRA_BASE_URL");
    const email = mustEnv("JIRA_EMAIL");
    const token = mustEnv("JIRA_API_TOKEN");
    const projectKey = mustEnv("JIRA_PROJECT_KEY");

    const myself = await jiraFetchRaw(baseUrl, email, token, "/rest/api/3/myself");
    const project = await jiraFetchRaw(
      baseUrl,
      email,
      token,
      `/rest/api/3/project/${encodeURIComponent(projectKey)}`
    );

    return res.status(200).json({
      envSeenByRuntime: {
        baseUrl,
        email,
        projectKey,
        tokenLength: token.length,
        tokenLast6: token.slice(-6),
      },
      myself,
      project,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message || "Unknown error",
    });
  }
}
