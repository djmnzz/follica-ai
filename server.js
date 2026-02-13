const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer for file uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'), false);
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasApiKey: !!REPLICATE_API_TOKEN,
    timestamp: new Date().toISOString(),
    version: '5.0 - SDXL Professional' 
  });
});

// Generate AI hair transplant result
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
    const negativePrompt = buildNegativePrompt();

    console.log(`[Generate] Starting PRO SDXL - Style: ${style}, Density: ${density}, Hairline: ${hairline}`);

    // CORRECCIÓN PROFESIONAL: Usamos el alias oficial de SDXL (nunca te dará 404)
    const createResponse = await fetch('https://api.replicate.com/v1/models/stability-ai/sdxl/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait'
      },
      body: JSON.stringify({
        input: {
          image: base64Image,
          prompt: prompt,
          negative_prompt: negativePrompt,
          // 0.35 es el "punto dulce". Modifica el cabello pero no destruye los rasgos faciales.
          prompt_strength: 0.35, 
          num_inference_steps: 40,
          guidance_scale: 7.5
        }
      })
    });

    const responseText = await createResponse.text();
    console.log(`[Generate] API response status: ${createResponse.status}`);

    let prediction;
    try {
      prediction = JSON.parse(responseText);
    } catch (e) {
      console.error('[Generate] Failed to parse response:', responseText.substring(0, 500));
      return res.status(500).json({ error: 'Invalid API response', detail: responseText.substring(0, 200) });
    }

    if (!createResponse.ok) {
      console.error('[Generate] API error:', prediction);
      return res.status(createResponse.status).json({
        error: 'API error',
        detail: prediction.detail || prediction.error || JSON.stringify(prediction)
      });
    }

    if (prediction.status === 'succeeded' && prediction.output) {
      const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
      console.log(`[Generate] Instant success!`);
      return res.json({ success: true, outputUrl });
    }

    if (prediction.id) {
      console.log(`[Generate] Prediction created: ${prediction.id}, polling...`);
      const result = await pollPrediction(prediction.urls?.get || `https://api.replicate.com/v1/predictions/${prediction.id}`);

      if (result.status === 'succeeded') {
        const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output;
        console.log(`[Generate] Success!`);
        return res.json({ success: true, outputUrl });
      } else {
        console.error(`[Generate] Failed:`, result.error);
        return res.status(500).json({ error: 'Generation failed', detail: result.error || 'Unknown error' });
      }
    }

    return res.status(500).json({ error: 'Unexpected API response', detail: JSON.stringify(prediction).substring(0, 200) });

  } catch (error) {
    console.error('[Generate] Server error:', error.message);
    res.status(500).json({ error: 'Server error', detail: error.message });
  }
});

// Poll prediction status
async function pollPrediction(url) {
  const maxAttempts = 60;
  let attempts = 0;

  while (attempts < maxAttempts) {
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${REPLICATE_API_TOKEN}` }
    });
    const prediction = await response.json();
    console.log(`[Poll] Status: ${prediction.status} (${attempts * 3}s)`);

    if (['succeeded', 'failed', 'canceled'].includes(prediction.status)) {
      return prediction;
    }

    attempts++;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  throw new Error('Prediction timed out after 3 minutes');
}

// Prompts reescritos para evitar resultados extraños y collages
function buildHairPrompt(style, density, hairline) {
  const densityMap = {
    low: 'subtle natural hair density',
    medium: 'full head of hair, medium density',
    high: 'very thick dense hair'
  };
  const styleMap = {
    natural: 'natural organic hair styling',
    dense: 'thick robust hair styling',
    subtle: 'neatly groomed hair'
  };
  const hairlineMap = {
    'age-appropriate': 'natural mature hairline',
    'youthful': 'youthful straight hairline',
    'mature': 'slightly recessed dignified hairline'
  };

  return `Photorealistic professional portrait of a man. He has ${densityMap[density]}, ${hairlineMap[hairline]}, ${styleMap[style]}. Perfectly matching his natural hair color. The facial features, face shape, eyes, expression, clothing, and background are ABSOLUTELY IDENTICAL to the original image. Highly detailed, 8k resolution, DSLR photography.`;
}

function buildNegativePrompt() {
  return 'collage, split screen, before and after, multiple views, text, watermark, different person, changed face, altered facial features, 3d render, cgi, cartoon, painting, drawing, wig, fake hair, deformed, blurry, overexposed';
}

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Follica AI Server running on port ${PORT}`);
});
