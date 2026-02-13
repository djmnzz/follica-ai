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
    version: '4.0 (Realistic Engine)' // ¡Nueva versión!
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

    // Hice el prompt positivo un poco más agresivo
    const prompt = buildHairPrompt(style, density, hairline);
    // Y el negativo más estricto contra resultados malos
    const negativePrompt = buildNegativePrompt();

    console.log(`[Generate] Starting PRO - Style: ${style}, Density: ${density}, Hairline: ${hairline}`);

    const createResponse = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait'
      },
      body: JSON.stringify({
        // ¡EL CAMBIO CLAVE! Usamos un modelo de alto fotorrealismo (Realistic Vision v5.1)
        version: "9936c2001faa2194a261c01381f90e65261879985476014a0a37a334593a05eb",
        input: {
          image: base64Image,
          prompt: prompt,
          negative_prompt: negativePrompt,
          // Damos más pasos para mayor realismo
          num_inference_steps: 40,
          // Un poco más de libertad al modelo (menos fuerza a la imagen original)
          prompt_strength: 0.40, 
          guidance_scale: 7.5,
          scheduler: "K_EULER_ANCESTRAL"
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

// Build optimized hair transplant prompt
function buildHairPrompt(style, density, hairline) {
  const densityMap = {
    low: 'natural density improvement',
    medium: 'full natural density, complete coverage',
    high: 'very thick dense hair, maximum coverage'
  };
  const styleMap = {
    natural: 'organic hair growth pattern, natural look',
    dense: 'thick uniform coverage, robust hair',
    subtle: 'slight improvement, fuller look'
  };
  const hairlineMap = {
    'age-appropriate': 'natural mature hairline',
    'youthful': 'youthful lower hairline',
    'mature': 'dignified recessed hairline'
  };

  // Prompt reforzado para realismo médico
  return `photorealistic after photo of successful hair transplant surgery, patient showing ${styleMap[style] || styleMap.natural}, ${densityMap[density] || densityMap.medium}, ${hairlineMap[hairline] || hairlineMap['age-appropriate']}, perfectly matching original hair color and texture, realistic scalp details, natural follicle direction, cinematic lighting, highly detailed, sharp focus. The face, skin, eyes, and background remain exactly the same as the original image.`;
}

function buildNegativePrompt() {
  // Negative prompt reforzado
  return 'baldness, thinning hair, fake hair, wig, plastic look, unnatural hairline, distorted face, blurry, low quality, cartoon, painting, bad anatomy, extra fingers, deformed, ugly, watermark, text';
}

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Follica AI Server running on port ${PORT}`);
});
