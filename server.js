const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '13.0 - Fixed 404 with Hashes' });
});

// Helper para llamadas a Replicate usando HASHES (Evita errores 404)
async function runReplicateAPI(versionHash, inputConfig, token) {
  const url = 'https://api.replicate.com/v1/predictions';
    
  console.log(`[API] Llamando a Replicate versión: ${versionHash.substring(0, 8)}...`);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait'
    },
    body: JSON.stringify({ version: versionHash, input: inputConfig })
  });

  let prediction = await response.json();
  if (!response.ok) {
      console.error("[API Error]", prediction);
      throw new Error(prediction.detail || JSON.stringify(prediction));
  }

  let attempts = 0;
  while (!['succeeded', 'failed', 'canceled'].includes(prediction.status)) {
    if (attempts > 60) throw new Error('Timeout esperando a Replicate');
    await new Promise(r => setTimeout(r, 3000));
    const pollResponse = await fetch(prediction.urls.get, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    prediction = await pollResponse.json();
    attempts++;
  }

  if (prediction.status === 'failed') throw new Error(`Replicate falló: ${prediction.error}`);
  console.log(`[API] Éxito. Resultado obtenido.`);
  return prediction.output;
}

app.post('/api/generate', upload.single('image'), async (req, res) => {
  try {
    if (!REPLICATE_API_TOKEN) return res.status(500).json({ error: 'Falta el API Token' });
    if (!req.file) return res.status(400).json({ error: 'No se subió imagen' });

    const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const { style = 'natural', density = 'medium' } = req.body;

    // PASO 1: AUTO-MÁSCARA (Usando el HASH exacto de CLIPSeg)
    // Este hash es permanente y no dará error 404.
    console.log(`[Generate] Paso 1: Generando máscara de calvicie...`);
    const maskOutput = await runReplicateAPI(
      "961cd6665b37e34af7966970bc35468151eaa05103ca07006f162447fa40510d", 
      { image: base64Image, prompts: "bald head, forehead, receding hairline" }, 
      REPLICATE_API_TOKEN
    );
    const maskUrl = Array.isArray(maskOutput) ? maskOutput[0] : maskOutput;

    // PASO 2: INPAINTING (Usando el HASH exacto de SDXL Inpainting)
    console.log(`[Generate] Paso 2: Aplicando cabello nuevo...`);
    const finalOutput = await runReplicateAPI(
      "39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b",
      {
        image: base64Image,
        mask: maskUrl, // La máscara protege la cara
        prompt: `A professional portrait photograph. The man has a full head of thick, dense ${style} hair with a perfect, natural, youthful hairline. No bald spots or recession. The hair looks completely real. The face, skin, and background are identical to the original image. 8k resolution.`,
        negative_prompt: "bald, thinning, receding, blurry, fake, plastic, distorted face, changed eyes",
        prompt_strength: 0.90, // Fuerza alta para rellenar bien la zona calva
        num_inference_steps: 35,
        guidance_scale: 8.0,
        disable_safety_checker: true
      },
      REPLICATE_API_TOKEN
    );

    const outputUrl = Array.isArray(finalOutput) ? finalOutput[0] : finalOutput;
    return res.json({ success: true, outputUrl });

  } catch (error) {
    console.error('[Generate] Error Fatal:', error.message);
    // Es importante devolver un error 500 real para que el frontend sepa que falló
    res.status(500).json({ error: 'Error en la generación', detail: error.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
