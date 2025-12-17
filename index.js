import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3001;
const VEO_API_BASE = 'https://aisandbox-pa.googleapis.com/v1';

// ===============================
// 🔑 CONFIGURATION
// ===============================
const GOOGLE_API_KEY = 'AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY';
const PROJECT_ID = 'gen-lang-client-0426593366';
const RECAPTCHA_SITE_KEY = '6LenAy4sAAAAAAAAH5gx8yT_maqcg-vpDDLmyZQj5M'; // ✅ UPDATED with correct key

// ===============================
// 📝 LOGGING FUNCTION
// ===============================
const log = (level, req, ...messages) => {
  const timestamp = new Date().toLocaleString('sv-SE', {
    timeZone: 'Asia/Kuala_Lumpur',
  });
  const username = req ? (req.headers['x-user-username'] || 'anonymous') : 'SYSTEM';
  const prefix = `[${timestamp}] [${username}]`;

  const processedMessages = messages.map(msg => {
    if (typeof msg === 'object' && msg !== null) {
      try {
        const tempMsg = JSON.parse(JSON.stringify(msg));
        if (tempMsg?.imageInput?.rawImageBytes?.length > 100) {
            tempMsg.imageInput.rawImageBytes = tempMsg.imageInput.rawImageBytes.substring(0, 50) + '...[TRUNCATED]';
        }
         if (tempMsg?.requests?.[0]?.textInput?.prompt?.length > 200) {
            tempMsg.requests[0].textInput.prompt = tempMsg.requests[0].textInput.prompt.substring(0, 200) + '...[TRUNCATED]';
        }
        return JSON.stringify(tempMsg, null, 2);
      } catch (e) {
        return '[Unserializable Object]';
      }
    }
    return msg;
  });

  if (level === 'error') {
    console.error(prefix, ...processedMessages);
  } else {
    console.log(prefix, ...processedMessages);
  }
};

// Helper to safely parse JSON
async function getJson(response, req) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch (e) {
        log('error', req, `❌ Upstream API response is not valid JSON. Status: ${response.status}`);
        log('error', req, `   Body: ${text}`);
        return { 
            error: 'Bad Gateway', 
            message: 'The API returned an invalid (non-JSON) response.', 
            details: text 
        };
    }
}

// ===============================
// 🔐 RECAPTCHA ENTERPRISE VALIDATION
// ===============================
/**
 * CRITICAL: Validates reCAPTCHA Enterprise token using API KEY
 * This is the CORRECT way for Monoklix setup
 * 
 * We use API Key (not OAuth) because:
 * 1. OAuth tokens from users may not have reCAPTCHA Enterprise scope
 * 2. API Key is simpler and works reliably
 * 3. Google's documentation recommends this for server-side validation
 */
async function validateRecaptchaEnterprise(recaptchaToken, expectedAction = 'submit') {
  if (!recaptchaToken) {
    log('warn', null, '⚠️ No reCAPTCHA token provided');
    return { valid: false, reason: 'NO_TOKEN' };
  }

  try {
    log('log', null, `🔐 Validating reCAPTCHA Enterprise token... (action: ${expectedAction})`);
    
    // CRITICAL: Use API Key for reCAPTCHA Enterprise validation
    const assessmentUrl = `https://recaptchaenterprise.googleapis.com/v1/projects/${PROJECT_ID}/assessments?key=${GOOGLE_API_KEY}`;
    
    const assessmentPayload = {
      event: {
        token: recaptchaToken,
        siteKey: RECAPTCHA_SITE_KEY,
        expectedAction: expectedAction
      }
    };

    const response = await fetch(assessmentUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(assessmentPayload)
    });

    if (!response.ok) {
      const errorData = await response.text();
      log('error', null, `❌ reCAPTCHA validation failed. Status: ${response.status}`, errorData);
      return { valid: false, reason: 'API_ERROR', details: errorData };
    }

    const assessment = await response.json();
    
    // Check if token is valid
    const isValid = assessment.tokenProperties?.valid === true;
    const score = assessment.riskAnalysis?.score || 0;
    const action = assessment.tokenProperties?.action;
    
    log('log', null, `🔐 reCAPTCHA Assessment:`, {
      valid: isValid,
      score: score.toFixed(2),
      action: action,
      expectedAction: expectedAction
    });

    if (!isValid) {
      return { 
        valid: false, 
        reason: 'INVALID_TOKEN',
        details: assessment.tokenProperties?.invalidReason 
      };
    }

    // Optional: Check action matches (lenient - sometimes action might differ)
    if (action !== expectedAction) {
      log('warn', null, `⚠️ Action mismatch: expected '${expectedAction}', got '${action}' (proceeding anyway)`);
    }

    // Optional: Check score threshold
    const SCORE_THRESHOLD = 0.3; // Lenient threshold
    if (score < SCORE_THRESHOLD) {
      log('warn', null, `⚠️ Low score: ${score.toFixed(2)} (threshold: ${SCORE_THRESHOLD})`);
      // Still proceed if token is valid (you can make this stricter if needed)
    }

    log('log', null, `✅ reCAPTCHA validated successfully! Score: ${score.toFixed(2)}`);
    return { valid: true, score: score, action: action };

  } catch (error) {
    log('error', null, '❌ Exception during reCAPTCHA validation:', error);
    return { valid: false, reason: 'EXCEPTION', error: error.message };
  }
}

// ===============================
// 🧩 MIDDLEWARE
// ===============================
app.use(cors({
  origin: function(origin, callback) {
    const allowedOrigins = [
      'https://app.monoklix.com',
      'https://app2.monoklix.com',
      'https://dev.monoklix.com',
      'https://dev1.monoklix.com',
      'https://apple.monoklix.com',
      'https://s11.monoklix.com',
      'http://localhost:3000',
      'http://localhost:3001'
    ];
    
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS not allowed'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-User-Username'],
  maxAge: 86400,
  optionsSuccessStatus: 200
}));

app.use(express.json({ limit: '50mb' }));
app.options('*', cors());

// ===============================
// 🔍 HEALTH CHECK
// ===============================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ===============================
// ========== VEO3 ENDPOINTS ==========
// ===============================

// 🎬 TEXT-TO-VIDEO
app.post('/api/veo/generate-t2v', async (req, res) => {
  log('log', req, '\n🎬 ===== [T2V] TEXT-TO-VIDEO REQUEST =====');
  try {
    // 1. GET AUTH TOKEN
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
      log('error', req, '❌ No auth token provided');
      return res.status(401).json({ error: 'No auth token provided' });
    }

    // 2. EXTRACT RECAPTCHA TOKEN
    const recaptchaToken = req.body.recaptchaToken;
    let requestBody = { ...req.body };
    delete requestBody.recaptchaToken; // Remove from body

    // 3. VALIDATE RECAPTCHA IF PROVIDED
    if (recaptchaToken) {
      const validation = await validateRecaptchaEnterprise(recaptchaToken, 'submit');
      
      if (!validation.valid) {
        log('error', req, '❌ reCAPTCHA validation failed:', validation);
        return res.status(403).json({ 
          error: 'RECAPTCHA_VALIDATION_FAILED',
          message: 'reCAPTCHA verification failed',
          details: validation
        });
      }
      
      log('log', req, '✅ reCAPTCHA validated. Score:', validation.score?.toFixed(2));
      
      // Add validated token to clientContext for Google VEO
      if (!requestBody.clientContext) {
        requestBody.clientContext = {};
      }
      requestBody.clientContext.recaptchaToken = recaptchaToken;
    }

    // 4. FORWARD TO VEO API
    log('log', req, '📤 Forwarding to Veo API...');
    
    const headers = {
      'x-goog-api-key': GOOGLE_API_KEY,
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'Origin': 'https://labs.google',
      'Referer': 'https://labs.google/'
    };

    const response = await fetch(`${VEO_API_BASE}/video:batchAsyncGenerateVideoText`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(requestBody)
    });

    const data = await getJson(response, req);
    log('log', req, '📨 Response status:', response.status);
    
    if (!response.ok) {
      log('error', req, '❌ Veo API Error (T2V):', data);
      
      // Check if reCAPTCHA is required
      const errorMsg = JSON.stringify(data).toLowerCase();
      if ((errorMsg.includes('recaptcha') || response.status === 403) && !recaptchaToken) {
        log('warn', req, '🔐 reCAPTCHA verification required');
        return res.status(403).json({ 
          error: 'RECAPTCHA_REQUIRED',
          message: 'Google requires reCAPTCHA verification for this request',
          originalError: data
        });
      }
      
      return res.status(response.status).json(data);
    }

    log('log', req, '✅ [T2V] Success - Operations:', data.operations?.length || 0);
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Proxy error (T2V):', error);
    res.status(500).json({ error: error.message });
  }
});

// 🖼️ IMAGE-TO-VIDEO
app.post('/api/veo/generate-i2v', async (req, res) => {
  log('log', req, '\n🖼️ ===== [I2V] IMAGE-TO-VIDEO REQUEST =====');
  try {
    // 1. GET AUTH TOKEN
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
      log('error', req, '❌ No auth token provided');
      return res.status(401).json({ error: 'No auth token provided' });
    }

    // 2. EXTRACT RECAPTCHA TOKEN
    const recaptchaToken = req.body.recaptchaToken;
    let requestBody = { ...req.body };
    delete requestBody.recaptchaToken;

    // 3. VALIDATE RECAPTCHA IF PROVIDED
    if (recaptchaToken) {
      const validation = await validateRecaptchaEnterprise(recaptchaToken, 'submit');
      
      if (!validation.valid) {
        log('error', req, '❌ reCAPTCHA validation failed:', validation);
        return res.status(403).json({ 
          error: 'RECAPTCHA_VALIDATION_FAILED',
          message: 'reCAPTCHA verification failed',
          details: validation
        });
      }
      
      log('log', req, '✅ reCAPTCHA validated. Score:', validation.score?.toFixed(2));
      
      // Add to clientContext
      if (!requestBody.clientContext) {
        requestBody.clientContext = {};
      }
      requestBody.clientContext.recaptchaToken = recaptchaToken;
    }

    // 4. FORWARD TO VEO API
    log('log', req, '📤 Forwarding to Veo API...');
    
    const headers = {
      'x-goog-api-key': GOOGLE_API_KEY,
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'Origin': 'https://labs.google',
      'Referer': 'https://labs.google/'
    };
    
    const response = await fetch(`${VEO_API_BASE}/video:batchAsyncGenerateVideoStartImage`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(requestBody)
    });

    const data = await getJson(response, req);
    log('log', req, '📨 Response status:', response.status);
    
    if (!response.ok) {
      log('error', req, '❌ Veo API Error (I2V):', data);
      
      const errorMsg = JSON.stringify(data).toLowerCase();
      if ((errorMsg.includes('recaptcha') || response.status === 403) && !recaptchaToken) {
        log('warn', req, '🔐 reCAPTCHA verification required');
        return res.status(403).json({ 
          error: 'RECAPTCHA_REQUIRED',
          message: 'Google requires reCAPTCHA verification for this request',
          originalError: data
        });
      }
      
      return res.status(response.status).json(data);
    }

    log('log', req, '✅ [I2V] Success - Operations:', data.operations?.length || 0);
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Proxy error (I2V):', error);
    res.status(500).json({ error: error.message });
  }
});

// 🔍 CHECK VIDEO STATUS
app.post('/api/veo/status', async (req, res) => {
  log('log', req, '\n🔍 ===== [STATUS] CHECK VIDEO STATUS =====');
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
      log('error', req, '❌ No auth token provided');
      return res.status(401).json({ error: 'No auth token provided' });
    }
    
    const response = await fetch(`${VEO_API_BASE}/video:batchCheckAsyncVideoGenerationStatus`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': GOOGLE_API_KEY,
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'Origin': 'https://labs.google',
        'Referer': 'https://labs.google/'
      },
      body: JSON.stringify(req.body)
    });

    const data = await getJson(response, req);
    
    if (!response.ok) {
      log('error', req, '❌ Veo API Error (Status):', data);
      return res.status(response.status).json(data);
    }

    log('log', req, '✅ [STATUS] Success');
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Proxy error (STATUS):', error);
    res.status(500).json({ error: error.message });
  }
});

// 📤 VEO UPLOAD IMAGE
app.post('/api/veo/upload', async (req, res) => {
  log('log', req, '\n📤 ===== [VEO UPLOAD] IMAGE UPLOAD =====');
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
      log('error', req, '❌ No auth token provided');
      return res.status(401).json({ error: 'No auth token provided' });
    }

    const response = await fetch(`${VEO_API_BASE}:uploadUserImage`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': GOOGLE_API_KEY,
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'Origin': 'https://labs.google',
        'Referer': 'https://labs.google/'
      },
      body: JSON.stringify(req.body)
    });

    const data = await getJson(response, req);
    log('log', req, '📨 Response status:', response.status);
    
    if (!response.ok) {
      log('error', req, '❌ Upload Error:', data);
      return res.status(response.status).json(data);
    }

    const mediaId = data.mediaGenerationId?.mediaGenerationId || data.mediaId;
    log('log', req, '✅ [VEO UPLOAD] Success - MediaId:', mediaId);
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Proxy error (VEO UPLOAD):', error);
    res.status(500).json({ error: error.message });
  }
});

// ===============================
// ========== IMAGEN ENDPOINTS ==========
// ===============================

// 🎨 GENERATE IMAGE
app.post('/api/imagen/generate', async (req, res) => {
  log('log', req, '\n🎨 ===== [IMAGEN] GENERATE IMAGE =====');
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
      log('error', req, '❌ No auth token provided');
      return res.status(401).json({ error: 'No auth token provided' });
    }

    const response = await fetch(`${VEO_API_BASE}/whisk:generateImage`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': GOOGLE_API_KEY,
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'Origin': 'https://labs.google',
        'Referer': 'https://labs.google/'
      },
      body: JSON.stringify(req.body)
    });

    const data = await getJson(response, req);
    
    if (!response.ok) {
      log('error', req, '❌ Imagen API Error:', data);
      return res.status(response.status).json(data);
    }

    log('log', req, '✅ [IMAGEN] Success');
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Proxy error (IMAGEN):', error);
    res.status(500).json({ error: error.message });
  }
});

// ✏️ RUN RECIPE
app.post('/api/imagen/run-recipe', async (req, res) => {
  log('log', req, '\n✏️ ===== [IMAGEN RECIPE] RUN RECIPE =====');
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
      log('error', req, '❌ No auth token provided');
      return res.status(401).json({ error: 'No auth token provided' });
    }

    const response = await fetch(`${VEO_API_BASE}/whisk:runImageRecipe`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': GOOGLE_API_KEY,
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'Origin': 'https://labs.google',
        'Referer': 'https://labs.google/'
      },
      body: JSON.stringify(req.body)
    });

    const data = await getJson(response, req);
    
    if (!response.ok) {
      log('error', req, '❌ Imagen Recipe Error:', data);
      return res.status(response.status).json(data);
    }
    
    log('log', req, '✅ [IMAGEN RECIPE] Success');
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Proxy error (IMAGEN RECIPE):', error);
    res.status(500).json({ error: error.message });
  }
});

// 📤 IMAGEN UPLOAD
app.post('/api/imagen/upload', async (req, res) => {
  log('log', req, '\n📤 ===== [IMAGEN UPLOAD] IMAGE UPLOAD =====');
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
      log('error', req, '❌ No auth token provided');
      return res.status(401).json({ error: 'No auth token provided' });
    }

    const response = await fetch(`${VEO_API_BASE}:uploadUserImage`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': GOOGLE_API_KEY,
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'Origin': 'https://labs.google',
        'Referer': 'https://labs.google/'
      },
      body: JSON.stringify(req.body)
    });

    const data = await getJson(response, req);
    
    if (!response.ok) {
      log('error', req, '❌ Imagen Upload Error:', data);
      return res.status(response.status).json(data);
    }

    log('log', req, '✅ [IMAGEN UPLOAD] Success');
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Proxy error (IMAGEN UPLOAD):', error);
    res.status(500).json({ error: error.message });
  }
});

// ===============================
// 📥 DOWNLOAD VIDEO
// ===============================
app.get('/api/veo/download-video', async (req, res) => {
  log('log', req, '\n📥 ===== [DOWNLOAD] VIDEO DOWNLOAD =====');
  try {
    const videoUrl = req.query.url;
    
    if (!videoUrl || typeof videoUrl !== 'string') {
      log('error', req, '❌ No URL provided');
      return res.status(400).json({ error: 'Video URL is required' });
    }

    const response = await fetch(videoUrl);
    
    if (!response.ok) {
      log('error', req, '❌ Failed to fetch video:', response.status);
      return res.status(response.status).json({ error: `Failed to download: ${response.statusText}` });
    }

    const contentType = response.headers.get('content-type') || 'video/mp4';
    const contentLength = response.headers.get('content-length');

    res.setHeader('Content-Type', contentType);
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    response.body.pipe(res);

    response.body.on('end', () => {
      log('log', req, '✅ [DOWNLOAD] Video stream finished');
    });

  } catch (error) {
    log('error', req, '❌ Proxy error (DOWNLOAD):', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// ===============================
// 🚀 SERVER START
// ===============================
app.listen(PORT, '0.0.0.0', () => {
  log('log', null, '\n🚀 ===================================');
  log('log', null, '🚀 Monoklix Proxy Server STARTED');
  log('log', null, '🚀 ===================================');
  log('log', null, `📍 Port: ${PORT}`);
  log('log', null, `📍 Health: http://localhost:${PORT}/health`);
  log('log', null, '🔐 reCAPTCHA Enterprise: ENABLED ✅');
  log('log', null, `🔐 Site Key: ${RECAPTCHA_SITE_KEY}`);
  log('log', null, `🔐 Project: ${PROJECT_ID}`);
  log('log', null, '===================================\n');
});
