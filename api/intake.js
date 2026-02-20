// api/intake.js
import { GoogleGenAI } from "@google/genai";
import { google } from 'googleapis';
import axios from 'axios';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { fileId, projectKey } = req.body;

  try {
    // 1. INITIALIZE GEMINI (Fixed the TypeError: genAI.getGenerativeModel is not a function)
    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
    // Using gemini-1.5-flash for speed and stability during the current "Pro" outage
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // 2. READ GOOGLE DOC
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/documents.readonly'],
    });
    const docs = google.docs({ version: 'v1', auth });
    const doc = await docs.documents.get({ documentId: fileId });
    const fullText = doc.data.body.content.map(c => c.paragraph?.elements?.map(e => e.textRun?.content).join('')).join('');

    // 3. TRANSFORM WITH GEMINI
    const prompt = `Analyze this PDD: "${fullText}". 
    Extract a JSON list of Epics and their child Stories. 
    Format: [{"type": "Epic", "summary": "...", "stories": [{"summary": "...", "description": "..."}]}]
    Output ONLY valid JSON. No markdown backticks.`;
    
    const result = await model.generateContent(prompt);
    let resultText = result.response.text();

    // Cleaning step: Remove markdown code blocks if Gemini includes them
    const jsonMatch = resultText.match(/```json\n([\s\S]*?)\n```/) || resultText.match(/```\n([\s\S]*?)\n```/);
    const cleanedJson = jsonMatch ? jsonMatch[1] : resultText;
    const workItems = JSON.parse(cleanedJson);

    // 4. ENTER INTO JIRA
    const jiraAuth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
    
    for (const epic of workItems) {
      // Create Epic
      const epicResponse = await axios.post(`https://${process.env.JIRA_DOMAIN}.atlassian.net/rest/api/3/issue`, {
        fields: {
          project: { key: projectKey },
          summary: epic.summary,
          issuetype: { name: 'Epic' }
        }
      }, { headers: { 'Authorization': `Basic ${jiraAuth}` } });

      const epicKey = epicResponse.data.key;

      // Create Child Stories linked to Epic
      for (const story of epic.stories) {
        await axios.post(`https://${process.env.JIRA_DOMAIN}.atlassian.net/rest/api/3/issue`, {
          fields: {
            project: { key: projectKey },
            summary: story.summary,
            description: { 
              type: "doc", 
              version: 1, 
              content: [{ 
                type: "paragraph", 
                content: [{ type: "text", text: story.description }] 
              }] 
            },
            issuetype: { name: 'Story' },
            parent: { key: epicKey } // Modern Jira API links Story to Epic via 'parent'
          }
        }, { headers: { 'Authorization': `Basic ${jiraAuth}` } });
      }
    }

    return res.status(200).json({ status: "Success", message: "Jira Space populated." });
  } catch (error) {
    console.error("Orky Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
}
