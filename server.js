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

// Función auxiliar para obtener el aspect ratio (útil para algunos modelos)
async function getAspectRatio(buffer) {
  try {
    const metadata = await sharp(buffer).metadata();
    const ratio = metadata.width / metadata.height;
    // Simplificamos para SDXL
    if (ratio > 1.1) return '16:9';
    if (ratio < 0.9) return '9:16';
    return '1:1';
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
    
    const prompt = buildHairPrompt(style, density, hairline);
    const negativePrompt = buildNegativePrompt();

    // Intentamos hasta 3 veces con el nuevo modelo
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[Generate] Attempt ${attempt}/${maxRetries} with SDXL Realism...`);

      try {
        // Llamamos a la nueva función para SDXL
        const result = await runSDXLRealism(base64Image, prompt, negativePrompt);
        if (result.success) {
          console.log(`[Generate] ✅ Success on attempt ${attempt}!`);
          return res.json({ success: true, outputUrl: result.outputUrl, model: 'sdxl-realism' });
        }
        console.log(`[Generate] Attempt ${attempt} failed: ${result.error}`);
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.log(`[Generate] Attempt ${attempt} error: ${err.message}`);
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 2000));
      }
    }

    return res.status(500).json({
      error: 'The AI model is currently busy or failed. Please try again.'
    });

  } catch (error) {
    console.error('[Generate] Server error:', error.message);
    res.status(500).json({ error: 'Server error', detail: error.message });
  }
});

// NUEVA FUNCIÓN: Usa SDXL con control de fuerza para no cambiar la cara
async function runSDXLRealism(image, prompt, negativePrompt) {
  // Usamos una versión específica y estable de SDXL
  const version = "39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b";
  
  const createResponse = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait'
    },
    body: JSON.stringify({
      version: version,
      input: {
        image: image, // La imagen original es la base
        prompt: prompt,
        negative_prompt: negativePrompt,
        // ¡ESTO ES CLAVE! Un valor bajo (0.3 - 0.4) mantiene la cara original.
        // Un valor alto (0.8) la cambiaría por completo. Probamos con 0.35.
        prompt_strength: 0.35, 
        num_inference_steps: 30,
        guidance_scale: 7.5,
        scheduler: "K_EULER_ANCESTRAL"
      }
    })
  });

  const prediction = await createResponse.json();
  console.log(`[SDXL] HTTP ${createResponse.status} | Status: ${prediction.status || 'N/A'}`);

  if (!createResponse.ok) {
    return { success: false, error: prediction.detail || JSON.stringify(prediction).substring(0, 200) };
  }

  if (prediction.status === 'succeeded' && prediction.output) {
    // SDXL devuelve un array, tomamos la primera imagen
    const outputUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    return { success: true, outputUrl };
  }

  if (prediction.id) {
    // Si no terminó, hacemos polling
    const pollUrl = prediction.urls?.get || `https://api.replicate.com/v1/predictions/${prediction.id}`;
    return await pollPrediction(pollUrl);
  }

  return { success: false, error: 'Unexpected response or failure' };
}

async function pollPrediction(url) {
  const maxAttempts = 60; // Esperamos más tiempo (3 minutos máx)
  let attempts = 0;
  while (attempts < maxAttempts) {
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${REPLICATE_API_TOKEN}` }
    });
    const data = await response.json();
    console.log(`[Poll] ${data.status} (${attempts * 3}s)`);
    
    if (data.status === 'succeeded' && data.output) {
      const outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;
      return { success: true, outputUrl };
    }
    if (['failed', 'canceled'].includes(data.status)) {
      return { success: false, error: data.error || 'Prediction failed' };
    }
    
    attempts++;
    await new Promise(r => setTimeout(r, 3000));
  }
  return { success: false, error: 'Timed out' };
}

// ==========================================
// PROMPTS OPTIMIZADOS PARA MANTENER LA CARA
// ==========================================
function buildHairPrompt(style, density, hairline) {
  const densityDesc = {
    low: 'a natural, subtle amount of new',
    medium: 'a full, healthy head of',
    high: 'very thick, dense'
  };
  
  // El prompt enfatiza que es la MISMA persona
  return `A photorealistic portrait of the EXACT SAME man from the original image, but now with ${densityDesc[density] || densityDesc.medium} hair on his scalp. The hair is completely natural looking and matches his original hair color. Crucially, his face, eyes, nose, mouth, skin texture, wrinkles, expression, and the background remain 100% IDENTICAL to the input photo. No changes to his facial features. High detail, 8k.`;
}

// NUEVA FUNCIÓN: Prompt Negativo para prohibir cambios
function buildNegativePrompt() {
  // Lista explícita de cosas que NO debe hacer
  return "changed face, different person, altered facial features, plastic surgery, distorted face, blurry, cartoon, painting, ugly, deformed, extra fingers, changes to eyes, changes to nose, changes to mouth, beard change";
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Follica AI Server running on port ${PORT}`);
  console.log(`🎯 Model: SDXL Realism (Face Preservation Mode)`);
  console.log(`📡 API Token: ${REPLICATE_API_TOKEN ? '✅ Configured' : '❌ Missing'}`);
  console.log(`🌐 Open: http://localhost:${PORT}\n`);
});
