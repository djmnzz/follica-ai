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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
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
    timestamp: new Date().toISOString()
  });
});

// Generate AI hair transplant result
app.post('/api/generate', upload.single('image'), async (req, res) => {
  try {
    if (!REPLICATE_API_TOKEN) {
      return res.status(500).json({ error: 'API token not configured. Set REPLICATE_API_TOKEN environment variable.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const style = req.body.style || 'natural';
    const density = req.body.density || 'medium';
    const hairline = req.body.hairline || 'age-appropriate';

    // Build prompt optimized for hair transplant
    const prompt = buildHairPrompt(style, density, hairline);
    const negativePrompt = buildNegativePrompt();

    console.log(`[Generate] Starting prediction - Style: ${style}, Density: ${density}, Hairline: ${hairline}`);

    // Create prediction with Replicate
    const createResponse = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        version: "a07f252abbbd832009640b27f063ea52d87d7a23a185ca165bec23b5b8e59505",
        input: {
          image: base64Image,
          prompt: prompt,
          negative_prompt: negativePrompt,
          num_inference_steps: 30,
          guidance_scale: 7.5,
          strength: 0.45,
          scheduler: "K_EULER_ANCESTRAL"
        }
      })
    });

    if (!createResponse.ok) {
      const errorData = await createResponse.json();
      console.error('[Generate] Create prediction failed:', errorData);
      return res.status(createResponse.status).json({
        error: 'Failed to create AI prediction',
        detail: errorData.detail || 'Unknown error'
      });
    }

    const prediction = await createResponse.json();
    console.log(`[Generate] Prediction created: ${prediction.id}`);

    // Poll for result
    const result = await pollPrediction(prediction.id);

    if (result.status === 'succeeded') {
      console.log(`[Generate] Success! Output ready.`);
      const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output;
      res.json({
        success: true,
        outputUrl: outputUrl,
        predictionId: result.id,
        metrics: result.metrics
      });
    } else {
      console.error(`[Generate] Prediction failed:`, result.error);
      res.status(500).json({
        error: 'AI generation failed',
        detail: result.error || 'Unknown error'
      });
    }

  } catch (error) {
    console.error('[Generate] Server error:', error.message);
    res.status(500).json({ error: 'Server error', detail: error.message });
  }
});

// Poll prediction status
async function pollPrediction(predictionId) {
  const maxAttempts = 60; // 3 minutes max
  let attempts = 0;

  while (attempts < maxAttempts) {
    const response = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { 'Authorization': `Bearer ${REPLICATE_API_TOKEN}` }
    });

    const prediction = await response.json();
    console.log(`[Poll] ${prediction.id} - Status: ${prediction.status} (${attempts * 3}s elapsed)`);

    if (prediction.status === 'succeeded' || prediction.status === 'failed' || prediction.status === 'canceled') {
      return prediction;
    }

    attempts++;
    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds
  }

  throw new Error('Prediction timed out after 3 minutes');
}

// Build optimized hair transplant prompt
function buildHairPrompt(style, density, hairline) {
  const densityMap = {
    low: 'subtle natural hair density improvement',
    medium: 'moderate natural hair density, full coverage',
    high: 'thick dense full head of hair, maximum coverage'
  };

  const styleMap = {
    natural: 'naturally distributed hair follicles, organic hair growth pattern',
    dense: 'dense uniform hair coverage, thick hair',
    subtle: 'subtle improvement, slightly thicker hair, minimal change'
  };

  const hairlineMap = {
    'age-appropriate': 'age-appropriate natural mature hairline',
    'youthful': 'youthful lower hairline, full frontal coverage',
    'mature': 'mature dignified hairline, natural recession maintained'
  };

  return `professional medical hair transplant result photograph, ${styleMap[style] || styleMap.natural}, ${densityMap[density] || densityMap.medium}, ${hairlineMap[hairline] || hairlineMap['age-appropriate']}, perfectly matching original hair color and texture, realistic scalp visibility, natural hair direction and flow, photorealistic, same lighting and angle as original, ONLY hair and scalp area modified, face skin eyes nose mouth ears clothing background COMPLETELY UNCHANGED AND IDENTICAL`;
}

// Build negative prompt
function buildNegativePrompt() {
  return 'cartoon, anime, illustration, painting, drawing, art, sketch, CGI, 3D render, changed face, different person, altered facial features, different skin color, modified eyes, changed nose, different mouth, wig, fake hair, plastic, distorted, deformed, blurry, low quality, watermark, text, logo, different clothing, different background, different angle, different lighting';
}

// Catch-all: serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Follica AI Server running on port ${PORT}`);
  console.log(`📡 API Token: ${REPLICATE_API_TOKEN ? '✅ Configured' : '❌ Missing - set REPLICATE_API_TOKEN'}`);
  console.log(`🌐 Open: http://localhost:${PORT}\n`);
});
