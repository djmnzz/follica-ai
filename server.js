const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'), false);
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasApiKey: !!REPLICATE_API_TOKEN,
    models: ['google/nano-banana-pro', 'google/nano-banana'],
    timestamp: new Date().toISOString()
  });
});

const MODELS = [
  'google/nano-banana-pro',
  'google/nano-banana'
];

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

    for (const model of MODELS) {
      console.log(`[Generate] Trying ${model}...`);

      try {
        const result = await runModel(model, base64Image, prompt);
        if (result.success) {
          console.log(`[Generate] Success with ${model}!`);
          return res.json({ success: true, outputUrl: result.outputUrl, model });
        }
        console.log(`[Generate] ${model} failed: ${result.error} — trying next...`);
      } catch (err) {
        console.log(`[Generate] ${model} error: ${err.message} — trying next...`);
      }
    }

    return res.status(500).json({
      error: 'All models are currently unavailable. Please try again in a few minutes.'
    });

  } catch (error) {
    console.error('[Generate] Server error:', error.message);
    res.status(500).json({ error: 'Server error', detail: error.message });
  }
});

async function runModel(model, image, prompt) {
  const createResponse = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait=60'
    },
    body: JSON.stringify({
      input: {
        prompt: prompt,
        image: image
      }
    })
  });

  const prediction = await createResponse.json();
  console.log(`[${model}] Status: ${createResponse.status}, prediction: ${prediction.status || 'N/A'}`);

  if (!createResponse.ok) {
    return { success: false, error: prediction.detail || JSON.stringify(prediction) };
  }

  if (prediction.status === 'succeeded' && prediction.output) {
    const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    return { success: true, outputUrl };
  }

  if (prediction.status === 'failed') {
    return { success: false, error: prediction.error || 'Model failed' };
  }

  if (prediction.id) {
    const pollUrl = prediction.urls?.get || `https://api.replicate.com/v1/predictions/${prediction.id}`;
    const result = await pollPrediction(pollUrl);

    if (result.status === 'succeeded' && result.output) {
      const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output;
      return { success: true, outputUrl };
    }
    return { success: false, error: result.error || 'Generation failed' };
  }

  return { success: false, error: 'Unexpected response' };
}

async function pollPrediction(url) {
  const maxAttempts = 40;
  let attempts = 0;

  while (attempts < maxAttempts) {
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${REPLICATE_API_TOKEN}` }
    });
    const data = await response.json();
    console.log(`[Poll] ${data.status} (${attempts * 3}s)`);

    if (['succeeded', 'failed', 'canceled'].includes(data.status)) {
      return data;
    }

    attempts++;
    await new Promise(r => setTimeout(r, 3000));
  }

  return { status: 'failed', error: 'Timed out' };
}

function buildHairPrompt(style, density, hairline) {
  const densityDesc = {
    low: 'slightly more hair',
    medium: 'noticeably more hair with good coverage',
    high: 'a full thick head of hair'
  };
  const hairlineDesc = {
    'age-appropriate': '',
    'youthful': 'with a lower, more youthful hairline',
    'mature': 'maintaining a mature hairline'
  };

  return `This is a photo of a person with hair loss. Make ONLY ONE change: add ${densityDesc[density] || densityDesc.medium} on top of their head ${hairlineDesc[hairline] || ''}. The hair must match their existing hair color and texture exactly. DO NOT change ANYTHING else. The person's face, expression, skin, eyes, nose, mouth, jaw, ears, neck, body, clothing, and background must remain PIXEL-PERFECT IDENTICAL to the input photo. Do not change the person's age, weight, or any facial features. Do not change the camera angle or lighting. Only add hair to the bald/thinning areas of the scalp.`;
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Follica AI Server running on port ${PORT}`);
  console.log(`🍌 Models: Nano Banana Pro → Nano Banana (fallback)`);
  console.log(`📡 API Token: ${REPLICATE_API_TOKEN ? '✅ Configured' : '❌ Missing'}`);
  console.log(`🌐 Open: http://localhost:${PORT}\n`);
});
