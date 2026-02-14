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
// ──────────────────────────────────────────────

async function detectHairColorRGB(raw, width, height) {
  const y1 = Math.round(height * 0.15);
  const y2 = Math.round(height * 0.40);
  const regions = [
    [Math.round(width * 0.02), Math.round(width * 0.18)],
    [Math.round(width * 0.82), Math.round(width * 0.98)]
  ];

  const pixels = [];
  for (let y = y1; y < y2; y++) {
    for (const [xs, xe] of regions) {
      for (let x = xs; x < xe; x++) {
        const idx = (y * width + x) * 3;
        const r = raw[idx], g = raw[idx+1], b = raw[idx+2];
        const br = (r + g + b) / 3;
        if (br > 15 && br < 100) pixels.push({ r, g, b, br });
      }
    }
  }

  if (pixels.length < 30) return null;

  pixels.sort((a, b) => a.br - b.br);
  const s = Math.round(pixels.length * 0.25);
  const e = Math.round(pixels.length * 0.75);
  const mid = pixels.slice(s, e);

  const avgR = Math.round(mid.reduce((s, p) => s + p.r, 0) / mid.length);
  const avgG = Math.round(mid.reduce((s, p) => s + p.g, 0) / mid.length);
  const avgB = Math.round(mid.reduce((s, p) => s + p.b, 0) / mid.length);

  console.log(`[HairColor] Detected RGB(${avgR},${avgG},${avgB}) from ${mid.length} pixels`);
  return { r: avgR, g: avgG, b: avgB };
}

function rgbToColorName(rgb) {
  if (!rgb) return null;
  const br = (rgb.r + rgb.g + rgb.b) / 3;
  const warmth = rgb.r - rgb.b;

  if (br > 150) return 'light blonde';
  if (br > 120) return warmth > 20 ? 'dark blonde' : 'light brown';
  if (br > 95) return warmth > 15 ? 'medium brown' : 'ash brown';
  if (br > 70) return 'brown';
  if (br > 45) return 'dark brown';
  return 'black';
}

// ──────────────────────────────────────────────
// ELLIPTICAL COMPOSITING + COLOR CORRECTION
//
// Creates a soft elliptical mask centered on the top of head.
// AI pixels are used inside the ellipse (scalp area).
// Original pixels are used outside (face, ears, beard, body).
// Smooth gaussian-like fade at the edge — no visible line.
//
// Before compositing, color-correct AI hair pixels to match
// original hair color detected from the sides.
// ──────────────────────────────────────────────

async function compositeWithEllipse(originalBuffer, aiBuffer, width, height, origHairRGB) {
  const aiResized = await sharp(aiBuffer)
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer();

  const originalRaw = await sharp(originalBuffer).raw().toBuffer();

  // Ellipse parameters — centered on top of head
  const cx = width / 2;
  const cy = height * 0.20;        // center near top of head
  const rx = width * 0.38;          // wide enough for temples
  const ry = height * 0.23;         // tall enough for crown
  const fadeWidth = 0.35;            // how wide the soft edge is (0-1, relative to radius)

  // Color correction: sample AI hair from top-center
  // No color correction — let the AI color stand as-is.
  // The elliptical composite protects face/beard/ears.
  let rAdj = 1, gAdj = 1, bAdj = 1;

  // Composite pixel by pixel
  const output = Buffer.alloc(width * height * 3);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;

      // Calculate distance from ellipse center (normalized 0-1 where 1 = on edge)
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Calculate blend weight (1 = full AI, 0 = full original)
      let aiWeight;
      if (dist <= 1.0 - fadeWidth) {
        aiWeight = 1.0; // inside ellipse core
      } else if (dist >= 1.0 + fadeWidth) {
        aiWeight = 0.0; // outside ellipse
      } else {
        // Smooth cosine fade in the transition zone
        const t = (dist - (1.0 - fadeWidth)) / (2 * fadeWidth);
        aiWeight = 0.5 + 0.5 * Math.cos(Math.PI * t);
      }

      // Get original pixel
      const oR = originalRaw[idx], oG = originalRaw[idx+1], oB = originalRaw[idx+2];

      // Get AI pixel (color-corrected if in hair zone)
      let aR = aiResized[idx], aG = aiResized[idx+1], aB = aiResized[idx+2];
      if (aiWeight > 0) {
        const br = (aR + aG + aB) / 3;
        // Only color-correct mid-tone pixels (actual hair, not very bright/dark)
        if (br > 30 && br < 200) {
          aR = Math.min(255, Math.round(aR * rAdj));
          aG = Math.min(255, Math.round(aG * gAdj));
          aB = Math.min(255, Math.round(aB * bAdj));
        }
      }

      // Blend
      const w2 = 1.0 - aiWeight;
      output[idx]     = Math.round(aR * aiWeight + oR * w2);
      output[idx + 1] = Math.round(aG * aiWeight + oG * w2);
      output[idx + 2] = Math.round(aB * aiWeight + oB * w2);
    }
  }

  return sharp(output, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 93 })
    .toBuffer();
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

    // Step 1: Normalize
    const { buffer: origBuffer, width, height } = await normalizeImage(req.file.buffer);
    const base64Image = `data:image/jpeg;base64,${origBuffer.toString('base64')}`;
    const aspectRatio = getAspectRatioString(width, height);

    // Step 2: Detect hair color
    const origRaw = await sharp(origBuffer).raw().toBuffer();
    const hairRGB = await detectHairColorRGB(origRaw, width, height);
    const hairName = rgbToColorName(hairRGB);

    // Step 3: Build prompt
    const prompt = buildPrompt(density);
    console.log(`[Generate] ${width}x${height}, Density: ${density}`);

    // Step 4: Generate with Kontext
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

    // Step 5: Download AI result
    let aiBuffer;
    try {
      const resp = await fetch(aiOutputUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      aiBuffer = Buffer.from(await resp.arrayBuffer());
    } catch (e) {
      console.log(`[Composite] Download failed, returning raw`);
      return res.json({ success: true, outputUrl: aiOutputUrl, model: usedModel });
    }

    // Step 6: Elliptical composite + color correction
    console.log(`[Composite] Elliptical blend + color correction...`);
    const finalBuffer = await compositeWithEllipse(origBuffer, aiBuffer, width, height, hairRGB);

    const finalBase64 = `data:image/jpeg;base64,${finalBuffer.toString('base64')}`;
    console.log(`[Generate] ✅ Done! ${usedModel} + composite`);

    return res.json({ success: true, outputUrl: finalBase64, model: usedModel });

  } catch (error) {
    console.error('[Generate] Error:', error.message, error.stack);
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

function buildPrompt(density) {
  const densityMap = {
    low: 'a natural amount of',
    medium: 'a full head of',
    high: 'thick, dense'
  };
  const d = densityMap[density] || densityMap.medium;
  return `Make this person have ${d} natural hair on top, laying flat and neat. Keep the exact same hair color as their existing hair. Do NOT change their face, eyes, nose, mouth, skin tone, beard, ears, or any facial features. Same person, same identity, same everything except more hair on top.`;
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Follica AI Server running on port ${PORT}`);
  console.log(`🎯 AI: Flux Kontext Max > Pro`);
  console.log(`🎨 Color: detect from sides → correct AI pixels`);
  console.log(`🎭 Composite: soft ellipse (no visible lines)`);
  console.log(`📸 EXIF fix: enabled`);
  console.log(`📡 Token: ${REPLICATE_API_TOKEN ? '✅' : '❌'}`);
  console.log(`🌐 http://localhost:${PORT}\n`);
});
