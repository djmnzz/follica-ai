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

// Multer for file uploads
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
    version: '12.0 - Enterprise Auto-Mask Inpainting'
  });
});

// Helper Profesional para llamar a múltiples modelos de Replicate sin ensuciar el código
async function runReplicateAPI(modelEndpoint, inputConfig, token) {
  const isVersion = !modelEndpoint.includes('/');
  const url = isVersion 
    ? 'https://api.replicate.com/v1/predictions'
    : `https://api.replicate.com/v1/models/${modelEndpoint}/predictions`;
    
  const body = isVersion 
    ? { version: modelEndpoint, input: inputConfig }
    : { input: inputConfig };

  let response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait'
    },
    body: JSON.stringify(body)
  });

  let prediction = await response.json();
  if (!response.ok) throw new Error(prediction.detail || JSON.stringify(prediction));

  // Polling inteligente
  let attempts = 0;
  while (!['succeeded', 'failed', 'canceled'].includes(prediction.status)) {
    if (attempts > 60) throw new Error('Timeout esperando a la IA');
    await new Promise(r => setTimeout(r, 3000));
    const pollResponse = await fetch(prediction.urls.get, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    prediction = await pollResponse.json();
    attempts++;
  }

  if (prediction.status === 'failed') throw new Error(`Falló en Replicate: ${prediction.error}`);
  return prediction.output;
}

// Generate AI hair transplant result
app.post('/api/generate', upload.single('image'), async (req, res) => {
  try {
    if (!REPLICATE_API_TOKEN) return res.status(500).json({ error: 'API token missing.' });
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const { style = 'natural', density = 'medium', hairline = 'age-appropriate' } = req.body;

    // ==========================================
    // PASO 1: IA DETECTIVE (AUTO-MÁSCARA)
    // ==========================================
    console.log(`[Generate] Step 1: Creando máscara automática de la calvicie...`);
    
    // Usamos CLIPSeg, un modelo que lee texto y devuelve una máscara en blanco y negro
    const maskOutput = await runReplicateAPI('cjwbw/clipseg', {
      image: base64Image,
      prompts: "hair and bald forehead", // Busca el cabello existente y la zona calva
    }, REPLICATE_API_TOKEN);

    // Obtenemos la URL de la máscara generada
    const maskUrl = Array.isArray(maskOutput) ? maskOutput[0] : maskOutput;
    console.log(`[Generate] Máscara creada con éxito.`);

    // ==========================================
    // PASO 2: IA CIRUJANA (INPAINTING)
    // ==========================================
    console.log(`[Generate] Step 2: Rellenando con cabello mediante SDXL Inpainting...`);
    
    // Usamos la versión oficial de SDXL que soporta máscaras nativamente
    const finalOutput = await runReplicateAPI('39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b', {
      image: base64Image,
      mask: maskUrl, // ¡AQUÍ ESTÁ LA MAGIA! La máscara protege el 100% de la cara
      prompt: buildHairPrompt(style, density, hairline),
      negative_prompt: buildNegativePrompt(),
      // Ahora usamos un prompt_strength muy alto (0.85) porque queremos 
      // reemplazar totalmente la zona calva, ¡y la cara ya está a salvo!
      prompt_strength: 0.85, 
      num_inference_steps: 35,
      guidance_scale: 7.5,
      disable_safety_checker: true
    }, REPLICATE_API_TOKEN);

    const outputUrl = Array.isArray(finalOutput) ? finalOutput[0] : finalOutput;
    console.log(`[Generate] ¡Trasplante exitoso!`);
    
    return res.json({ success: true, outputUrl });

  } catch (error) {
    console.error('[Generate] Server error:', error.message);
    res.status(500).json({ error: 'Server error', detail: error.message });
  }
});

// Prompts re-ajustados para el contexto del Inpainting
function buildHairPrompt(style, density, hairline) {
  return `Photorealistic portrait of a man. The masked area is filled with a full head of thick, dense, healthy hair. Perfect youthful hairline, modern styling. High quality, seamless blending into the scalp, 8k resolution.`;
}

function buildNegativePrompt() {
  return 'bald, bald spot, receding hairline, skin, forehead exposure, artificial, plastic, blurry, low quality';
}

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Follica AI Server running on port ${PORT}`);
});
