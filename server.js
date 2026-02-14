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

// ──────────────────────────────────────────────
// IMAGE UTILITIES
// ──────────────────────────────────────────────

async function normalizeImage(buffer) {
  const normalized = await sharp(buffer).rotate().jpeg({ quality: 93 }).toBuffer();
  const metadata = await sharp(normalized).metadata();
  return { buffer: normalized, width: metadata.width, height: metadata.height };
}

function getAspectRatioString(w, h) {
  const ratio = w / h;
  if (ratio > 1.6) return '16:9';
  if (ratio > 1.3) return '3:2';
  if (ratio > 1.1) return '4:3';
  if (ratio > 0.9) return '1:1';
  if (ratio > 0.7) return '3:4';
  if (ratio > 0.55) return '2:3';
  return '9:16';
}

// ──────────────────────────────────────────────
// HAIR COLOR DETECTION
// Sample dark pixels from sides of image (where hair is)
// Filter out bright pixels (background, windows, skin)
// ──────────────────────────────────────────────
async function detectHairColor(buffer, width, height) {
  const raw = await sharp(buffer).raw().toBuffer();

  const y1 = Math.round(height * 0.15);
  const y2 = Math.round(height * 0.40);
  const xLeftStart = Math.round(width * 0.02);
  const xLeftEnd = Math.round(width * 0.18);
  const xRightStart = Math.round(width * 0.82);
  const xRightEnd = Math.round(width * 0.98);

  const pixels = [];

  for (let y = y1; y < y2; y++) {
    const scanRegions = [
      [xLeftStart, xLeftEnd],
      [xRightStart, xRightEnd]
    ];
    for (const [xs, xe] of scanRegions) {
      for (let x = xs; x < xe; x++) {
        const idx = (y * width + x) * 3;
        const r = raw[idx], g = raw[idx+1], b = raw[idx+2];
        const brightness = (r + g + b) / 3;
        // Hair pixels: not too bright (skin/background) not too dark (pure black areas)
        if (brightness > 25 && brightness < 160) {
          pixels.push({ r, g, b, brightness });
        }
      }
    }
  }

  if (pixels.length < 30) {
    console.log(`[HairColor] Only ${pixels.length} hair pixels, can't determine color`);
    return null;
  }

  // Sort by brightness, take the middle 50% (avoid outliers)
  pixels.sort((a, b) => a.brightness - b.brightness);
  const start = Math.round(pixels.length * 0.25);
  const end = Math.round(pixels.length * 0.75);
  const middle = pixels.slice(start, end);

  const avgR = Math.round(middle.reduce((s, p) => s + p.r, 0) / middle.length);
  const avgG = Math.round(middle.reduce((s, p) => s + p.g, 0) / middle.length);
  const avgB = Math.round(middle.reduce((s, p) => s + p.b, 0) / middle.length);
  const avgBrightness = (avgR + avgG + avgB) / 3;
  const warmth = avgR - avgB;

  // Map to natural hair color name
  let colorName;
  if (avgBrightness > 150) {
    colorName = 'light blonde';
  } else if (avgBrightness > 120) {
    colorName = warmth > 20 ? 'dark blonde' : 'light ash brown';
  } else if (avgBrightness > 95) {
    colorName = warmth > 15 ? 'medium brown' : 'medium ash brown';
  } else if (avgBrightness > 70) {
    colorName = warmth > 10 ? 'brown' : 'dark brown';
  } else if (avgBrightness > 45) {
    colorName = 'very dark brown';
  } else {
    colorName = 'black';
  }

  // Check for reddish
  if (avgR > avgG * 1.25 && avgR > avgB * 1.4 && avgBrightness > 50 && avgBrightness < 140) {
    colorName = avgBrightness > 95 ? 'auburn' : 'dark auburn';
  }

  // Check for gray
  if (Math.abs(avgR - avgG) < 10 && Math.abs(avgG - avgB) < 10 && avgBrightness > 80 && avgBrightness < 160) {
    colorName = 'gray';
  }

  console.log(`[HairColor] Detected: ${colorName} (RGB: ${avgR},${avgG},${avgB} brightness: ${Math.round(avgBrightness)} warmth: ${Math.round(warmth)} from ${middle.length} pixels)`);
  return colorName;
}

// ──────────────────────────────────────────────
// AI MODELS
// ──────────────────────────────────────────────

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

    // Step 1: Normalize (fix EXIF rotation)
    const { buffer: normalizedBuffer, width, height } = await normalizeImage(req.file.buffer);
    const base64Image = `data:image/jpeg;base64,${normalizedBuffer.toString('base64')}`;
    const aspectRatio = getAspectRatioString(width, height);

    // Step 2: Detect hair color from original photo
    const hairColor = await detectHairColor(normalizedBuffer, width, height);

    // Step 3: Build prompt with detected color
    const prompt = buildPrompt(density, hairColor);
    console.log(`[Generate] ${width}x${height} (${aspectRatio}), Color: ${hairColor}`);
    console.log(`[Generate] Prompt: ${prompt}`);

    // Step 4: Generate
    let aiOutputUrl = null;
    let usedModel = null;

    for (const model of MODELS) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        console.log(`[Generate] ${model} attempt ${attempt}...`);
        try {
          const result = await runModel(model, base64Image, prompt, aspectRatio);
          if (result.success) {
            aiOutputUrl = result.outputUrl;
            usedModel = model;
            break;
          }
          console.log(`[Generate] failed: ${result.error}`);
        } catch (err) {
          console.log(`[Generate] error: ${err.message}`);
        }
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
      }
      if (aiOutputUrl) break;
    }

    if (!aiOutputUrl) {
      return res.status(500).json({ error: 'AI models busy. Try again.' });
    }

    console.log(`[Generate] ✅ Done with ${usedModel}`);
    return res.json({ success: true, outputUrl: aiOutputUrl, model: usedModel, hairColor });

  } catch (error) {
    console.error('[Generate] Error:', error.message);
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

// ──────────────────────────────────────────────
// PROMPT BUILDING
// Short + specific. Include detected hair color directly.
// ──────────────────────────────────────────────
function buildPrompt(density, hairColor) {
  const densityMap = {
    low: 'a natural amount of',
    medium: 'a full head of',
    high: 'thick, dense'
  };
  const d = densityMap[density] || densityMap.medium;

  // If we detected a color, specify it explicitly
  const colorPart = hairColor
    ? `The hair must be ${hairColor} — NOT black, NOT darker than the original.`
    : `Same hair color as existing hair — NOT darker.`;

  return `Make this person have ${d} natural hair on top, laying flat and neat. ${colorPart} Same beard, same face, same everything else.`;
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Follica AI Server running on port ${PORT}`);
  console.log(`🎯 AI: Flux Kontext Max > Pro`);
  console.log(`🎨 Hair color detection: smart pixel sampling (dark pixels only)`);
  console.log(`📸 EXIF fix: enabled`);
  console.log(`📡 Token: ${REPLICATE_API_TOKEN ? '✅' : '❌'}`);
  console.log(`🌐 http://localhost:${PORT}\n`);
});
