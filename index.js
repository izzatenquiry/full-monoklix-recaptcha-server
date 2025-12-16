
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3001;
const VEO_API_BASE = 'https://aisandbox-pa.googleapis.com/v1';

// ===============================
// 🔐 RECAPTCHA ENTERPRISE CREDENTIALS
// ===============================
const PROJECT_ID = 'gen-lang-client-0426593366';
const RECAPTCHA_SITE_KEY = '6Lf29SwsAAAAANT1f-p_ASlaAFqNyv53E3bgxoV9';

// ===============================
// 📝 LOGGER
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
// 🔐 RECAPTCHA ENTERPRISE WITH OAUTH
// ===============================
/**
 * Validates reCAPTCHA Enterprise using OAuth token
 * SAME authentication method as VEO API - NO separate API key needed!
 */
async function verifyRecaptchaWithOAuth(recaptchaToken, authToken, expectedAction = 'veo_generate') {
  if (!recaptchaToken || !authToken) {
    return { success: false, error: 'Missing token(s)' };
  }
  
  try {
    log('log', null, `🔐 [reCAPTCHA] Validating with OAuth token for action: ${expectedAction}`);
    
    // Uses OAuth token in Authorization header - NO API key in URL!
    const url = `https://recaptchaenterprise.googleapis.com/v1/projects/${PROJECT_ID}/assessments`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}` // ← Same OAuth token as VEO!
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
      log('error', null, '❌ [reCAPTCHA] Validation failed:', response.status, errorText);
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }
    
    const assessment = await response.json();
    
    log('log', null, '🔐 [reCAPTCHA] Assessment:', {
      valid: assessment.tokenProperties?.valid,
      action: assessment.tokenProperties?.action,
      score: assessment.riskAnalysis?.score
    });
    
    if (!assessment.tokenProperties?.valid) {
      log('error', null, '❌ [reCAPTCHA] Token invalid');
      return { success: false, error: 'Invalid token' };
    }
    
    if (assessment.tokenProperties?.action !== expectedAction) {
      log('error', null, `❌ [reCAPTCHA] Action mismatch!`);
      return { success: false, error: 'Action mismatch' };
    }
    
    const score = assessment.riskAnalysis?.score || 0;
    const THRESHOLD = 0.3;
    
    if (score < THRESHOLD) {
      log('warn', null, `⚠️ [reCAPTCHA] Score too low: ${score}`);
      return { success: false, error: 'Score too low', score, threshold: THRESHOLD };
    }
    
    log('log', null, `✅ [reCAPTCHA] PASSED! Score: ${score}`);
    return { success: true, score, action: assessment.tokenProperties?.action };
    
  } catch (error) {
    log('error', null, '❌ [reCAPTCHA] Error:', error);
    return { success: false, error: error.message };
  }
}

// ===============================
// 🧩 MIDDLEWARE - APPLE FIX
// ===============================
app.use(cors({
  origin: true, // Allow any origin
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
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) {
      log('error', req, '❌ No auth token provided');
      return res.status(401).json({ error: 'No auth token provided' });
    }

    const recaptchaToken = req.body.recaptchaToken;
    const bodyWithoutRecaptcha = { ...req.body };
    delete bodyWithoutRecaptcha.recaptchaToken;

    // Validate reCAPTCHA using OAuth token
    if (recaptchaToken) {
      log('log', req, '🔒 reCAPTCHA token provided, validating with OAuth...');
      const validation = await verifyRecaptchaWithOAuth(recaptchaToken, authToken, 'veo_generate');
      
      if (!validation.success) {
        log('error', req, '❌ reCAPTCHA validation failed:', validation.error);
        return res.status(403).json({
          error: 'RECAPTCHA_REQUIRED',
          message: 'reCAPTCHA verification failed',
          originalError: {
            error: {
              code: 403,
              message: 'reCAPTCHA evaluation failed',
              status: 'PERMISSION_DENIED',
              details: validation
            }
          }
        });
      }
      
      log('log', req, `✅ reCAPTCHA validated with OAuth! Score: ${validation.score}`);
    }

    log('log', req, '📤 Forwarding to Veo API...');

    const headers = {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'Origin': 'https://labs.google',
      'Referer': 'https://labs.google/'
    };

    const response = await fetch(`${VEO_API_BASE}/video:batchAsyncGenerateVideoText`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(bodyWithoutRecaptcha)
    });

    const data = await getJson(response, req);
    log('log', req, '📨 Response status:', response.status);
    
    if (!response.ok) {
      log('error', req, '❌ Veo API Error (T2V):', data);
      
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
    const bodyWithoutRecaptcha = { ...req.body };
    delete bodyWithoutRecaptcha.recaptchaToken;

    // Validate reCAPTCHA using OAuth token
    if (recaptchaToken) {
      log('log', req, '🔒 reCAPTCHA token provided, validating with OAuth...');
      const validation = await verifyRecaptchaWithOAuth(recaptchaToken, authToken, 'veo_generate');
      
      if (!validation.success) {
        log('error', req, '❌ reCAPTCHA validation failed:', validation.error);
        return res.status(403).json({
          error: 'RECAPTCHA_REQUIRED',
          message: 'reCAPTCHA verification failed',
          originalError: {
            error: {
              code: 403,
              message: 'reCAPTCHA evaluation failed',
              status: 'PERMISSION_DENIED',
              details: validation
            }
          }
        });
      }
      
      log('log', req, `✅ reCAPTCHA validated with OAuth! Score: ${validation.score}`);
    }

    const headers = {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'Origin': 'https://labs.google',
      'Referer': 'https://labs.google/'
    };
    
    const response = await fetch(`${VEO_API_BASE}/video:batchAsyncGenerateVideoStartImage`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(bodyWithoutRecaptcha)
    });

    const data = await getJson(response, req);
    log('log', req, '📨 Response status:', response.status);
    
    if (!response.ok) {
      log('error', req, '❌ Veo API Error (I2V):', data);
      
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
  logSystem('🔐 reCAPTCHA: OAuth-based validation ✅');
  logSystem(`🔐 Project ID: ${PROJECT_ID}`);
  logSystem('===================================\n');
  logSystem('📋 VEO3 Endpoints:');
  logSystem('   POST /api/veo/generate-t2v (OAuth reCAPTCHA ✅)');
  logSystem('   POST /api/veo/generate-i2v (OAuth reCAPTCHA ✅)');
  logSystem('   POST /api/veo/status');
  logSystem('   POST /api/veo/upload');
  logSystem('   GET  /api/veo/download-video');
  logSystem('📋 IMAGEN Endpoints:');
  logSystem('   POST /api/imagen/generate');
  logSystem('   POST /api/imagen/run-recipe');
  logSystem('   POST /api/imagen/upload');
  logSystem('===================================\n');
});
