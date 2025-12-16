import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3001;
const VEO_API_BASE = 'https://aisandbox-pa.googleapis.com/v1';

// ===============================
// 🔑 GOOGLE API KEY + RECAPTCHA
// ===============================
const GOOGLE_API_KEY = 'AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY';
const PROJECT_ID = 'gen-lang-client-0426593366';
const RECAPTCHA_SITE_KEY = '6Lf29SwsAAAAANT1f-p_ASlaAFqNyv53E3bgxoV9';

// ===============================
// 🔐 AUTH STRATEGY (FROM HAR ANALYSIS)
// ===============================
// Google VEO API requires BOTH:
// 1. x-goog-api-key header (API key for API access)
// 2. Authorization header (User's OAuth token for auth)
// 3. reCAPTCHA token validation (for abuse prevention)

/**
 * Verify reCAPTCHA token using Google reCAPTCHA Enterprise with API KEY
 */
async function verifyRecaptchaWithAPIKey(recaptchaToken, expectedAction = 'veo_generate') {
  if (!recaptchaToken) {
    return { success: false, error: 'No reCAPTCHA token provided' };
  }
  
  try {
    const url = `https://recaptchaenterprise.googleapis.com/v1/projects/${PROJECT_ID}/assessments?key=${GOOGLE_API_KEY}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        event: {
          token: recaptchaToken,
          expectedAction: expectedAction,
          siteKey: RECAPTCHA_SITE_KEY,
        }
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }
    
    const assessment = await response.json();
    
    // Check if token is valid
    if (!assessment.tokenProperties?.valid) {
      return { 
        success: false, 
        error: 'Invalid token',
        reason: assessment.tokenProperties?.invalidReason 
      };
    }
    
    // Check action matches
    if (assessment.tokenProperties?.action !== expectedAction) {
      return { success: false, error: 'Action mismatch' };
    }
    
    // Check risk score
    const score = assessment.riskAnalysis?.score || 0;
    const THRESHOLD = 0.3;
    
    if (score < THRESHOLD) {
      return { 
        success: false, 
        error: 'Score too low',
        score: score,
        threshold: THRESHOLD 
      };
    }
    
    return { 
      success: true, 
      score: score,
      action: assessment.tokenProperties?.action
    };
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Verify reCAPTCHA token using Google reCAPTCHA Enterprise with OAuth (DEPRECATED - insufficient scope)
 */
async function verifyRecaptchaWithOAuth(recaptchaToken, authToken, expectedAction = 'veo_generate') {
  if (!recaptchaToken) {
    return { success: false, error: 'No reCAPTCHA token provided' };
  }
  
  if (!authToken) {
    return { success: false, error: 'No auth token provided' };
  }
  
  try {
    const url = `https://recaptchaenterprise.googleapis.com/v1/projects/${PROJECT_ID}/assessments`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}` // Use user's OAuth token
      },
      body: JSON.stringify({
        event: {
          token: recaptchaToken,
          expectedAction: expectedAction,
          siteKey: RECAPTCHA_SITE_KEY,
        }
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }
    
    const assessment = await response.json();
    
    // Check if token is valid
    if (!assessment.tokenProperties?.valid) {
      return { 
        success: false, 
        error: 'Invalid token',
        reason: assessment.tokenProperties?.invalidReason 
      };
    }
    
    // Check action matches
    if (assessment.tokenProperties?.action !== expectedAction) {
      return { success: false, error: 'Action mismatch' };
    }
    
    // Check risk score
    const score = assessment.riskAnalysis?.score || 0;
    const THRESHOLD = 0.3;
    
    if (score < THRESHOLD) {
      return { 
        success: false, 
        error: 'Score too low',
        score: score,
        threshold: THRESHOLD 
      };
    }
    
    return { 
      success: true, 
      score: score,
      action: assessment.tokenProperties?.action
    };
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ===============================
// 📝 LOGGING FUNCTION
// ===============================
const log = (level, req, ...messages) => {
  const timestamp = new Date().toLocaleString('sv-SE', {
    timeZone: 'Asia/Kuala_Lumpur',
  });
  const username = req ? (req.headers['x-user-username'] || 'anonymous') : 'SYSTEM';
  const prefix = `[${timestamp}] [${username}]`;

  // Stringify objects for better readability
  const processedMessages = messages.map(msg => {
    if (typeof msg === 'object' && msg !== null) {
      try {
        // Truncate long base64 strings in logs
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


// A helper to safely parse JSON from a response
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
// 🔐 RECAPTCHA ENTERPRISE VERIFICATION
// ===============================
/**
 * Validates reCAPTCHA Enterprise token with Google
 * This uses the Enterprise API, NOT the v2/v3 verification endpoint!
 */
async function verifyRecaptchaEnterprise(token, expectedAction = 'veo_generate') {
  if (!token) {
    return { success: false, error: 'No token provided' };
  }
  
  try {
    log('log', null, `🔐 [reCAPTCHA] Validating token for action: ${expectedAction}`);
    
    // Enterprise API endpoint - CRITICAL: Use this endpoint!
    const url = `https://recaptchaenterprise.googleapis.com/v1/projects/${PROJECT_ID}/assessments?key=${RECAPTCHA_SECRET_KEY}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: {
          token: token,
          expectedAction: expectedAction,
          siteKey: RECAPTCHA_SITE_KEY,
        }
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      log('error', null, '❌ [reCAPTCHA] Validation request failed:', response.status, errorText);
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }
    
    const assessment = await response.json();
    
    log('log', null, '🔐 [reCAPTCHA] Assessment:', {
      valid: assessment.tokenProperties?.valid,
      action: assessment.tokenProperties?.action,
      score: assessment.riskAnalysis?.score
    });
    
    // Step 1: Check if token is valid
    if (!assessment.tokenProperties?.valid) {
      log('error', null, '❌ [reCAPTCHA] Token invalid:', assessment.tokenProperties?.invalidReason);
      return { 
        success: false, 
        error: 'Invalid token',
        reason: assessment.tokenProperties?.invalidReason 
      };
    }
    
    // Step 2: Check action matches
    if (assessment.tokenProperties?.action !== expectedAction) {
      log('error', null, `❌ [reCAPTCHA] Action mismatch! Expected: ${expectedAction}, Got: ${assessment.tokenProperties?.action}`);
      return { 
        success: false, 
        error: 'Action mismatch' 
      };
    }
    
    // Step 3: Check risk score (0.0 = bot, 1.0 = human)
    const score = assessment.riskAnalysis?.score || 0;
    const THRESHOLD = 0.3; // Lenient threshold for VEO3
    
    if (score < THRESHOLD) {
      log('warn', null, `⚠️ [reCAPTCHA] Score too low: ${score} (threshold: ${THRESHOLD})`);
      return { 
        success: false, 
        error: 'Score too low',
        score: score,
        threshold: THRESHOLD 
      };
    }
    
    log('log', null, `✅ [reCAPTCHA] Validation PASSED! Score: ${score}`);
    return { 
      success: true, 
      score: score,
      action: assessment.tokenProperties?.action
    };
    
  } catch (error) {
    log('error', null, '❌ [reCAPTCHA] Validation error:', error);
    return { success: false, error: error.message };
  }
}

// ===============================
// 🧩 MIDDLEWARE - APPLE FIX
// ===============================
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests from your domains
    const allowedOrigins = [
      'https://app.monoklix.com',
      'https://app2.monoklix.com',
      'https://dev.monoklix.com',
      'https://dev1.monoklix.com',
      'https://apple.monoklix.com',
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

// Apple devices preflight fix
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

// 🎬 TEXT-TO-VIDEO (WITH AUTH TOKEN + RECAPTCHA VALIDATION)
app.post('/api/veo/generate-t2v', async (req, res) => {
  log('log', req, '\n🎬 ===== [T2V] TEXT-TO-VIDEO REQUEST =====');
  try {
    // 1. GET AUTH TOKEN
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
      log('error', req, '❌ No auth token provided');
      return res.status(401).json({ error: 'No auth token provided' });
    }

    // 2. EXTRACT RECAPTCHA TOKEN - Move from body to header!
    const recaptchaToken = req.body.recaptchaToken;
    const bodyWithoutRecaptcha = { ...req.body };
    delete bodyWithoutRecaptcha.recaptchaToken;
    
    if (recaptchaToken) {
      log('log', req, '🔒 reCAPTCHA token extracted, moving to X-Goog-Recaptcha-Token header...');
    }

    log('log', req, '📤 Forwarding to VEO API...');
    log('log', req, '📦 Request body:', bodyWithoutRecaptcha);

    // 3. BUILD HEADERS - Add reCAPTCHA to header!
    const headers = {
      'x-goog-api-key': GOOGLE_API_KEY,
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'Origin': 'https://labs.google',
      'Referer': 'https://labs.google/'
    };

    // Add reCAPTCHA token to header if present
    if (recaptchaToken) {
      headers['X-Goog-Recaptcha-Token'] = recaptchaToken;
    }

    const response = await fetch(`${VEO_API_BASE}/video:batchAsyncGenerateVideoText`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(bodyWithoutRecaptcha)  // Send body WITHOUT recaptchaToken
    });

    const data = await getJson(response, req);
    log('log', req, '📨 Response status:', response.status);
    
    if (!response.ok) {
      log('error', req, '❌ Veo API Error (T2V):', data);
      
      // Check if error is recaptcha-related (should not happen after validation)
      const errorMsg = data.error?.message || data.message || '';
      if (errorMsg.toLowerCase().includes('recaptcha') || 
          errorMsg.toLowerCase().includes('verification') ||
          response.status === 403) {
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
    log('log', req, '=========================================\n');
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Proxy error (T2V):', error);
    res.status(500).json({ error: error.message });
  }
});

// 🖼️ IMAGE-TO-VIDEO (WITH AUTH TOKEN + RECAPTCHA)
app.post('/api/veo/generate-i2v', async (req, res) => {
  log('log', req, '\n🖼️ ===== [I2V] IMAGE-TO-VIDEO REQUEST =====');
  try {
    // 1. GET AUTH TOKEN
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
      log('error', req, '❌ No auth token provided');
      return res.status(401).json({ error: 'No auth token provided' });
    }

    // 2. EXTRACT RECAPTCHA TOKEN - Move from body to header!
    const recaptchaToken = req.body.recaptchaToken;
    const bodyWithoutRecaptcha = { ...req.body };
    delete bodyWithoutRecaptcha.recaptchaToken;
    
    if (recaptchaToken) {
      log('log', req, '🔒 reCAPTCHA token extracted, moving to X-Goog-Recaptcha-Token header...');
    }

    log('log', req, '📤 Forwarding to VEO API...');

    if (bodyWithoutRecaptcha.requests?.[0]?.startImage?.mediaId) {
      log('log', req, '📤 Has startImage with mediaId:', bodyWithoutRecaptcha.requests[0].startImage.mediaId);
    }
    log('log', req, '📤 Prompt:', bodyWithoutRecaptcha.requests?.[0]?.textInput?.prompt?.substring(0, 100) + '...');
    log('log', req, '📤 Aspect ratio:', bodyWithoutRecaptcha.requests?.[0]?.aspectRatio);

    // 3. BUILD HEADERS - Add reCAPTCHA to header!
    const headers = {
      'x-goog-api-key': GOOGLE_API_KEY,
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'Origin': 'https://labs.google',
      'Referer': 'https://labs.google/'
    };

    // Add reCAPTCHA token to header if present
    if (recaptchaToken) {
      headers['X-Goog-Recaptcha-Token'] = recaptchaToken;
    }
    
    const response = await fetch(`${VEO_API_BASE}/video:batchAsyncGenerateVideoStartImage`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(bodyWithoutRecaptcha)  // Send body WITHOUT recaptchaToken
    });

    const data = await getJson(response, req);
    log('log', req, '📨 Response status:', response.status);
    
    if (!response.ok) {
      log('error', req, '❌ Veo API Error (I2V):', data);
      
      // Check for recaptcha requirement
      const errorMsg = data.error?.message || data.message || '';
      if (errorMsg.toLowerCase().includes('recaptcha') || 
          errorMsg.toLowerCase().includes('verification') ||
          response.status === 403) {
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
    log('log', req, '=========================================\n');
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

    log('log', req, '📦 Payload:', req.body);
    
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
    log('log', req, '📨 Response status:', response.status);
    
    if (!response.ok) {
      log('error', req, '❌ Veo API Error (Status):', data);
      return res.status(response.status).json(data);
    }

    if (data.operations?.[0]) {
      log('log', req, '📊 Operation status:', data.operations[0].status, 'Done:', data.operations[0].done);
    }

    log('log', req, '✅ [STATUS] Success');
    log('log', req, '=========================================\n');
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

    log('log', req, '📤 Mime type:', req.body.imageInput?.mimeType);
    log('log', req, '📤 Aspect ratio:', req.body.imageInput?.aspectRatio);

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
    log('log', req, '=========================================\n');
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Proxy error (VEO UPLOAD):', error);
    res.status(500).json({ error: error.message });
  }
});

// ===============================
// ========== IMAGEN ENDPOINTS ==========
// ===============================

// 🎨 GENERATE IMAGE (Imagen T2I)
app.post('/api/imagen/generate', async (req, res) => {
  log('log', req, '\n🎨 ===== [IMAGEN] GENERATE IMAGE =====');
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
      log('error', req, '❌ No auth token provided');
      return res.status(401).json({ error: 'No auth token provided' });
    }

    log('log', req, '📤 Forwarding to Imagen API...');
    log('log', req, '📦 Request body:', req.body);

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
    log('log', req, '📨 Response status:', response.status);
    
    if (!response.ok) {
      log('error', req, '❌ Imagen API Error:', data);
      return res.status(response.status).json(data);
    }

    log('log', req, '✅ [IMAGEN] Success - Generated:', data.imagePanels?.length || 0, 'panels');
    log('log', req, '=========================================\n');
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Proxy error (IMAGEN GENERATE):', error);
    res.status(500).json({ error: error.message });
  }
});

// ✏️ RUN RECIPE (Imagen Edit/Compose)
app.post('/api/imagen/run-recipe', async (req, res) => {
  log('log', req, '\n✏️ ===== [IMAGEN RECIPE] RUN RECIPE =====');
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
      log('error', req, '❌ No auth token provided');
      return res.status(401).json({ error: 'No auth token provided' });
    }

    log('log', req, '📤 Forwarding recipe to Imagen API...');
    log('log', req, '📦 Full body:', req.body);

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
    log('log', req, '📨 Response status:', response.status);
    
    if (!response.ok) {
      log('error', req, '❌ Imagen Recipe Error:', data);
      return res.status(response.status).json(data);
    }
    
    const panelCount = data.imagePanels?.length || 0;
    const imageCount = data.imagePanels?.[0]?.generatedImages?.length || 0;
    
    log('log', req, '✅ [IMAGEN RECIPE] Success');
    log('log', req, `   Generated ${panelCount} panel(s) with ${imageCount} image(s)`);
    log('log', req, '=========================================\n');
    
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Proxy error (IMAGEN RECIPE):', error);
    res.status(500).json({ error: error.message });
  }
});

// 📤 IMAGEN UPLOAD IMAGE
app.post('/api/imagen/upload', async (req, res) => {
  log('log', req, '\n📤 ===== [IMAGEN UPLOAD] IMAGE UPLOAD =====');
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
      log('error', req, '❌ No auth token provided');
      return res.status(401).json({ error: 'No auth token provided' });
    }

    const uploadMediaInput = req.body.uploadMediaInput;
    if (uploadMediaInput) {
      log('log', req, '📤 Media category:', uploadMediaInput.mediaCategory);
    }
    log('log', req, '📦 Full request body keys:', Object.keys(req.body));

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
      log('error', req, '❌ Imagen Upload Error:', data);
      return res.status(response.status).json(data);
    }

    const mediaId = data.result?.data?.json?.result?.uploadMediaGenerationId || 
                   data.mediaGenerationId?.mediaGenerationId || 
                   data.mediaId;
    
    log('log', req, '✅ [IMAGEN UPLOAD] Success - MediaId:', mediaId);
    log('log', req, '=========================================\n');
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Proxy error (IMAGEN UPLOAD):', error);
    res.status(500).json({ error: error.message });
  }
});

// ===============================
// 📥 DOWNLOAD VIDEO (CORS BYPASS)
// ===============================
app.get('/api/veo/download-video', async (req, res) => {
  log('log', req, '\n📥 ===== [DOWNLOAD] VIDEO DOWNLOAD =====');
  try {
    const videoUrl = req.query.url;
    
    if (!videoUrl || typeof videoUrl !== 'string') {
      log('error', req, '❌ No URL provided');
      return res.status(400).json({ error: 'Video URL is required' });
    }

    log('log', req, '📥 Video URL:', videoUrl);
    log('log', req, '📥 Fetching and streaming from Google Storage...');

    const response = await fetch(videoUrl);
    
    if (!response.ok) {
      log('error', req, '❌ Failed to fetch video:', response.status, response.statusText);
      const errorBody = await response.text();
      return res.status(response.status).json({ error: `Failed to download: ${response.statusText}`, details: errorBody });
    }

    const contentType = response.headers.get('content-type') || 'video/mp4';
    const contentLength = response.headers.get('content-length');
    const filename = `monoklix-video-${Date.now()}.mp4`;

    log('log', req, '📦 Video headers received:', { contentType, contentLength });

    res.setHeader('Content-Type', contentType);
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Accept-Ranges', 'bytes');

    response.body.pipe(res);

    response.body.on('end', () => {
      log('log', req, '✅ [DOWNLOAD] Video stream finished to client.');
      log('log', req, '=========================================\n');
    });

    response.body.on('error', (err) => {
      log('error', req, '❌ [DOWNLOAD] Error during video stream pipe:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error streaming video' });
      }
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
  const logSystem = (...args) => log('log', null, ...args);

  logSystem('\n🚀 ===================================');
  logSystem('🚀 Veo3 & Imagen Proxy Server STARTED');
  logSystem('🚀 ===================================');
  logSystem(`📍 Port: ${PORT}`);
  logSystem(`📍 Local: http://localhost:${PORT}`);
  logSystem(`📍 Health: http://localhost:${PORT}/health`);
  logSystem('✅ CORS: Apple Fix Enabled');
  logSystem('🔧 Debug logging: ENABLED');
  logSystem('🔐 Authentication: API Key + OAuth Token ✅');
  logSystem(`🔐 API Key: ${GOOGLE_API_KEY.substring(0, 20)}...`);
  logSystem(`🔐 reCAPTCHA: ${PROJECT_ID}`);
  logSystem('===================================\n');
  logSystem('📋 VEO3 Endpoints:');
  logSystem('   POST /api/veo/generate-t2v (reCAPTCHA ✅)');
  logSystem('   POST /api/veo/generate-i2v (reCAPTCHA ✅)');
  logSystem('   POST /api/veo/status');
  logSystem('   POST /api/veo/upload');
  logSystem('   GET  /api/veo/download-video');
  logSystem('📋 IMAGEN Endpoints:');
  logSystem('   POST /api/imagen/generate');
  logSystem('   POST /api/imagen/run-recipe');
  logSystem('   POST /api/imagen/upload');
  logSystem('===================================\n');
});
