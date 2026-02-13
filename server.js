const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'), false);
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasApiKey: !!REPLICATE_API_TOKEN,
    model: 'google/nano-banana-pro',
    timestamp: new Date().toISOString()
  });
});

// Generate AI hair transplant result using Nano Banana Pro
app.post('/api/generate', upload.single('image'), async (req, res) => {
  try {
    if (!REPLICATE_API_TOKEN) {
      return res.status(500).json({ error: 'API token not configured.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const style = req.body.style || 'natural';
    const density = req.body.density || 'medium';
    const hairline = req.body.hairline || 'age-appropriate';

    const prompt = buildHairPrompt(style, density, hairline);

    console.log(`[Generate] Starting with Nano Banana Pro - Style: ${style}, Density: ${density}, Hairline: ${hairline}`);
    console.log(`[Generate] Prompt: ${prompt.substring(0, 100)}...`);

    // Call Nano Banana Pro via Replicate
    const createResponse = await fetch('https://api.replicate.com/v1/models/google/nano-banana-pro/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait=120'
      },
      body: JSON.stringify({
        input: {
          prompt: prompt,
          image: base64Image,
          aspect_ratio: "1:1"
        }
      })
    });

    const responseText = await createResponse.text();
    console.log(`[Generate] API response status: ${createResponse.status}`);

    let prediction;
    try {
      prediction = JSON.parse(responseText);
    } catch (e) {
      console.error('[Generate] Failed to parse:', responseText.substring(0, 300));
      return res.status(500).json({ error: 'Invalid API response', detail: responseText.substring(0, 200) });
    }

    if (!createResponse.ok) {
      console.error('[Generate] API error:', JSON.stringify(prediction).substring(0, 500));
      return res.status(createResponse.status).json({
        error: 'API error',
        detail: prediction.detail || prediction.error || JSON.stringify(prediction).substring(0, 200)
      });
    }

    // Check if result is ready (Prefer: wait should return completed)
    if (prediction.status === 'succeeded' && prediction.output) {
      const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
      console.log(`[Generate] Success! Output URL ready.`);
      return res.json({ success: true, outputUrl });
    }

    // If not ready yet, poll
    if (prediction.id) {
      console.log(`[Generate] Prediction ${prediction.id} - polling...`);
      const pollUrl = prediction.urls?.get || `https://api.replicate.com/v1/predictions/${prediction.id}`;
      const result = await pollPrediction(pollUrl);

      if (result.status === 'succeeded' && result.output) {
        const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output;
        console.log(`[Generate] Success after polling!`);
        return res.json({ success: true, outputUrl });
      } else {
        console.error(`[Generate] Failed:`, result.error || result.logs);
        return res.status(500).json({
          error: 'Generation failed',
          detail: result.error || 'The AI model could not process this image. Try a different photo.'
        });
      }
    }

    return res.status(500).json({ error: 'Unexpected response', detail: JSON.stringify(prediction).substring(0, 200) });

  } catch (error) {
    console.error('[Generate] Server error:', error.message);
    res.status(500).json({ error: 'Server error', detail: error.message });
  }
});

// Poll prediction status
async function pollPrediction(url) {
  const maxAttempts = 60;
  let attempts = 0;

  while (attempts < maxAttempts) {
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${REPLICATE_API_TOKEN}` }
    });
    const data = await response.json();
    console.log(`[Poll] Status: ${data.status} (${attempts * 3}s elapsed)`);

    if (['succeeded', 'failed', 'canceled'].includes(data.status)) {
      return data;
    }

    attempts++;
    await new Promise(r => setTimeout(r, 3000));
  }

  throw new Error('Timed out after 3 minutes');
}

// Build professional hair transplant prompt for Nano Banana Pro
function buildHairPrompt(style, density, hairline) {
  const densityDesc = {
    low: 'with a subtle, natural-looking increase in hair density',
    medium: 'with moderate, natural hair density and good coverage',
    high: 'with thick, dense, full hair coverage'
  };

  const styleDesc = {
    natural: 'naturally distributed follicles with organic growth patterns',
    dense: 'dense, uniform hair coverage',
    subtle: 'subtle, barely noticeable improvement in hair thickness'
  };

  const hairlineDesc = {
    'age-appropriate': 'a natural, age-appropriate hairline',
    'youthful': 'a youthful, slightly lower hairline with full frontal coverage',
    'mature': 'a mature, dignified hairline'
  };

  return `Edit this photo to show a realistic hair transplant result. Add natural-looking hair to the balding or thinning areas of the scalp, ${densityDesc[density] || densityDesc.medium}, with ${styleDesc[style] || styleDesc.natural} and ${hairlineDesc[hairline] || hairlineDesc['age-appropriate']}. The new hair must perfectly match the existing hair color, texture, and direction. Keep EVERYTHING else in the photo EXACTLY the same — the face, skin, eyes, nose, mouth, ears, clothing, background, lighting, and angle must be completely unchanged and identical to the original. Only modify the hair and scalp area. The result should look like a real professional photograph taken after a successful hair transplant surgery, not AI-generated.`;
}

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Follica AI Server running on port ${PORT}`);
  console.log(`🍌 Model: Google Nano Banana Pro`);
  console.log(`📡 API Token: ${REPLICATE_API_TOKEN ? '✅ Configured' : '❌ Missing'}`);
  console.log(`🌐 Open: http://localhost:${PORT}\n`);
});
