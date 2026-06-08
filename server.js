require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const MongoMCPClient = require('./mcp');

// Import Stealth Browser
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

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

  // Reverting to standard Indeed URLs since the Stealth browser handles them perfectly
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

// --- Scrape job posting (Nuclear Stealth Option) ---
async function scrapeJobPosting(url) {
  let browser = null;
  try {
    console.log(`🕵️ Launching stealth browser for: ${url}`);
    
    // Launch headless Chromium with bot-evasion flags
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage'
      ]
    });

    const page = await browser.newPage();

    // Set standard Windows user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // Optimize speed: Block images, CSS, and media to save bandwidth
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Wait until network is mostly idle (Critical for rendering Workday/SPA sites)
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    // Execute scraping logic natively inside the browser context
    const result = await page.evaluate(() => {
      // 1. Look for hidden JSON-LD Job Metadata (Best for Indeed)
      let jsonLdText = '';
      document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
        try {
          const parsed = JSON.parse(el.innerText);
          const schemas = Array.isArray(parsed) ? parsed : [parsed];
          schemas.forEach(schema => {
            if (schema['@type'] === 'JobPosting') {
              jsonLdText += `${schema.title}\n${schema.description || ''}\n${schema.responsibilities || ''}\n${schema.qualifications || ''}`;
            }
          });
        } catch(e) {}
      });

      if (jsonLdText.trim().length > 100) {
        return {
          method: 'JSON-LD',
          text: jsonLdText.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim()
        };
      }

      // 2. Clean the DOM of junk tags
      document.querySelectorAll('script, style, noscript, nav, footer, header, iframe').forEach(el => el.remove());

      // 3. Target specific ATS containers (Workday, Greenhouse, etc)
      const targeted = document.querySelector('main, #main, #content, .job-description, [data-ui="job-description"], #jobDescriptionText, [data-automation-id="jobPostingDescription"]');
      if (targeted && targeted.innerText.trim().length > 100) {
        return {
          method: 'HTML Container',
          text: targeted.innerText.trim().replace(/\s+/g, ' ')
        };
      }

      // 4. Ultimate Fallback
      return {
        method: 'Body Text',
        text: document.body.innerText.trim().replace(/\s+/g, ' ')
      };
    });

    const scrapedText = result.text.substring(0, 4000);

    // Fail-safe: Detect if DataDome managed to serve a Captcha instead of the job
    const lowerText = scrapedText.toLowerCase();
    if (lowerText.includes('verify you are human') || lowerText.includes('cloudflare') || lowerText.includes('datadome') || scrapedText.length < 150) {
      console.log('⚠️ Captcha or Block detected.');
      return null;
    }

    console.log(`✅ Scraped via ${result.method}. Length: ${scrapedText.length} chars`);
    return scrapedText;

  } catch (err) {
    console.log(`❌ Scrape failed for ${url}:`, err.message);
    return null;
  } finally {
    // ALWAYS clean up the browser to prevent memory leaks
    if (browser) {
      await browser.close();
      console.log('🧹 Stealth browser closed.');
    }
  }
}

// --- INTERNAL TOOL: Scraper for Vertex Agent ---
app.post('/api/internal/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  
  console.log('🤖 Vertex Agent requested a scrape for:', url);
  const text = await scrapeJobPosting(url);
  
  if (!text) return res.json({ success: false, text: "Site blocked scraping." });
  res.json({ success: true, text: text });
});

// --- INTERNAL TOOL: Save to DB for Vertex Agent ---
app.post('/api/internal/save', async (req, res) => {
  const record = req.body;
  console.log('🤖 Vertex Agent requested to save record:', record.company);
  
  // Use your existing MCP saving logic
  await saveToMongo(record);
  res.json({ success: true, message: "Saved to MongoDB via MCP" });
});

// --- Main investigation endpoint ---
app.post('/api/investigate', async (req, res) => {
  const { url, pastedText } = req.body;

  if (!url && !pastedText) {
    return res.status(400).json({ error: 'URL or job description required' });
  }

  const effectiveUrl = url ? normalizeUrl(url) : 'manual-entry-' + Date.now();

  try {
    // Check cache
    let existing = await mcpClient.findInvestigation(effectiveUrl);
    if (!existing) {
      existing = await db.collection('investigations').findOne({ url: effectiveUrl });
    }
    if (existing) {
      console.log('📦 Returning cached investigation from MongoDB');
      return res.json({ ...existing, cached: true });
    }

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

    if (!pageContent) {
      const record = {
        url: effectiveUrl, company: 'Could not detect', role: 'Could not detect',
        location: 'Unknown', postedDate: 'Unknown', applicantSignals: 'None detected',
        redFlags: ['Site blocks automated scraping'], greenFlags: [],
        verdict: 'UNSCRAPABLE',
        verdictReason: 'This site blocks automated scraping. Common with highly secure portals.',
        score: 0, companyHealthSummary: 'Cannot determine without job content.',
        recommendation: 'Copy and paste the full job description into the text box below the URL field, then click Investigate again.',
        investigatedAt: new Date(), cached: false, contentSource: 'none'
      };
      await saveToMongo(record);
      return res.json(record);
    }

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
        postedDate: 'Unknown', applicantSignals: 'Unknown', verdict: 'CAUTION',
        verdictReason: 'Could not fully parse job posting. Review manually.',
        score: 50, redFlags: ['Could not parse response'], greenFlags: [],
        companyHealthSummary: 'Unknown', recommendation: 'Review the job posting manually.'
      };
    }

    const record = {
      url: effectiveUrl, ...investigation,
      investigatedAt: new Date(), cached: false, contentSource
    };

    await saveToMongo(record);
    res.json(record);

  } catch (err) {
    console.error('Investigation error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history', async (req, res) => {
  try { res.json(await getHistory()); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats', async (req, res) => {
  try { res.json(await getStats()); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', (err) => {
  if (err) {
    console.error('❌ Server failed to start:', err);
    process.exit(1);
  }
  console.log(`🚀 JobLens running on http://127.0.0.1:${PORT}`);
});