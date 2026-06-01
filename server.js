require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// --- DB + Gemini setup ---
const mongoClient = new MongoClient(process.env.MONGODB_URI);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

let db;
mongoClient.connect().then(() => {
  db = mongoClient.db('joblens');
  console.log('✅ MongoDB connected');
});

// --- URL Normalization ---
function normalizeUrl(url) {
  if (!url) return url;

  // Indeed: smart-apply or vjk= param
  if (url.includes('indeed.com') && url.includes('vjk=')) {
    const vjkMatch = url.match(/vjk=([a-zA-Z0-9]+)/);
    if (vjkMatch) {
      const normalized = `https://ca.indeed.com/viewjob?jk=${vjkMatch[1]}`;
      console.log('🔄 Indeed URL normalized:', normalized);
      return normalized;
    }
  }

  // Indeed: viewjob with extra params - strip to just jk
  if (url.includes('indeed.com/viewjob')) {
    const jkMatch = url.match(/jk=([a-zA-Z0-9]+)/);
    if (jkMatch) {
      const normalized = `https://ca.indeed.com/viewjob?jk=${jkMatch[1]}`;
      console.log('🔄 Indeed URL cleaned:', normalized);
      return normalized;
    }
  }

  // LinkedIn: any format with a job ID
  if (url.includes('linkedin.com')) {
    const collectionMatch = url.match(/currentJobId=(\d+)/);
    const viewMatch = url.match(/\/jobs\/view\/(\d+)/);
    const genericMatch = url.match(/(\d{8,})/);
    const jobId = (collectionMatch || viewMatch || genericMatch || [])[1];
    if (jobId) {
      const normalized = `https://www.linkedin.com/jobs/view/${jobId}`;
      console.log('🔄 LinkedIn URL normalized:', normalized);
      return normalized;
    }
  }

  return url;
}

// --- Scrape job posting ---
async function scrapeJobPosting(url) {
  try {
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
      timeout: 15000,
      maxRedirects: 5
    });

    const $ = cheerio.load(data);
    $('script, style, nav, footer, header, iframe, noscript').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 4000);

    if (text.length < 200) {
      console.log('⚠️ Very little content scraped — site may be blocking');
      return null;
    }

    console.log(`✅ Scraped ${text.length} characters`);
    return text;

  } catch (err) {
    console.log('❌ Scrape failed:', err.message);
    return null;
  }
}

// --- Main investigation endpoint ---
app.post('/api/investigate', async (req, res) => {
  const { url, pastedText } = req.body;

  if (!url && !pastedText) {
    return res.status(400).json({ error: 'URL or job description required' });
  }

  const effectiveUrl = url ? normalizeUrl(url) : 'manual-entry-' + Date.now();

  try {
    // Check MongoDB cache first
    const existing = await db.collection('investigations').findOne({ url: effectiveUrl });
    if (existing) {
      console.log('📦 Returning cached investigation from MongoDB');
      return res.json({ ...existing, cached: true });
    }

    // Determine content source
    let pageContent = null;
    let contentSource = '';

    if (pastedText && pastedText.trim().length > 100) {
      // User pasted job description directly
      pageContent = pastedText.trim();
      contentSource = 'pasted';
      console.log('📋 Using pasted job description');
    } else {
      // Try scraping the URL
      pageContent = await scrapeJobPosting(effectiveUrl);
      contentSource = 'scraped';
    }

    // If no usable content — return helpful UNSCRAPABLE response
    if (!pageContent) {
      const record = {
        url: effectiveUrl,
        company: 'Could not detect',
        role: 'Could not detect',
        location: 'Unknown',
        postedDate: 'Unknown',
        applicantSignals: 'None detected',
        redFlags: ['Site blocks automated scraping'],
        greenFlags: [],
        verdict: 'UNSCRAPABLE',
        verdictReason: 'This site blocks automated scraping. Common with Oracle HCM, Workday, Greenhouse, Taleo, and ATS portals. The agent needs the job content to investigate.',
        score: 0,
        companyHealthSummary: 'Cannot determine without job content.',
        recommendation: 'Copy and paste the full job description into the text box below the URL field, then click Investigate again.',
        investigatedAt: new Date(),
        cached: false,
        contentSource: 'none'
      };
      await db.collection('investigations').insertOne(record);
      return res.json(record);
    }

    // Send to Gemini for investigation
    console.log('🧠 Sending to Gemini for investigation...');
    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

    const prompt = `
You are JobLens, an AI agent that investigates job postings to determine if they are worth applying to.

Analyze this job posting carefully:
URL: ${effectiveUrl}
Content Source: ${contentSource}
Content: ${pageContent}

Investigate and return a JSON object with these exact fields:
{
  "company": "company name",
  "role": "job title",
  "location": "location or remote",
  "postedDate": "date posted or 'Unknown'",
  "applicantSignals": "any signals about number of applicants or competition level",
  "redFlags": ["list", "of", "red", "flags"],
  "greenFlags": ["list", "of", "green", "flags"],
  "verdict": "APPLY" or "CAUTION" or "GHOST",
  "verdictReason": "2-3 sentence explanation of your verdict",
  "score": number from 1-100,
  "companyHealthSummary": "brief summary of company stability based on what you can infer",
  "recommendation": "specific actionable advice for this application"
}

Verdict guide:
- APPLY: Fresh posting, reasonable competition, stable company, direct portal, clear role
- CAUTION: Some red flags but role is legitimate — high competition, vague details, or minor company concerns
- GHOST: Old posting, evergreen/always-open role, company layoffs/instability, likely already filled internally, or smart-apply black hole

Important rules:
- If content is from a direct company careers portal (Oracle HCM, Workday, Greenhouse) that is a GREEN flag
- Smart-apply URLs from Indeed or LinkedIn with 200+ applicants are RED flags
- Evergreen postings (always open, collect resumes) should be GHOST
- Be specific — use actual company names, role titles, and signals from the content

Return ONLY the JSON object, no markdown, no explanation.
    `;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    let investigation;
    try {
      const cleaned = responseText.replace(/```json|```/g, '').trim();
      investigation = JSON.parse(cleaned);
    } catch {
      console.log('⚠️ JSON parse failed, using fallback');
      investigation = {
        company: 'Unknown',
        role: 'Unknown',
        location: 'Unknown',
        postedDate: 'Unknown',
        applicantSignals: 'Unknown',
        verdict: 'CAUTION',
        verdictReason: 'Could not fully parse job posting. Review manually.',
        score: 50,
        redFlags: ['Could not parse response'],
        greenFlags: [],
        companyHealthSummary: 'Unknown',
        recommendation: 'Review the job posting manually.'
      };
    }

    // Save to MongoDB
    const record = {
      url: effectiveUrl,
      ...investigation,
      investigatedAt: new Date(),
      cached: false,
      contentSource
    };

    await db.collection('investigations').insertOne(record);
    console.log('💾 Saved investigation to MongoDB');

    res.json(record);

  } catch (err) {
    console.error('Investigation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- History endpoint ---
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

// --- Search endpoint (MongoDB intelligence layer) ---
app.get('/api/search', async (req, res) => {
  try {
    const { verdict, company, q } = req.query;
    const filter = {};
    if (verdict) filter.verdict = verdict.toUpperCase();
    if (company) filter.company = { $regex: company, $options: 'i' };
    if (q) filter.$or = [
      { role: { $regex: q, $options: 'i' } },
      { company: { $regex: q, $options: 'i' } },
      { recommendation: { $regex: q, $options: 'i' } }
    ];

    const results = await db.collection('investigations')
      .find(filter)
      .sort({ investigatedAt: -1 })
      .limit(20)
      .toArray();

    res.json(results);
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