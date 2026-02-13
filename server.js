const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const sharp = require('sharp');

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
    timestamp: new Date().toISOString()
  });
});

const MODELS = [
  {
    id: 'black-forest-labs/flux-kontext-pro',
    imageField: 'input_image',
    extraParams: {}
  },
  {
    id: 'google/nano-banana-pro',
    imageField: 'image',
    extraParams: {}
  },
  {
    id: 'google/nano-banana',
    imageField: 'image',
    extraParams: {}
  }
];

async function getAspectRatio(buffer) {
  try {
    const metadata = await sharp(buffer).metadata();
    const ratio = metadata.width / metadata.height;
    if (ratio > 1.6) return '16:9';
    if (ratio > 1.3) return '3:2';
    if (ratio > 1.1) return '4:3';
    if (ratio > 0.9) return '1:1';
    if (ratio > 0.7) return '3:4';
    if (ratio > 0.55) return '2:3';
    return '9:16';
  } catch (e) {
    return '1:1';
  }
}

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
    const aspectRatio = await getAspectRatio(req.file.buffer);
    console.log(`[Generate] Aspect ratio: ${aspectRatio}`);

    for (const model of MODELS) {
      console.log(`[Generate] Trying ${model.id}...`);
      try {
        const result = await runModel(model, base64Image, prompt, aspectRatio);
        if (result.success) {
          console.log(`[Generate] Success with ${model.id}!`);
          return res.json({ success: true, outputUrl: result.outputUrl, model: model.id });
        }
        console.log(`[Generate] ${model.id} failed: ${result.error}`);
      } catch (err) {
        console.log(`[Generate] ${model.id} error: ${err.message}`);
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

async function runModel(model, image, prompt, aspectRatio) {
  const inputPayload = {
    prompt: prompt,
    [model.imageField]: image,
    aspect_ratio: aspectRatio,
    ...model.extraParams
  };

  const createResponse = await fetch(`https://api.replicate.com/v1/models/${model.id}/predictions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait=60'
    },
    body: JSON.stringify({ input: inputPayload })
  });

  const prediction = await createResponse.json();
  console.log(`[${model.id}] HTTP ${createResponse.status} | Status: ${prediction.status || 'N/A'}`);

  if (!createResponse.ok) {
    return { success: false, error: prediction.detail || JSON.stringify(prediction).substring(0, 200) };
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
    if (['succeeded', 'failed', 'canceled'].includes(data.status)) return data;
    attempts++;
    await new Promise(r => setTimeout(r, 3000));
  }
  return { status: 'failed', error: 'Timed out' };
}

function buildHairPrompt(style, density, hairline) {
  const densityDesc = {
    low: 'slightly thicker hair',
    medium: 'noticeably fuller hair with good natural coverage',
    high: 'a full thick head of hair with maximum natural density'
  };
  const hairlineDesc = {
    'age-appropriate': '',
    'youthful': ' with a lower, more youthful hairline',
    'mature': ' keeping the mature hairline shape'
  };

  return `Keep this exact same person, same face, same expression, same skin, same ears, same beard, same facial hair, same clothing, same background, same lighting, same camera angle, same image orientation. The ONLY change: give them ${densityDesc[density] || densityDesc.medium} on the balding/thinning areas on TOP of their head/scalp${hairlineDesc[hairline] || ''}. CRITICAL RULES: 1) The new hair must be the EXACT SAME COLOR, tone, shade, and texture as the person's existing hair — match their current hair color precisely, do not darken it, lighten it, or change it in any way. 2) Do NOT modify the ears, beard, mustache, facial hair, sideburns, eyebrows, forehead shape, face shape, jawline, or any facial feature — all must remain completely untouched and identical to the original. 3) ONLY add hair to the TOP of the head where there is balding or thinning — do not touch anything below the forehead. 4) The hair must look like real natural human hair with natural volume, natural strands, slight imperfections, and realistic scalp visibility — not a wig, not artificial, as if photographed after a real hair transplant. 5) Keep the exact same photo orientation, do not rotate or flip the image.`;
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Follica AI Server running on port ${PORT}`);
  console.log(`🎯 Models: Flux Kontext Pro > Nano Banana Pro > Nano Banana`);
  console.log(`📡 API Token: ${REPLICATE_API_TOKEN ? '✅ Configured' : '❌ Missing'}`);
  console.log(`🌐 Open: http://localhost:${PORT}\n`);
});
