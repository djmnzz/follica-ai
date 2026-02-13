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
    
    // Aquí llamamos a nuestro nuevo prompt optimizado
    const prompt = buildHairPrompt(style, density, hairline);
    
    const aspectRatio = await getAspectRatio(req.file.buffer);
    console.log(`[Generate] Aspect ratio: ${aspectRatio}`);

    // Try Flux Kontext Pro up to 3 times
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[Generate] Attempt ${attempt}/${maxRetries} with Flux Kontext Pro...`);

      try {
        const result = await runFluxKontext(base64Image, prompt, aspectRatio);
        if (result.success) {
          console.log(`[Generate] ✅ Success on attempt ${attempt}!`);
          return res.json({ success: true, outputUrl: result.outputUrl, model: 'flux-kontext-pro' });
        }
        console.log(`[Generate] Attempt ${attempt} failed: ${result.error}`);

        // Wait 2 seconds before retry
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (err) {
        console.log(`[Generate] Attempt ${attempt} error: ${err.message}`);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 2000));
        }
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

async function runFluxKontext(image, prompt, aspectRatio) {
  const createResponse = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions', {
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
        output_quality: 90
      }
    })
  });

  const prediction = await createResponse.json();
  console.log(`[Flux] HTTP ${createResponse.status} | Status: ${prediction.status || 'N/A'}`);

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

// ==========================================
// EL NUEVO PROMPT (SIN BARBAS, SIN CAMBIOS DE CARA)
// ==========================================
function buildHairPrompt(style, density, hairline) {
  const densityDesc = {
    low: 'a subtle, natural amount of',
    medium: 'a full, thick head of',
    high: 'very thick, abundant'
  };

  // Cero palabras prohibidas. Describimos exactamente qué mantener intacto.
  return `A photorealistic, high-quality portrait of this exact person. Add ${densityDesc[density] || densityDesc.medium} hair strictly to the top of the scalp, forehead, and temples to cover any baldness. The new hair perfectly matches their original natural hair color and texture. The person's jawline, chin, face, skin, expression, and the background must remain absolutely 100% identical to the original input image. Clean shaven areas must remain clean shaven. Highly detailed, 8k, seamless transition.`;
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Follica AI Server running on port ${PORT}`);
  console.log(`🎯 Model: Flux Kontext Pro (with retry & optimized prompt)`);
  console.log(`📡 API Token: ${REPLICATE_API_TOKEN ? '✅ Configured' : '❌ Missing'}`);
  console.log(`🌐 Open: http://localhost:${PORT}\n`);
});
