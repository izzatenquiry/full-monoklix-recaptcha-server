
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
  
  if (level === 'error') {
    console.error(prefix, ...args);
  } else if (level === 'warn') {
    console.warn(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
};

const getJson = async (response, req) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    log('warn', req, '⚠️ Non-JSON response:', text.substring(0, 200));
    return { error: text };
  }
};

async function validateRecaptchaToken(token, expectedAction) {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'NO_TOKEN' };
  }

  try {
    log('log', null, `🔐 [reCAPTCHA] Validating token for action: ${expectedAction}`);
    
    const assessmentUrl = `https://recaptchaenterprise.googleapis.com/v1/projects/${PROJECT_ID}/assessments?key=${GOOGLE_API_KEY}`;
    
    const requestBody = {
      event: {
        token: token,
        expectedAction: expectedAction,
        siteKey: RECAPTCHA_SITE_KEY
      }
    };

    const response = await fetch(assessmentUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { valid: false, reason: 'HTTP_ERROR', status: response.status, message: errorText };
    }

    const data = await response.json();
    
    if (!data.tokenProperties || !data.tokenProperties.valid) {
      log('error', null, '❌ [reCAPTCHA] Token invalid:', data.tokenProperties?.invalidReason || 'unknown');
      return { valid: false, reason: data.tokenProperties?.invalidReason || 'INVALID_TOKEN' };
    }

    // Periksa kalau action dlm token sama dengan apa yang kita minta
    if (data.tokenProperties.action !== expectedAction) {
        log('error', null, `❌ [reCAPTCHA] Action Mismatch: Got ${data.tokenProperties.action}, expected ${expectedAction}`);
        return { valid: false, reason: 'ACTION_MISMATCH' };
    }

    const score = data.riskAnalysis?.score ?? 0;
    log('log', null, `✅ [reCAPTCHA] Token valid! Score: ${score.toFixed(2)}`);
    return { valid: true, score: score, action: data.tokenProperties.action };

  } catch (error) {
    return { valid: false, reason: 'EXCEPTION', error: error.message };
  }
}

// ===============================
// 🧩 MIDDLEWARE
// ===============================
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ===============================
// ========== VEO3 ENDPOINTS ==========
// ===============================

app.post('/api/veo/generate-t2v', async (req, res) => {
  log('log', req, '🎬 [T2V] Processing Request...');
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    
    // Tarik token dari body atau clientContext
    const recaptchaToken = req.body.recaptchaToken || req.body.clientContext?.recaptchaToken;
    let requestBody = { ...req.body };

    if (recaptchaToken) {
      // PENTING: Ikut action dlm flow-automator.js
      const validation = await validateRecaptchaToken(recaptchaToken, 'PINHOLE_GENERATE');
      
      if (!validation.valid) {
        return res.status(403).json({ error: 'RECAPTCHA_VALIDATION_FAILED', details: validation });
      }
      
      if (!requestBody.clientContext) requestBody.clientContext = {};
      requestBody.clientContext.recaptchaToken = recaptchaToken;
    }

    const response = await fetch(`${VEO_API_BASE}/video:batchAsyncGenerateVideoText`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': GOOGLE_API_KEY,
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'Origin': 'https://labs.google'
      },
      body: JSON.stringify(requestBody)
    });

    const data = await getJson(response, req);
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/veo/generate-i2v', async (req, res) => {
  log('log', req, '🖼️ [I2V] Processing Request...');
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    const recaptchaToken = req.body.recaptchaToken || req.body.clientContext?.recaptchaToken;
    let requestBody = { ...req.body };

    if (recaptchaToken) {
      const validation = await validateRecaptchaToken(recaptchaToken, 'PINHOLE_GENERATE');
      if (!validation.valid) return res.status(403).json({ error: 'RECAPTCHA_VALIDATION_FAILED', details: validation });
      
      if (!requestBody.clientContext) requestBody.clientContext = {};
      requestBody.clientContext.recaptchaToken = recaptchaToken;
    }

    const response = await fetch(`${VEO_API_BASE}/video:batchAsyncGenerateVideoStartImage`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': GOOGLE_API_KEY,
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'Origin': 'https://labs.google'
      },
      body: JSON.stringify(requestBody)
    });

    const data = await getJson(response, req);
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint status & upload (Tiada perubahan logic utama)
app.post('/api/veo/status', async (req, res) => {
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    const response = await fetch(`${VEO_API_BASE}/video:batchCheckAsyncVideoGenerationStatus`, {
      method: 'POST',
      headers: { 'x-goog-api-key': GOOGLE_API_KEY, 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await getJson(response, req);
    res.status(response.status).json(data);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/veo/upload', async (req, res) => {
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    const response = await fetch(`${VEO_API_BASE}:uploadUserImage`, {
      method: 'POST',
      headers: { 'x-goog-api-key': GOOGLE_API_KEY, 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await getJson(response, req);
    res.status(response.status).json(data);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Endpoint Download
app.get('/api/veo/download-video', async (req, res) => {
  try {
    const videoUrl = req.query.url;
    const response = await fetch(videoUrl);
    res.setHeader('Content-Type', 'video/mp4');
    response.body.pipe(res);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Proxy Server running on port ${PORT}`);
});
