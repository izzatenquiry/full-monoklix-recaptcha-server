
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3001;
const VEO_API_BASE = 'https://aisandbox-pa.googleapis.com/v1';

// ===============================
// 🔑 GOOGLE API CONFIG
// ===============================
const GOOGLE_API_KEY = 'AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY';

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
// 🧩 MIDDLEWARE
// ===============================
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-User-Username', 'User-Agent', 'x-goog-recaptcha-token'],
  maxAge: 86400,
  optionsSuccessStatus: 200
}));

app.use(express.json({ limit: '50mb' }));
app.options('*', cors());

// ===============================
// 🛠️ HELPER: CONSTRUCT HEADERS
// ===============================
const buildGoogleHeaders = (req, authToken, recaptchaToken = null) => {
    // CRITICAL: We must pretend to be the user's browser EXACTLY.
    // Google checks if the Token's User-Agent matches the Request's User-Agent.
    const userAgent = req.headers['user-agent'] || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

    const headers = {
        'x-goog-api-key': GOOGLE_API_KEY,
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        // SPOOFING: Pretend we are Google Labs to satisfy Origin checks
        'Origin': 'https://labs.google',
        'Referer': 'https://labs.google/',
        'User-Agent': userAgent, 
    };

    // INJECT RECAPTCHA
    // Note: The frontend might send it in body (legacy) or header. We handle both.
    const finalRecaptcha = recaptchaToken || req.headers['x-goog-recaptcha-token'];
    
    if (finalRecaptcha) {
        headers['X-Goog-Recaptcha-Token'] = finalRecaptcha;
        headers['x-recaptcha-token'] = finalRecaptcha; // Legacy fallback
        log('log', req, '🔒 Injected X-Goog-Recaptcha-Token header');
    }

    return headers;
};

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
    if (!authToken) return res.status(401).json({ error: 'No auth token provided' });

    // Extract & Clean Body
    let requestBody = { ...req.body };
    let recaptchaToken = null;

    if (requestBody.recaptchaToken) {
        recaptchaToken = requestBody.recaptchaToken;
        delete requestBody.recaptchaToken; // MUST REMOVE from body
    }

    const headers = buildGoogleHeaders(req, authToken, recaptchaToken);

    log('log', req, '📤 Forwarding to Veo API...');
    
    const response = await fetch(`${VEO_API_BASE}/video:batchAsyncGenerateVideoText`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(requestBody)
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
    if (!authToken) return res.status(401).json({ error: 'No auth token provided' });

    // Extract & Clean Body
    let requestBody = { ...req.body };
    let recaptchaToken = null;

    if (requestBody.recaptchaToken) {
        recaptchaToken = requestBody.recaptchaToken;
        delete requestBody.recaptchaToken; // MUST REMOVE from body
    }

    const headers = buildGoogleHeaders(req, authToken, recaptchaToken);

    const response = await fetch(`${VEO_API_BASE}/video:batchAsyncGenerateVideoStartImage`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(requestBody)
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
    res.json(data);
  } catch (error) {
    log('error', req, '❌ Proxy error (I2V):', error);
    res.status(500).json({ error: error.message });
  }
});

// 🔍 CHECK VIDEO STATUS
app.post('/api/veo/status', async (req, res) => {
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) return res.status(401).json({ error: 'No auth token provided' });

    const headers = buildGoogleHeaders(req, authToken);
    
    const response = await fetch(`${VEO_API_BASE}/video:batchCheckAsyncVideoGenerationStatus`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(req.body)
    });

    const data = await getJson(response, req);
    
    if (!response.ok) {
      log('error', req, '❌ Veo API Error (Status):', data);
      return res.status(response.status).json(data);
    }

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
    if (!authToken) return res.status(401).json({ error: 'No auth token provided' });

    const headers = buildGoogleHeaders(req, authToken);

    const response = await fetch(`${VEO_API_BASE}:uploadUserImage`, {
      method: 'POST',
      headers: headers,
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

// 🎨 GENERATE IMAGE (Imagen T2I)
app.post('/api/imagen/generate', async (req, res) => {
  log('log', req, '\n🎨 ===== [IMAGEN] GENERATE IMAGE =====');
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    if (!authToken) return res.status(401).json({ error: 'No auth token provided' });

    const headers = buildGoogleHeaders(req, authToken);

    const response = await fetch(`${VEO_API_BASE}/whisk:generateImage`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(req.body)
    });

    const data = await getJson(response, req);
    log('log', req, '📨 Response status:', response.status);
    
    if (!response.ok) {
      log('error', req, '❌ Imagen API Error:', data);
      return res.status(response.status).json(data);
    }

    log('log', req, '✅ [IMAGEN] Success - Generated:', data.imagePanels?.length || 0, 'panels');
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
    if (!authToken) return res.status(401).json({ error: 'No auth token provided' });

    const headers = buildGoogleHeaders(req, authToken);

    const response = await fetch(`${VEO_API_BASE}/whisk:runImageRecipe`, {
      method: 'POST',
      headers: headers,
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
    if (!authToken) return res.status(401).json({ error: 'No auth token provided' });

    const headers = buildGoogleHeaders(req, authToken);

    const response = await fetch(`${VEO_API_BASE}:uploadUserImage`, {
      method: 'POST',
      headers: headers,
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
    const filename = `monoklix-video-${Date.now()}.mp4`;

    res.setHeader('Content-Type', contentType);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Accept-Ranges', 'bytes');

    response.body.pipe(res);

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
  logSystem('✅ Header Spoofing: ACTIVE (User-Agent + Origin + Recaptcha)');
  logSystem('===================================\n');
});
