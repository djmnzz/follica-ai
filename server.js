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

// Detect hair color by sampling the sides of the head area
async function detectHairColor(base64Image) {
  try {
    const buffer = Buffer.from(base64Image.split(',')[1], 'base64');
    const metadata = await sharp(buffer).metadata();
    const w = metadata.width;
    const h = metadata.height;

    // Sample from the sides of the head: 20-35% from top, far left and far right edges
    // This is where hair on the sides typically is in a portrait/selfie
    const topOffset = Math.round(h * 0.2);
    const sampleH = Math.round(h * 0.15);
    const sampleW = Math.round(w * 0.1);

    // Left side hair
    const leftSample = await sharp(buffer)
      .extract({ left: Math.round(w * 0.05), top: topOffset, width: sampleW, height: sampleH })
      .resize(1, 1)
      .raw()
      .toBuffer();

    // Right side hair
    const rightSample = await sharp(buffer)
      .extract({ left: w - sampleW - Math.round(w * 0.05), top: topOffset, width: sampleW, height: sampleH })
      .resize(1, 1)
      .raw()
      .toBuffer();

    // Also sample from slightly lower on sides (ear level) where hair is more visible
    const midOffset = Math.round(h * 0.3);
    const leftMid = await sharp(buffer)
      .extract({ left: Math.round(w * 0.03), top: midOffset, width: sampleW, height: sampleH })
      .resize(1, 1)
      .raw()
      .toBuffer();

    const rightMid = await sharp(buffer)
      .extract({ left: w - sampleW - Math.round(w * 0.03), top: midOffset, width: sampleW, height: sampleH })
      .resize(1, 1)
      .raw()
      .toBuffer();

    // Average all 4 samples — pick the darkest two (more likely to be hair, not background)
    const samples = [
      { r: leftSample[0], g: leftSample[1], b: leftSample[2] },
      { r: rightSample[0], g: rightSample[1], b: rightSample[2] },
      { r: leftMid[0], g: leftMid[1], b: leftMid[2] },
      { r: rightMid[0], g: rightMid[1], b: rightMid[2] }
    ];

    // Sort by brightness, take the 2 darkest (most likely hair, not background)
    samples.sort((a, b) => (a.r + a.g + a.b) - (b.r + b.g + b.b));
    const hairSamples = samples.slice(0, 2);

    const r = Math.round(hairSamples.reduce((s, p) => s + p.r, 0) / 2);
    const g = Math.round(hairSamples.reduce((s, p) => s + p.g, 0) / 2);
    const b2 = Math.round(hairSamples.reduce((s, p) => s + p.b, 0) / 2);

    const brightness = (r + g + b2) / 3;
    const warmth = r - b2;

    let color;
    if (brightness > 170) {
      color = 'light blonde';
    } else if (brightness > 140) {
      color = warmth > 25 ? 'golden blonde' : 'dirty blonde';
    } else if (brightness > 115) {
      color = warmth > 20 ? 'light brown' : 'light ash brown';
    } else if (brightness > 90) {
      color = warmth > 15 ? 'medium brown' : 'medium ash brown';
    } else if (brightness > 65) {
      color = warmth > 10 ? 'dark brown' : 'dark brown';
    } else {
      color = 'very dark brown';
    }

    // Check for red/auburn
    if (r > g * 1.3 && r > b2 * 1.4 && brightness > 55 && brightness < 150) {
      color = brightness > 100 ? 'auburn' : 'dark auburn';
    }

    // Check for gray
    if (Math.abs(r - g) < 12 && Math.abs(g - b2) < 12 && brightness > 90 && brightness < 170) {
      color = brightness > 130 ? 'light gray' : 'salt and pepper gray';
    }

    console.log(`[HairColor] Detected: ${color} (RGB avg: ${r},${g},${b2} brightness: ${Math.round(brightness)} warmth: ${Math.round(warmth)})`);
    return color;
  } catch (e) {
    console.log(`[HairColor] Detection failed: ${e.message}`);
    return null;
  }
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

    const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const density = req.body.density || 'medium';
    const aspectRatio = await getAspectRatio(req.file.buffer);

    const detectedColor = await detectHairColor(base64Image);
    const prompt = buildHairPrompt(density, detectedColor);

    console.log(`[Generate] Color: ${detectedColor}, Aspect: ${aspectRatio}`);

    for (const model of MODELS) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        console.log(`[Generate] ${model} attempt ${attempt}...`);
        try {
          const result = await runModel(model, base64Image, prompt, aspectRatio);
          if (result.success) {
            console.log(`[Generate] ✅ Success with ${model}!`);
            return res.json({ success: true, outputUrl: result.outputUrl, model, detectedColor });
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

function buildHairPrompt(density, hairColor) {
  const densityMap = {
    low: 'moderate',
    medium: 'full and thick',
    high: 'very thick and dense'
  };
  const d = densityMap[density] || densityMap.medium;

  const colorInstruction = hairColor
    ? `The new hair color MUST be ${hairColor}. This is non-negotiable — do NOT use black hair, do NOT use dark brown hair unless that is the specified color.`
    : `Match the hair color to whatever color the person's existing hair is.`;

  return `Add ${d} hair on top of this person's head covering all bald and thinning areas — top, crown, temples, and front. No bald spots remaining. ${colorInstruction} IMPORTANT: Do NOT change the beard AT ALL. The beard must stay EXACTLY as it is — same length, same thickness, same patchiness, same color. Do not fill in the beard, do not make it thicker, do not darken it. Leave ALL facial hair completely untouched. Also keep same face, eyes, ears, skin, glasses, clothing, background. Do not rotate the image.`;
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Follica AI Server running on port ${PORT}`);
  console.log(`🎯 Models: Flux Kontext Max > Flux Kontext Pro`);
  console.log(`🔍 Hair color detection: enabled`);
  console.log(`📡 API Token: ${REPLICATE_API_TOKEN ? '✅ Configured' : '❌ Missing'}`);
  console.log(`🌐 Open: http://localhost:${PORT}\n`);
});
