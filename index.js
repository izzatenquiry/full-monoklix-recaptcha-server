
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3001;

// ===============================
// ⚙️ CONFIG
// ===============================
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const VEO_API_BASE = 'https://aisandbox-pa.googleapis.com/v1';
const RECAPTCHA_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
const PROJECT_ID = 'gen-lang-client-0426593366';

// ===============================
// 🛠️ HELPERS
// ===============================
const log = (level, req, ...args) => {
  const timestamp = new Date().toISOString();
  const username = req?.headers?.['x-user-username'] || 'unknown';
  const prefix = `[${timestamp}] [${username}]`;
  if (level === 'error') console.error(prefix, ...args);
  else if (level === 'warn') console.warn(prefix, ...args);
  else console.log(prefix, ...args);
};

const getJson = async (response, req) => {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
};

async function validateRecaptchaToken(token, expectedAction) {
  if (!token || typeof token !== 'string') return { valid: false, reason: 'NO_TOKEN' };
  try {
    const assessmentUrl = `https://recaptchaenterprise.googleapis.com/v1/projects/${PROJECT_ID}/assessments?key=${GOOGLE_API_KEY}`;
    const response = await fetch(assessmentUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { token, expectedAction, siteKey: RECAPTCHA_SITE_KEY } })
    });
    if (!response.ok) return { valid: false, reason: 'GOOGLE_API_ERROR' };
    const data = await response.json();
    if (!data.tokenProperties || !data.tokenProperties.valid) return { valid: false, reason: 'INVALID_TOKEN' };
    return { valid: true, score: data.riskAnalysis?.score, action: data.tokenProperties.action };
  } catch (error) { return { valid: false, reason: 'EXCEPTION', error: error.message }; }
}

// ===============================
// 🧩 MIDDLEWARE
// ===============================
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));

// ===============================
// ========== VEO3 ENDPOINTS ==========
// ===============================

async function handleVeoGeneration(req, res, apiPath) {
  const authToken = req.headers.authorization?.replace('Bearer ', '');
  if (!authToken) return res.status(401).json({ error: 'Unauthorized: Missing User Token' });

  // AMBIL DARI HEADERS SEPERTI YANG DIMINTA
  const recaptchaToken = req.headers['x-recaptcha-token'];
  let requestBody = { ...req.body };

  if (recaptchaToken) {
    const validation = await validateRecaptchaToken(recaptchaToken, 'PINHOLE_GENERATE');
    if (validation.valid) {
      if (!requestBody.clientContext) requestBody.clientContext = {};
      requestBody.clientContext.recaptchaToken = recaptchaToken; // Google mahu dalam body clientContext
      log('log', req, '✅ reCAPTCHA injected into clientContext');
    } else {
      log('error', req, '❌ Blocked: Invalid reCAPTCHA token in headers');
      return res.status(403).json({ error: 'INVALID_RECAPTCHA' });
    }
  }

  const response = await fetch(`${VEO_API_BASE}/${apiPath}`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': GOOGLE_API_KEY,
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'Origin': 'https://labs.google',
      'Referer': 'https://labs.google/'
    },
    body: JSON.stringify(requestBody)
  });

  const data = await getJson(response, req);
  if (!response.ok) return res.status(response.status).json(data);
  res.json(data);
}

app.post('/api/veo/generate-t2v', (req, res) => handleVeoGeneration(req, res, 'video:batchAsyncGenerateVideoText'));
app.post('/api/veo/generate-i2v', (req, res) => handleVeoGeneration(req, res, 'video:batchAsyncGenerateVideoStartImage'));

app.post('/api/veo/status', async (req, res) => {
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    const response = await fetch(`${VEO_API_BASE}/video:batchCheckAsyncVideoGenerationStatus`, {
      method: 'POST',
      headers: { 'x-goog-api-key': GOOGLE_API_KEY, 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json', 'Origin': 'https://labs.google' },
      body: JSON.stringify(req.body)
    });
    res.json(await getJson(response, req));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/veo/upload', async (req, res) => {
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    const response = await fetch(`${VEO_API_BASE}:uploadUserImage`, {
      method: 'POST',
      headers: { 'x-goog-api-key': GOOGLE_API_KEY, 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json', 'Origin': 'https://labs.google' },
      body: JSON.stringify(req.body)
    });
    res.json(await getJson(response, req));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/imagen/generate', async (req, res) => {
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    const recaptchaToken = req.headers['x-recaptcha-token'];
    let body = { ...req.body };
    if (recaptchaToken) {
        if (!body.clientContext) body.clientContext = {};
        body.clientContext.recaptchaToken = recaptchaToken;
    }
    const response = await fetch(`${VEO_API_BASE}/whisk:generateImage`, {
      method: 'POST',
      headers: { 'x-goog-api-key': GOOGLE_API_KEY, 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json', 'Origin': 'https://labs.google' },
      body: JSON.stringify(body)
    });
    res.json(await getJson(response, req));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/veo/download-video', async (req, res) => {
  try {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'Missing URL' });
    const response = await fetch(videoUrl);
    res.setHeader('Content-Type', 'video/mp4');
    response.body.pipe(res);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Proxy Server running on port ${PORT}`);
});
