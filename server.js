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

// Helper Profesional para llamadas inmutables (evita errores 404)
async function runReplicateAPI(versionHash, inputConfig, token) {
  const url = 'https://api.replicate.com/v1/predictions';
    
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
  if (!response.ok) throw new Error(prediction.detail || JSON.stringify(prediction));

  let attempts = 0;
  while (!['succeeded', 'failed', 'canceled'].includes(prediction.status)) {
    if (attempts > 60) throw new Error('Timeout en Replicate');
    await new Promise(r => setTimeout(r, 3000));
    const pollResponse = await fetch(prediction.urls.get, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    prediction = await pollResponse.json();
    attempts++;
  }

  if (prediction.status === 'failed') throw new Error(`Error: ${prediction.error}`);
  return prediction.output;
}

app.post('/api/generate', upload.single('image'), async (req, res) => {
  try {
    if (!REPLICATE_API_TOKEN) return res.status(500).json({ error: 'Token missing' });
    if (!req.file) return res.status(400).json({ error: 'No image' });

    const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const { style = 'natural', density = 'medium' } = req.body;

    // STEP 1: AUTO-MASK (Usando Hash de CLIPSeg para evitar 404)
    console.log(`[Generate] Step 1: Detectando zona de calvicie...`);
    const maskOutput = await runReplicateAPI(
      "961cd6665b37e34af7966970bc35468151eaa05103ca07006f162447fa40510d", 
      { image: base64Image, prompts: "bald head, forehead" }, 
      REPLICATE_API_TOKEN
    );

    const maskUrl = Array.isArray(maskOutput) ? maskOutput[0] : maskOutput;

    // STEP 2: INPAINTING (Usando Hash de SDXL Inpainting)
    console.log(`[Generate] Step 2: Aplicando trasplante capilar...`);
    const finalOutput = await runReplicateAPI(
      "39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b",
      {
        image: base64Image,
        mask: maskUrl,
        prompt: `Photorealistic high-quality portrait. The man has a full head of thick ${style} hair, perfect hairline, David Beckham style, dense follicles, seamless blend, 8k DSLR`,
        negative_prompt: "bald, receding hairline, skin, plastic, fake, collage, distorted face",
        prompt_strength: 0.85, // Fuerza alta porque la cara está protegida por la máscara
        num_inference_steps: 40,
        guidance_scale: 8.0,
        disable_safety_checker: true
      },
      REPLICATE_API_TOKEN
    );

    const outputUrl = Array.isArray(finalOutput) ? finalOutput[0] : finalOutput;
    return res.json({ success: true, outputUrl });

  } catch (error) {
    console.error('[Generate] Error:', error.message);
    res.status(500).json({ error: 'Server error', detail: error.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
