require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- DB + Gemini setup ---
const mongoClient = new MongoClient(process.env.MONGODB_URI);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

let db;
mongoClient.connect().then(() => {
  db = mongoClient.db('joblens');
  console.log('✅ MongoDB connected');
});

// --- Scrape job posting ---
async function scrapeJobPosting(url) {
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    });
    const $ = cheerio.load(data);
    $('script, style, nav, footer, header').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 4000);
    return text;
  } catch (err) {
    return `Could not scrape page: ${err.message}`;
  }
}

// --- Main investigation endpoint ---
app.post('/api/investigate', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    // Check if we've seen this URL before (MongoDB MCP pattern)
    const existing = await db.collection('investigations').findOne({ url });
    if (existing) {
      console.log('📦 Returning cached investigation from MongoDB');
      return res.json({ ...existing, cached: true });
    }

    // Scrape the job posting
    console.log('🔍 Scraping job posting...');
    const pageContent = await scrapeJobPosting(url);

    // Send to Gemini for investigation
    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

    const prompt = `
You are JobLens, an AI agent that investigates job postings to determine if they are worth applying to.

Analyze this job posting content and URL carefully:
URL: ${url}
Content: ${pageContent}

Investigate and return a JSON object with these exact fields:
{
  "company": "company name",
  "role": "job title",
  "location": "location or remote",
  "postedDate": "date posted or 'Unknown'",
  "applicantSignals": "any signals about number of applicants",
  "redFlags": ["list", "of", "red", "flags"],
  "greenFlags": ["list", "of", "green", "flags"],
  "verdict": "APPLY" or "CAUTION" or "GHOST",
  "verdictReason": "2-3 sentence explanation of your verdict",
  "score": number from 1-100,
  "companyHealthSummary": "brief summary of company stability based on what you can infer",
  "recommendation": "specific actionable advice for this application"
}

Verdict guide:
- APPLY: Fresh posting, reasonable competition, stable company signals
- CAUTION: Some red flags but not disqualifying  
- GHOST: Old posting, reposted multiple times, company issues, or likely already filled

Return ONLY the JSON object, no markdown, no explanation.
    `;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    let investigation;
    try {
      const cleaned = responseText.replace(/```json|```/g, '').trim();
      investigation = JSON.parse(cleaned);
    } catch {
      investigation = {
        company: 'Unknown',
        role: 'Unknown',
        verdict: 'CAUTION',
        verdictReason: 'Could not fully parse job posting.',
        score: 50,
        redFlags: [],
        greenFlags: [],
        recommendation: 'Review manually.'
      };
    }

    // Save to MongoDB (this is the meaningful MCP integration)
    const record = {
      url,
      ...investigation,
      investigatedAt: new Date(),
      cached: false
    };

    await db.collection('investigations').insertOne(record);
    console.log('💾 Saved investigation to MongoDB');

    res.json(record);

  } catch (err) {
    console.error('Investigation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- History endpoint (shows MongoDB value) ---
app.get('/api/history', async (req, res) => {
  try {
    const history = await db.collection('investigations')
      .find({})
      .sort({ investigatedAt: -1 })
      .limit(20)
      .toArray();
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Stats endpoint ---
app.get('/api/stats', async (req, res) => {
  try {
    const total = await db.collection('investigations').countDocuments();
    const apply = await db.collection('investigations').countDocuments({ verdict: 'APPLY' });
    const ghost = await db.collection('investigations').countDocuments({ verdict: 'GHOST' });
    const caution = await db.collection('investigations').countDocuments({ verdict: 'CAUTION' });
    res.json({ total, apply, ghost, caution });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', (err) => {
  if (err) {
    console.error('❌ Server failed to start:', err);
    process.exit(1);
  }
  console.log(`🚀 JobLens running on http://127.0.0.1:${PORT}`);
});