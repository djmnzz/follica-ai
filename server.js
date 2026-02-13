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
// COLOR SAMPLING
// Sample average hair color from the sides of the original image
// (where existing hair is) — rows 20-35%, left 5-15% and right 85-95%
// ──────────────────────────────────────────────
async function sampleHairColor(rawBuffer, width, height) {
  const y1 = Math.round(height * 0.20);
  const y2 = Math.round(height * 0.35);
  const xLeftStart = Math.round(width * 0.03);
  const xLeftEnd = Math.round(width * 0.15);
  const xRightStart = Math.round(width * 0.85);
  const xRightEnd = Math.round(width * 0.97);

  let rSum = 0, gSum = 0, bSum = 0, count = 0;

  for (let y = y1; y < y2; y++) {
    // Left side
    for (let x = xLeftStart; x < xLeftEnd; x++) {
      const idx = (y * width + x) * 3;
      rSum += rawBuffer[idx];
      gSum += rawBuffer[idx + 1];
      bSum += rawBuffer[idx + 2];
      count++;
    }
    // Right side
    for (let x = xRightStart; x < xRightEnd; x++) {
      const idx = (y * width + x) * 3;
      rSum += rawBuffer[idx];
      gSum += rawBuffer[idx + 1];
      bSum += rawBuffer[idx + 2];
      count++;
    }
  }

  return {
    r: Math.round(rSum / count),
    g: Math.round(gSum / count),
    b: Math.round(bSum / count)
  };
}

// Sample the color of the AI-generated hair from the top-center area
async function sampleAIHairColor(rawBuffer, width, height) {
  const y1 = Math.round(height * 0.05);
  const y2 = Math.round(height * 0.25);
  const xStart = Math.round(width * 0.25);
  const xEnd = Math.round(width * 0.75);

  let rSum = 0, gSum = 0, bSum = 0, count = 0;

  for (let y = y1; y < y2; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const idx = (y * width + x) * 3;
      rSum += rawBuffer[idx];
      gSum += rawBuffer[idx + 1];
      bSum += rawBuffer[idx + 2];
      count++;
    }
  }

  return {
    r: Math.round(rSum / count),
    g: Math.round(gSum / count),
    b: Math.round(bSum / count)
  };
}

// ──────────────────────────────────────────────
// PIXEL-LEVEL COMPOSITING WITH COLOR CORRECTION
// 1. Sample original hair color from sides
// 2. Sample AI hair color from top
// 3. Calculate color shift needed
// 4. Apply shift to AI pixels in hair zone
// 5. Blend: top = color-corrected AI, bottom = original
// ──────────────────────────────────────────────
async function compositeHairOnly(originalBuffer, aiBuffer, width, height) {
  const aiResized = await sharp(aiBuffer)
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer();

  const originalRaw = await sharp(originalBuffer)
    .raw()
    .toBuffer();

  // Sample colors
  const origColor = await sampleHairColor(originalRaw, width, height);
  const aiColor = await sampleAIHairColor(aiResized, width, height);

  // Calculate color correction (shift AI color toward original)
  // Use a ratio-based approach for more natural correction
  const rRatio = origColor.r / Math.max(aiColor.r, 1);
  const gRatio = origColor.g / Math.max(aiColor.g, 1);
  const bRatio = origColor.b / Math.max(aiColor.b, 1);

  // Clamp ratios to avoid extreme corrections (max 50% shift)
  const clampRatio = (r) => Math.max(0.6, Math.min(1.5, r));
  const rAdj = clampRatio(rRatio);
  const gAdj = clampRatio(gRatio);
  const bAdj = clampRatio(bRatio);

  console.log(`[Color] Original hair: RGB(${origColor.r},${origColor.g},${origColor.b})`);
  console.log(`[Color] AI hair: RGB(${aiColor.r},${aiColor.g},${aiColor.b})`);
  console.log(`[Color] Correction ratios: R=${rAdj.toFixed(2)} G=${gAdj.toFixed(2)} B=${bAdj.toFixed(2)}`);

  // Composite with color correction
  const pixels = width * height * 3;
  const output = Buffer.alloc(pixels);

  const blendStart = Math.round(height * 0.30);
  const blendEnd = Math.round(height * 0.45);
  const blendRange = blendEnd - blendStart;

  for (let y = 0; y < height; y++) {
    let aiWeight;
    if (y < blendStart) {
      aiWeight = 1.0;
    } else if (y >= blendEnd) {
      aiWeight = 0.0;
    } else {
      const t = (y - blendStart) / blendRange;
      aiWeight = 0.5 + 0.5 * Math.cos(Math.PI * t);
    }

    const origWeight = 1.0 - aiWeight;

    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;

      // Color-correct the AI pixels (only where aiWeight > 0)
      let aiR = aiResized[idx];
      let aiG = aiResized[idx + 1];
      let aiB = aiResized[idx + 2];

      if (aiWeight > 0) {
        // Only color-correct darker pixels (likely hair, not background/skin)
        const brightness = (aiR + aiG + aiB) / 3;
        if (brightness < 180) { // skip very bright pixels (background, skin highlights)
          aiR = Math.min(255, Math.round(aiR * rAdj));
          aiG = Math.min(255, Math.round(aiG * gAdj));
          aiB = Math.min(255, Math.round(aiB * bAdj));
        }
      }

      output[idx]     = Math.round(aiR * aiWeight + originalRaw[idx]     * origWeight);
      output[idx + 1] = Math.round(aiG * aiWeight + originalRaw[idx + 1] * origWeight);
      output[idx + 2] = Math.round(aiB * aiWeight + originalRaw[idx + 2] * origWeight);
    }
  }

  return sharp(output, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 93 })
    .toBuffer();
}

// ──────────────────────────────────────────────
// AI MODEL INTERACTION
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
    const { buffer: originalBuffer, width, height } = await normalizeImage(req.file.buffer);
    const base64Image = `data:image/jpeg;base64,${originalBuffer.toString('base64')}`;
    const aspectRatio = getAspectRatioString(width, height);

    const prompt = buildPrompt(density);
    console.log(`[Generate] ${width}x${height} (${aspectRatio}), Density: ${density}`);

    // Step 2: Generate with Flux Kontext
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

    // Step 3: Download AI result
    console.log(`[Composite] Downloading AI result...`);
    let aiBuffer;
    try {
      const aiResponse = await fetch(aiOutputUrl);
      if (!aiResponse.ok) throw new Error(`HTTP ${aiResponse.status}`);
      aiBuffer = Buffer.from(await aiResponse.arrayBuffer());
      console.log(`[Composite] Downloaded ${aiBuffer.length} bytes`);
    } catch (dlErr) {
      console.log(`[Composite] Download failed, returning raw URL`);
      return res.json({ success: true, outputUrl: aiOutputUrl, model: usedModel });
    }

    // Step 4: Color-correct + Composite
    console.log(`[Composite] Color correcting and blending...`);
    const finalBuffer = await compositeHairOnly(originalBuffer, aiBuffer, width, height);

    // Step 5: Return as base64
    const finalBase64 = `data:image/jpeg;base64,${finalBuffer.toString('base64')}`;
    console.log(`[Generate] ✅ Done! ${usedModel} + color-corrected composite`);

    return res.json({
      success: true,
      outputUrl: finalBase64,
      model: usedModel
    });

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
  return `Make this person have ${d} natural hair on top. Same hair color, same beard, same everything else.`;
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Follica AI Server running on port ${PORT}`);
  console.log(`🎯 AI: Flux Kontext Max > Pro`);
  console.log(`🎨 Color correction: sample sides → match AI hair`);
  console.log(`🎭 Composite: top=AI hair, bottom=original photo`);
  console.log(`📸 EXIF fix: enabled`);
  console.log(`📡 Token: ${REPLICATE_API_TOKEN ? '✅' : '❌'}`);
  console.log(`🌐 http://localhost:${PORT}\n`);
});
