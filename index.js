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

// ✅ GUNA GOOGLE'S OFFICIAL SITE KEY (from labs.google)
// This is the site key that Google VEO API expects!
const RECAPTCHA_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

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
// 🔐 RECAPTCHA VALIDATION
// ===============================
/**
 * CRITICAL: This validates reCAPTCHA token with Google's API
 * Uses Google's OFFICIAL site key from labs.google
 */
async function validateRecaptchaToken(recaptchaToken, expectedAction = 'submit') {
  if (!recaptchaToken) {
    log('warn', null, '⚠️ No reCAPTCHA token provided');
    return { valid: false, reason: 'NO_TOKEN' };
  }

  try {
    log('log', null, `🔐 [reCAPTCHA] Validating token... (action: ${expectedAction})`);
    
    // Use Google's reCAPTCHA Enterprise API
    const assessmentUrl = `https://recaptchaenterprise.googleapis.com/v1/projects/${PROJECT_ID}/assessments?key=${GOOGLE_API_KEY}`;
    
    const response = await fetch(assessmentUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event: {
          token: recaptchaToken,
          siteKey: RECAPTCHA_SITE_KEY,
          expectedAction: expectedAction
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      log('error', null, `❌ [reCAPTCHA] Validation failed. Status: ${response.status}`, errorText);
      return { valid: false, reason: 'API_ERROR', details: errorText };
    }

    const assessment = await response.json();
    
    const isValid = assessment.tokenProperties?.valid === true;
    const score = assessment.riskAnalysis?.score || 0;
    const action = assessment.tokenProperties?.action;
    
    log('log', null, `🔐 [reCAPTCHA] Assessment:`, {
      valid: isValid,
      score: score.toFixed(2),
      action: action,
      expectedAction: expectedAction
    });

    if (!isValid) {
      const reason = assessment.tokenProperties?.invalidReason || 'UNKNOWN';
      log('error', null, `❌ [reCAPTCHA] Token invalid: ${reason}`);
      return { 
        valid: false, 
        reason: 'INVALID_TOKEN',
        details: reason
      };
    }

    // Check score threshold (lenient for VEO)
    const SCORE_THRESHOLD = 0.3;
    if (score < SCORE_THRESHOLD) {
      log('warn', null, `⚠️ [reCAPTCHA] Low score: ${score.toFixed(2)} (threshold: ${SCORE_THRESHOLD}) - proceeding anyway`);
    }

    log('log', null, `✅ [reCAPTCHA] Validation SUCCESS! Score: ${score.toFixed(2)}`);
    return { valid: true, score: score, action: action };

  } catch (error) {
    log('error', null, '❌ [reCAPTCHA] Exception during validation:', error.message);
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
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    recaptcha: 'enabled'
  });
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
    delete requestBody.recaptchaToken;

    // 3. VALIDATE RECAPTCHA (MANDATORY)
    if (recaptchaToken) {
      log('log', req, '🔐 reCAPTCHA token found - validating...');
      
      const validation = await validateRecaptchaToken(recaptchaToken, 'submit');
      
      if (!validation.valid) {
        log('error', req, '❌ reCAPTCHA validation failed:', validation);
        return res.status(403).json({ 
          error: 'RECAPTCHA_VALIDATION_FAILED',
          message: 'reCAPTCHA verification failed',
          details: validation,
          requiresRecaptcha: true
        });
      }
      
      log('log', req, `✅ reCAPTCHA validated! Score: ${validation.score?.toFixed(2)}`);
      
      // Add validated token to clientContext
      if (!requestBody.clientContext) {
        requestBody.clientContext = {};
      }
      requestBody.clientContext.recaptchaToken = recaptchaToken;
    } else {
      log('warn', req, '⚠️ No reCAPTCHA token provided - request might fail');
    }

    // 4. FORWARD TO VEO API
    log('log', req, '📤 Forwarding to VEO API...');
    
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
      log('error', req, '❌ VEO API Error:', data);
      
      // Check if reCAPTCHA is required
      const errorMsg = JSON.stringify(data).toLowerCase();
      if (errorMsg.includes('recaptcha') || response.status === 403) {
        log('warn', req, '🔐 Google requires reCAPTCHA verification');
        return res.status(403).json({ 
          error: 'RECAPTCHA_REQUIRED',
          message: 'Google requires reCAPTCHA verification',
          requiresRecaptcha: true,
          originalError: data
        });
      }
      
      return res.status(response.status).json(data);
    }

    log('log', req, `✅ [T2V] Success! Operations: ${data.operations?.length || 0}`);
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Server error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🖼️ IMAGE-TO-VIDEO
app.post('/api/veo/generate-i2v', async (req, res) => {
  log('log', req, '\n🖼️ ===== [I2V] IMAGE-TO-VIDEO REQUEST =====');
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
      log('error', req, '❌ No auth token provided');
      return res.status(401).json({ error: 'No auth token provided' });
    }

    const recaptchaToken = req.body.recaptchaToken;
    let requestBody = { ...req.body };
    delete requestBody.recaptchaToken;

    if (recaptchaToken) {
      log('log', req, '🔐 reCAPTCHA token found - validating...');
      
      const validation = await validateRecaptchaToken(recaptchaToken, 'submit');
      
      if (!validation.valid) {
        log('error', req, '❌ reCAPTCHA validation failed:', validation);
        return res.status(403).json({ 
          error: 'RECAPTCHA_VALIDATION_FAILED',
          message: 'reCAPTCHA verification failed',
          details: validation,
          requiresRecaptcha: true
        });
      }
      
      log('log', req, `✅ reCAPTCHA validated! Score: ${validation.score?.toFixed(2)}`);
      
      if (!requestBody.clientContext) {
        requestBody.clientContext = {};
      }
      requestBody.clientContext.recaptchaToken = recaptchaToken;
    } else {
      log('warn', req, '⚠️ No reCAPTCHA token provided - request might fail');
    }

    log('log', req, '📤 Forwarding to VEO API...');
    
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
      log('error', req, '❌ VEO API Error:', data);
      
      const errorMsg = JSON.stringify(data).toLowerCase();
      if (errorMsg.includes('recaptcha') || response.status === 403) {
        log('warn', req, '🔐 Google requires reCAPTCHA verification');
        return res.status(403).json({ 
          error: 'RECAPTCHA_REQUIRED',
          message: 'Google requires reCAPTCHA verification',
          requiresRecaptcha: true,
          originalError: data
        });
      }
      
      return res.status(response.status).json(data);
    }

    log('log', req, `✅ [I2V] Success! Operations: ${data.operations?.length || 0}`);
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Server error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🔍 CHECK VIDEO STATUS
app.post('/api/veo/status', async (req, res) => {
  log('log', req, '\n🔍 ===== [STATUS] CHECK VIDEO STATUS =====');
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
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
      log('error', req, '❌ Status check failed:', data);
      return res.status(response.status).json(data);
    }

    log('log', req, '✅ [STATUS] Success');
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Server error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 📤 VEO UPLOAD IMAGE
app.post('/api/veo/upload', async (req, res) => {
  log('log', req, '\n📤 ===== [VEO UPLOAD] IMAGE =====');
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
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
      log('error', req, '❌ Upload failed:', data);
      return res.status(response.status).json(data);
    }

    log('log', req, '✅ [UPLOAD] Success');
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Server error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===============================
// ========== IMAGEN ENDPOINTS ==========
// ===============================

app.post('/api/imagen/generate', async (req, res) => {
  log('log', req, '\n🎨 ===== [IMAGEN] GENERATE =====');
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
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
      return res.status(response.status).json(data);
    }

    log('log', req, '✅ [IMAGEN] Success');
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Server error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/imagen/run-recipe', async (req, res) => {
  log('log', req, '\n✏️ ===== [IMAGEN] RUN RECIPE =====');
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
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
      return res.status(response.status).json(data);
    }
    
    log('log', req, '✅ [IMAGEN RECIPE] Success');
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Server error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/imagen/upload', async (req, res) => {
  log('log', req, '\n📤 ===== [IMAGEN] UPLOAD =====');
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
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
      return res.status(response.status).json(data);
    }

    log('log', req, '✅ [IMAGEN UPLOAD] Success');
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Server error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===============================
// 📥 DOWNLOAD VIDEO
// ===============================
app.get('/api/veo/download-video', async (req, res) => {
  log('log', req, '\n📥 ===== [DOWNLOAD] VIDEO =====');
  try {
    const videoUrl = req.query.url;
    
    if (!videoUrl || typeof videoUrl !== 'string') {
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
      log('log', req, '✅ [DOWNLOAD] Complete');
    });

  } catch (error) {
    log('error', req, '❌ Download error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// ===============================
// 🚀 SERVER START
// ===============================
app.listen(PORT, '0.0.0.0', () => {
  log('log', null, '\n╔═══════════════════════════════════════╗');
  log('log', null, '║  🚀 MONOKLIX PROXY SERVER STARTED   ║');
  log('log', null, '╚═══════════════════════════════════════╝');
  log('log', null, `📍 Port: ${PORT}`);
  log('log', null, `📍 Health: http://localhost:${PORT}/health`);
  log('log', null, '');
  log('log', null, '🔐 reCAPTCHA Configuration:');
  log('log', null, `   Site Key: ${RECAPTCHA_SITE_KEY}`);
  log('log', null, `   Project: ${PROJECT_ID}`);
  log('log', null, `   Validation: ENABLED ✅`);
  log('log', null, '');
  log('log', null, '📋 Endpoints Ready:');
  log('log', null, '   VEO:    /api/veo/*');
  log('log', null, '   IMAGEN: /api/imagen/*');
  log('log', null, '═══════════════════════════════════════\n');
});
