// api/intake.js
import { GoogleGenAI } from "@google/genai";
import { google } from 'googleapis';
import axios from 'axios';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { fileId, projectKey } = req.body;
  const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-3-pro" });

  try {
    // 1. READ GOOGLE DOC
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/documents.readonly'],
    });
    const docs = google.docs({ version: 'v1', auth });
    const doc = await docs.documents.get({ documentId: fileId });
    const fullText = doc.data.body.content.map(c => c.paragraph?.elements?.map(e => e.textRun?.content).join('')).join('');

    // 2. TRANSFORM WITH GEMINI
    const prompt = `Analyze this PDD: "${fullText}". 
    Extract a JSON list of Epics and their child Stories. 
    Format: [{"type": "Epic", "summary": "...", "stories": [{"summary": "...", "description": "..."}]}]`;
    
    const result = await model.generateContent(prompt);
    const workItems = JSON.parse(result.response.text());

    // 3. ENTER INTO JIRA
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
            description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: story.description }] }] },
            issuetype: { name: 'Story' },
            parent: { key: epicKey } // Links Story to Epic
          }
        }, { headers: { 'Authorization': `Basic ${jiraAuth}` } });
      }
    }

    return res.status(200).json({ status: "Success", message: "Jira Space populated." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
