require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const cheerio = require('cheerio');
const MongoMCPClient = require('./mcp');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// --- DB + Gemini + MCP setup ---
const mongoClient = new MongoClient(process.env.MONGODB_URI);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const mcpClient = new MongoMCPClient(process.env.MONGODB_URI);

let db;

async function initServices() {
  await mongoClient.connect();
  db = mongoClient.db('joblens');
  console.log('✅ MongoDB driver connected');

  try {
    await mcpClient.connect();
    console.log('✅ MongoDB MCP Server connected');
  } catch (err) {
    console.log('⚠️ MCP Server failed to start — using driver fallback:', err.message);
  }
}

initServices();

// --- Helper: save with MCP primary, driver fallback ---
async function saveToMongo(record) {
  const mcpResult = await mcpClient.saveInvestigation(record);
  if (mcpResult !== null) {
    return 'mcp';
  }
  await db.collection('investigations').insertOne(record);
  console.log('💾 [Driver] Saved investigation to MongoDB');
  return 'driver';
}

// --- Helper: fetch history with MCP primary, driver fallback ---
async function getHistory() {
  const mcpHistory = await mcpClient.getHistory(20);
  if (mcpHistory !== null) return mcpHistory;
  return db.collection('investigations')
    .find({}).sort({ investigatedAt: -1 }).limit(20).toArray();
}

// --- Helper: fetch stats with MCP primary, driver fallback ---
async function getStats() {
  const mcpStats = await mcpClient.getStats();
  if (mcpStats !== null) return mcpStats;
  const total = await db.collection('investigations').countDocuments();
  const apply = await db.collection('investigations').countDocuments({ verdict: 'APPLY' });
  const ghost = await db.collection('investigations').countDocuments({ verdict: 'GHOST' });
  const caution = await db.collection('investigations').countDocuments({ verdict: 'CAUTION' });
  return { total, apply, caution, ghost };
}

// --- URL Normalization ---
function normalizeUrl(url) {
  if (!url) return url;

  if (url.includes('indeed.com') && url.includes('vjk=')) {
    const vjkMatch = url.match(/vjk=([a-zA-Z0-9]+)/);
    if (vjkMatch) {
      const normalized = `https://ca.indeed.com/viewjob?jk=${vjkMatch[1]}`;
      console.log('🔄 Indeed URL normalized:', normalized);
      return normalized;
    }
  }

  if (url.includes('indeed.com/viewjob')) {
    const jkMatch = url.match(/jk=([a-zA-Z0-9]+)/);
    if (jkMatch) {
      const normalized = `https://ca.indeed.com/viewjob?jk=${jkMatch[1]}`;
      console.log('🔄 Indeed URL cleaned:', normalized);
      return normalized;
    }
  }

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
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      },
      timeout: 15000,
      maxRedirects: 5
    });

    const $ = cheerio.load(data);
    let scrapedText = null;

    // 1. The "Silver Bullet": Extract hidden SEO JobPosting metadata (JSON-LD)
    let jsonLdText = '';
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const parsed = JSON.parse($(el).html());
        const schemas = Array.isArray(parsed) ? parsed : [parsed];
        for (const schema of schemas) {
          if (schema['@type'] === 'JobPosting') {
            jsonLdText += `${schema.title}\n${schema.description || ''}\n${schema.responsibilities || ''}\n${schema.qualifications || ''}`;
          }
        }
      } catch (e) {
        // Ignore parse errors on irrelevant JSON-LD blocks
      }
    });

    if (jsonLdText.trim().length > 100) {
      scrapedText = jsonLdText.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
      console.log('✅ Scraped via JSON-LD JobPosting schema');
    } else {
      // 2. Fallback: Target standard job description containers
      $('script, style, noscript, nav, footer, header, iframe').remove();
      const targetedContent = $('main, #main, #content, .job-description, .posting-requirements, [data-ui="job-description"]').text();
      
      if (targetedContent.trim().length > 100) {
        scrapedText = targetedContent.replace(/\s+/g, ' ').trim();
        console.log('✅ Scraped via targeted HTML container');
      } else {
        // 3. Ultimate Fallback: Scrape the entire body
        scrapedText = $('body').text().replace(/\s+/g, ' ').trim();
        console.log('✅ Scraped via full body fallback');
      }
    }

    if (!scrapedText || scrapedText.length < 200) {
      console.log('⚠️ Very little content scraped — site may be blocking');
      return null;
    }

    scrapedText = scrapedText.substring(0, 4000); // Keep payload manageable for Gemini
    console.log(`✅ Final Scraped length: ${scrapedText.length} characters`);
    return scrapedText;

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
    // Check cache — MCP first, driver fallback
    let existing = await mcpClient.findInvestigation(effectiveUrl);
    if (!existing) {
      existing = await db.collection('investigations').findOne({ url: effectiveUrl });
    }
    if (existing) {
      console.log('📦 Returning cached investigation from MongoDB');
      return res.json({ ...existing, cached: true });
    }

    // Determine content source
    let pageContent = null;
    let contentSource = '';
    const isManualEntry = effectiveUrl.startsWith('manual-entry-');

    if (isManualEntry && pastedText && pastedText.trim().length > 100) {
      pageContent = pastedText.trim();
      contentSource = 'pasted';
      console.log('📋 Using pasted job description');
    } else if (!isManualEntry && pastedText && pastedText.trim().length > 100) {
      console.log('🔍 Scraping URL first, pasted text as fallback...');
      pageContent = await scrapeJobPosting(effectiveUrl);
      contentSource = 'scraped';
      if (!pageContent) {
        pageContent = pastedText.trim();
        contentSource = 'pasted-fallback';
        console.log('📋 Scrape failed — using pasted text');
      }
    } else {
      pageContent = await scrapeJobPosting(effectiveUrl);
      contentSource = 'scraped';
    }

    // No content — return UNSCRAPABLE
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
        verdictReason: 'This site blocks automated scraping. Common with Oracle HCM, Workday, Greenhouse, Taleo, and ATS portals.',
        score: 0,
        companyHealthSummary: 'Cannot determine without job content.',
        recommendation: 'Copy and paste the full job description into the text box below the URL field, then click Investigate again.',
        investigatedAt: new Date(),
        cached: false,
        contentSource: 'none'
      };
      await saveToMongo(record);
      return res.json(record);
    }

    // Send to Gemini
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
- Direct company careers portal (Oracle HCM, Workday, Greenhouse) = GREEN flag
- Smart-apply URLs with 200+ applicants = RED flag
- Evergreen postings = GHOST
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
        company: 'Unknown', role: 'Unknown', location: 'Unknown',
        postedDate: 'Unknown', applicantSignals: 'Unknown',
        verdict: 'CAUTION',
        verdictReason: 'Could not fully parse job posting. Review manually.',
        score: 50, redFlags: ['Could not parse response'], greenFlags: [],
        companyHealthSummary: 'Unknown',
        recommendation: 'Review the job posting manually.'
      };
    }

    const record = {
      url: effectiveUrl,
      ...investigation,
      investigatedAt: new Date(),
      cached: false,
      contentSource
    };

    await saveToMongo(record);
    res.json(record);

  } catch (err) {
    console.error('Investigation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- History endpoint ---
app.get('/api/history', async (req, res) => {
  try {
    res.json(await getHistory());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Stats endpoint ---
app.get('/api/stats', async (req, res) => {
  try {
    res.json(await getStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Search endpoint ---
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
      .find(filter).sort({ investigatedAt: -1 }).limit(20).toArray();
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