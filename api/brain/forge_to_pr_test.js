export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  res.status(200).send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Forge → PR Test</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui; margin: 20px; max-width: 900px; }
    textarea, input { width: 100%; padding: 10px; margin: 8px 0; }
    button { padding: 10px 14px; font-size: 16px; }
    pre { white-space: pre-wrap; background: #f4f4f4; padding: 12px; border-radius: 8px; }
  </style>
</head>
<body>

<h2>Forge → GitHub PR Test</h2>

<label>ORKY_API_KEY</label>
<input id="key" type="password" placeholder="Paste ORKY_API_KEY here" />

<label>Instruction</label>
<textarea id="instruction" rows="6">
Create a GitHub PR that adds a file orky_test/hello.txt with content "Hello from Forge.\\n" to repo orky-service.
</textarea>

<label>Repo</label>
<input id="repo" value="orky-service" />

<button id="run">Run Forge → PR</button>

<h3>Response</h3>
<pre id="output">(none)</pre>

<script>
document.getElementById("run").addEventListener("click", async () => {
  const key = document.getElementById("key").value.trim();
  const instruction = document.getElementById("instruction").value.trim();
  const repo = document.getElementById("repo").value.trim();
  const output = document.getElementById("output");

  output.textContent = "Running...";

  try {
    const response = await fetch("/api/brain/forge_to_pr", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-orky-key": key
      },
      body: JSON.stringify({
        instruction,
        repo,
        contextSources: []
      })
    });

    const text = await response.text();
    output.textContent = "HTTP " + response.status + "\\n\\n" + text;

  } catch (err) {
    output.textContent = "Error: " + err.message;
  }
});
</script>

</body>
</html>`);
}
