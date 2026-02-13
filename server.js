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

// Normalize image: fix EXIF rotation and get aspect ratio
async function normalizeImage(buffer, mimetype) {
  // sharp.rotate() with no args auto-rotates based on EXIF orientation
  const normalized = await sharp(buffer)
    .rotate()
    .jpeg({ quality: 92 })
    .toBuffer();

  const metadata = await sharp(normalized).metadata();
  const ratio = metadata.width / metadata.height;

  let aspectRatio;
  if (ratio > 1.6) aspectRatio = '16:9';
  else if (ratio > 1.3) aspectRatio = '3:2';
  else if (ratio > 1.1) aspectRatio = '4:3';
  else if (ratio > 0.9) aspectRatio = '1:1';
  else if (ratio > 0.7) aspectRatio = '3:4';
  else if (ratio > 0.55) aspectRatio = '2:3';
  else aspectRatio = '9:16';

  const base64 = `data:image/jpeg;base64,${normalized.toString('base64')}`;

  console.log(`[Normalize] ${metadata.width}x${metadata.height} ratio=${ratio.toFixed(2)} → ${aspectRatio}`);
  return { base64, aspectRatio };
}

const MODELS = [
  'black-forest-labs/flux-kontext-max',
  'black-forest-labs/flux-kontext-pro'
];

app.post('/api/generate', upload.single('image'), async (req, res) => {
  try {
    if (!REPLICATE_API_TOKEN) {
      return res.status(500).json({ error: 'API token not configured.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    const density = req.body.density || 'medium';

    // Normalize: fix EXIF rotation from mobile photos
    const { base64, aspectRatio } = await normalizeImage(req.file.buffer, req.file.mimetype);

    const prompt = buildHairPrompt(density);
    console.log(`[Generate] Aspect: ${aspectRatio}, Density: ${density}`);
    console.log(`[Generate] Prompt: ${prompt}`);

    for (const model of MODELS) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        console.log(`[Generate] ${model} attempt ${attempt}...`);
        try {
          const result = await runModel(model, base64, prompt, aspectRatio);
          if (result.success) {
            console.log(`[Generate] ✅ Success with ${model}!`);
            return res.json({ success: true, outputUrl: result.outputUrl, model });
          }
          console.log(`[Generate] ${model} failed: ${result.error}`);
        } catch (err) {
          console.log(`[Generate] ${model} error: ${err.message}`);
        }
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
      }
    }

    return res.status(500).json({ error: 'Model busy. Try again.' });
  } catch (error) {
    console.error('[Generate] Server error:', error.message);
    res.status(500).json({ error: 'Server error', detail: error.message });
  }
});

async function runModel(model, image, prompt, aspectRatio) {
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
        input_image: image,
        aspect_ratio: aspectRatio,
        safety_tolerance: 5,
        output_quality: 95
      }
    })
  });

  const prediction = await createResponse.json();
  console.log(`[${model}] HTTP ${createResponse.status} | Status: ${prediction.status || 'N/A'}`);

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

function buildHairPrompt(density) {
  const densityMap = {
    low: 'a natural amount of',
    medium: 'a full head of',
    high: 'thick, dense'
  };
  const d = densityMap[density] || densityMap.medium;

  return `Make this person have ${d} natural hair covering their entire head including the temples and hairline — no receding hairline, no bald spots, full coverage from forehead to crown. The hair should lay flat and neat, not sticking up, like a normal short-to-medium men's hairstyle. Same hair color, same beard, same ears, same everything else. Do not modify the ears at all.`;
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Follica AI Server running on port ${PORT}`);
  console.log(`🎯 Models: Flux Kontext Max > Flux Kontext Pro`);
  console.log(`📸 EXIF rotation fix: enabled`);
  console.log(`📡 API Token: ${REPLICATE_API_TOKEN ? '✅ Configured' : '❌ Missing'}`);
  console.log(`🌐 Open: http://localhost:${PORT}\n`);
});
