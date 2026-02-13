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

// Step 1: Detect hair color using a vision model
async function detectHairColor(base64Image) {
  try {
    console.log('[HairColor] Detecting hair color...');

    // Sample the sides of the image to get average color
    // We'll use sharp to extract color info from the hair area
    const buffer = Buffer.from(base64Image.split(',')[1], 'base64');
    const metadata = await sharp(buffer).metadata();
    const w = metadata.width;
    const h = metadata.height;

    // Sample from left side (where hair usually is on sides)
    // Top 30% of image, left 20% and right 20%
    const sampleHeight = Math.round(h * 0.3);
    const sampleWidth = Math.round(w * 0.15);

    const leftSample = await sharp(buffer)
      .extract({ left: 0, top: 0, width: sampleWidth, height: sampleHeight })
      .resize(1, 1)
      .raw()
      .toBuffer();

    const rightSample = await sharp(buffer)
      .extract({ left: w - sampleWidth, top: 0, width: sampleWidth, height: sampleHeight })
      .resize(1, 1)
      .raw()
      .toBuffer();

    // Average the two samples
    const r = Math.round((leftSample[0] + rightSample[0]) / 2);
    const g = Math.round((leftSample[1] + rightSample[1]) / 2);
    const b = Math.round((leftSample[2] + rightSample[2]) / 2);

    // Determine hair color name from RGB
    const brightness = (r + g + b) / 3;
    const warmth = r - b; // positive = warm, negative = cool

    let color;
    if (brightness > 180) {
      color = warmth > 20 ? 'light blonde' : 'platinum blonde';
    } else if (brightness > 140) {
      color = warmth > 30 ? 'golden blonde' : 'light brown';
    } else if (brightness > 110) {
      color = warmth > 20 ? 'medium brown' : 'ash brown';
    } else if (brightness > 80) {
      color = warmth > 15 ? 'dark brown' : 'dark ash brown';
    } else if (brightness > 50) {
      color = warmth > 10 ? 'very dark brown' : 'black';
    } else {
      color = 'black';
    }

    // Check for red/auburn
    if (r > g * 1.3 && r > b * 1.5 && brightness > 60 && brightness < 160) {
      color = brightness > 100 ? 'auburn' : 'dark auburn';
    }

    // Check for gray
    if (Math.abs(r - g) < 15 && Math.abs(g - b) < 15 && brightness > 100 && brightness < 180) {
      color = 'gray';
    }

    console.log(`[HairColor] Detected: ${color} (RGB: ${r},${g},${b} brightness: ${brightness} warmth: ${warmth})`);
    return color;
  } catch (e) {
    console.log(`[HairColor] Detection failed: ${e.message}, using fallback`);
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
    const style = req.body.style || 'natural';
    const density = req.body.density || 'medium';
    const hairline = req.body.hairline || 'age-appropriate';
    const aspectRatio = await getAspectRatio(req.file.buffer);

    // Step 1: Detect hair color from the image
    const detectedColor = await detectHairColor(base64Image);
    console.log(`[Generate] Detected hair color: ${detectedColor}`);

    // Step 2: Build prompt with explicit hair color
    const prompt = buildHairPrompt(style, density, hairline, detectedColor);
    console.log(`[Generate] Aspect ratio: ${aspectRatio}`);
    console.log(`[Generate] Prompt: ${prompt}`);

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

    return res.status(500).json({
      error: 'The AI model is currently busy. Please try again in a moment.'
    });
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

function buildHairPrompt(style, density, hairline, hairColor) {
  const densityMap = {
    low: 'moderate',
    medium: 'full and thick',
    high: 'very thick and dense'
  };
  const density_text = densityMap[density] || densityMap.medium;

  const colorText = hairColor
    ? `The hair MUST be ${hairColor} colored — this is the exact color of their existing hair. Do NOT use any other color. Do NOT make it darker or lighter.`
    : `The hair must match the exact color of the person's existing hair on the sides of their head. Do NOT darken it.`;

  return `Give this person ${density_text} hair on top of their head. Fill in all bald and thinning areas completely — top, crown, temples, and front hairline. No bald spots remaining. ${colorText} Do NOT change their beard, facial hair, face, eyes, ears, skin, expression, clothing, or background. Do not rotate or flip the image. The hair should look natural and photorealistic.`;
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Follica AI Server running on port ${PORT}`);
  console.log(`🎯 Models: Flux Kontext Max > Flux Kontext Pro`);
  console.log(`🔍 Hair color detection: enabled (via sharp)`);
  console.log(`📡 API Token: ${REPLICATE_API_TOKEN ? '✅ Configured' : '❌ Missing'}`);
  console.log(`🌐 Open: http://localhost:${PORT}\n`);
});
