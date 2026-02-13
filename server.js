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

// Fix EXIF rotation and return normalized buffer + metadata
async function normalizeImage(buffer) {
  const normalized = await sharp(buffer).rotate().jpeg({ quality: 92 }).toBuffer();
  const metadata = await sharp(normalized).metadata();
  return { buffer: normalized, width: metadata.width, height: metadata.height };
}

// Generate a mask image: white on top (area to inpaint = hair), black on bottom (preserve)
// The mask covers roughly the top 45% of the image with a soft oval shape
// to target the scalp/hair area while leaving face, ears, beard untouched
async function generateHairMask(width, height) {
  // Create an SVG mask with an ellipse covering the top of the head
  // The ellipse is wide and positioned in the upper portion
  const centerX = Math.round(width / 2);
  const centerY = Math.round(height * 0.18); // higher up to avoid ears
  const radiusX = Math.round(width * 0.35);  // slightly narrower to avoid ears on sides
  const radiusY = Math.round(height * 0.22); // shorter to stay above ear level

  const svgMask = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="black"/>
      <ellipse cx="${centerX}" cy="${centerY}" rx="${radiusX}" ry="${radiusY}" fill="white"/>
    </svg>
  `;

  const maskBuffer = await sharp(Buffer.from(svgMask))
    .jpeg({ quality: 90 })
    .toBuffer();

  return maskBuffer;
}

// Models to try: flux-fill-pro first (best inpainting), then flux-fill-dev as fallback
const FILL_MODELS = [
  'black-forest-labs/flux-fill-pro',
  'black-forest-labs/flux-fill-dev'
];

// Fallback: flux-kontext if fill models fail
const KONTEXT_MODELS = [
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

    // Step 1: Normalize image (fix EXIF rotation)
    const { buffer: imgBuffer, width, height } = await normalizeImage(req.file.buffer);
    const base64Image = `data:image/jpeg;base64,${imgBuffer.toString('base64')}`;

    // Step 2: Generate mask (white = area to fill with hair)
    const maskBuffer = await generateHairMask(width, height);
    const base64Mask = `data:image/jpeg;base64,${maskBuffer.toString('base64')}`;

    console.log(`[Generate] Image: ${width}x${height}, Density: ${density}`);

    // Step 3: Try flux-fill models (with mask - guarantees face/beard/ears untouched)
    const fillPrompt = buildFillPrompt(density);
    console.log(`[Generate] Fill prompt: ${fillPrompt}`);

    for (const model of FILL_MODELS) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        console.log(`[Generate] ${model} attempt ${attempt}...`);
        try {
          const result = await runFillModel(model, base64Image, base64Mask, fillPrompt);
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

    // Step 4: Fallback to kontext (no mask, but better than nothing)
    console.log('[Generate] Fill models failed, trying Kontext fallback...');
    const kontextPrompt = buildKontextPrompt(density);
    const ratio = width / height;
    let aspectRatio = '1:1';
    if (ratio > 1.6) aspectRatio = '16:9';
    else if (ratio > 1.3) aspectRatio = '3:2';
    else if (ratio > 1.1) aspectRatio = '4:3';
    else if (ratio > 0.9) aspectRatio = '1:1';
    else if (ratio > 0.7) aspectRatio = '3:4';
    else if (ratio > 0.55) aspectRatio = '2:3';
    else aspectRatio = '9:16';

    for (const model of KONTEXT_MODELS) {
      try {
        const result = await runKontextModel(model, base64Image, kontextPrompt, aspectRatio);
        if (result.success) {
          console.log(`[Generate] ✅ Fallback success with ${model}!`);
          return res.json({ success: true, outputUrl: result.outputUrl, model });
        }
      } catch (err) {
        console.log(`[Generate] ${model} fallback error: ${err.message}`);
      }
    }

    return res.status(500).json({ error: 'All models busy. Please try again.' });
  } catch (error) {
    console.error('[Generate] Server error:', error.message);
    res.status(500).json({ error: 'Server error', detail: error.message });
  }
});

async function runFillModel(model, image, mask, prompt) {
  const input = {
    image: image,
    mask: mask,
    prompt: prompt,
    output_quality: 95
  };

  // flux-fill-dev uses different params than pro
  if (model.includes('dev')) {
    input.guidance = 30;
    input.num_inference_steps = 30;
  }

  const createResponse = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait=90'
    },
    body: JSON.stringify({ input })
  });

  const prediction = await createResponse.json();
  console.log(`[${model}] HTTP ${createResponse.status} | Status: ${prediction.status || 'N/A'}`);

  if (!createResponse.ok) {
    return { success: false, error: prediction.detail || JSON.stringify(prediction).substring(0, 300) };
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

async function runKontextModel(model, image, prompt, aspectRatio) {
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
  if (!createResponse.ok) {
    return { success: false, error: prediction.detail || 'API error' };
  }

  if (prediction.status === 'succeeded' && prediction.output) {
    const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    return { success: true, outputUrl };
  }

  if (prediction.id) {
    const pollUrl = prediction.urls?.get || `https://api.replicate.com/v1/predictions/${prediction.id}`;
    const result = await pollPrediction(pollUrl);
    if (result.status === 'succeeded' && result.output) {
      const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output;
      return { success: true, outputUrl };
    }
    return { success: false, error: result.error || 'Failed' };
  }

  return { success: false, error: 'Unexpected' };
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

function buildFillPrompt(density) {
  const densityMap = {
    low: 'natural, moderate',
    medium: 'full, thick',
    high: 'very thick, dense'
  };
  const d = densityMap[density] || densityMap.medium;
  // For inpainting, describe ONLY what should fill the masked area
  return `${d} natural men's hair, laying flat and neat, not sticking up. The hair color MUST be exactly the same shade as the existing hair on the sides — do NOT darken it, do NOT make it black or dark brown unless the original is that color. Do NOT add, reveal, or modify any ears. Natural realistic hairline with full coverage at the temples. Photorealistic.`;
}

function buildKontextPrompt(density) {
  const densityMap = {
    low: 'a natural amount of',
    medium: 'a full head of',
    high: 'thick, dense'
  };
  const d = densityMap[density] || densityMap.medium;
  return `Make this person have ${d} natural hair covering their entire head including the temples and hairline — no receding hairline, no bald spots, full coverage from forehead to crown. The hair should lay flat and neat, not sticking up, like a normal short-to-medium men's hairstyle. Same hair color, same beard, same everything else. If ears are not visible in the photo, do NOT add or reveal ears — keep them hidden.`;
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Follica AI Server running on port ${PORT}`);
  console.log(`🎯 Primary: Flux Fill Pro/Dev (masked inpainting)`);
  console.log(`🔄 Fallback: Flux Kontext Max/Pro`);
  console.log(`📸 EXIF rotation fix: enabled`);
  console.log(`🎭 Auto-mask: top-of-head ellipse`);
  console.log(`📡 API Token: ${REPLICATE_API_TOKEN ? '✅ Configured' : '❌ Missing'}`);
  console.log(`🌐 Open: http://localhost:${PORT}\n`);
});
