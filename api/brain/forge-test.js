export default async function handler(req, res) {
  // A tiny HTML page that lets you test /api/brain/forge from the browser.
  // It does NOT expose secrets unless you type them in.
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Forge Brain Test</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:20px;max-width:900px}
    textarea,input{width:100%;padding:10px;margin:8px 0;font-family:ui-monospace,Menlo,Consolas,monospace}
    button{padding:10px 14px;font-size:16px}
    pre{white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:8px}
    .row{display:grid;grid-template-columns:1fr;gap:10px}
  </style>
</head>
<body>
  <h2>/api/brain/forge — Browser Test</h2>
  <p>Enter your <code>ORKY_API_KEY</code> (sent as <code>x-orky-key</code>) and a JSON body, then click Run.</p>

  <label>ORKY_API_KEY</label>
  <input id="key" type="password" placeholder="paste ORKY_API_KEY here" />

  <label>Request Body (JSON)</label>
  <textarea id="body" rows="10">{
  "instruction": "Create a GitHub PR proposal that adds a file orky_test/hello.txt with content 'Hello from Forge.\\n' to repo orky-service.",
  "repo": "orky-service",
  "contextSources": []
}</textarea>

  <button id="run">Run</button>

  <h3>Response</h3>
  <pre id="out">(none)</pre>

<script>
document.getElementById('run').addEventListener('click', async () => {
  const key = document.getElementById('key').value.trim();
  const out = document.getElementById('out');
  out.textContent = "Calling /api/brain/forge ...";

  let payload;
  try {
    payload = JSON.parse(document.getElementById('body').value);
  } catch (e) {
    out.textContent = "Invalid JSON body: " + e.message;
    return;
  }

  try {
    const r = await fetch('/api/brain/forge', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-orky-key': key
      },
      body: JSON.stringify(payload)
    });
    const text = await r.text();
    out.textContent = "HTTP " + r.status + "\\n\\n" + text;
  } catch (e) {
    out.textContent = "Request failed: " + e.message;
  }
});
</script>
</body>
</html>`);
}
