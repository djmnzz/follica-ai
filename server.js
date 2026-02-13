const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

// Middleware profesional
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Configuración de subida de imágenes
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // Soporta fotos de alta resolución
});

// Helper de conexión con Replicate (Usa predicciones directas para evitar 404)
async function callReplicate(version, input) {
  const response = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait'
    },
    body: JSON.stringify({ version, input })
  });

  let prediction = await response.json();
  if (!response.ok) throw new Error(prediction.detail || "Error en la API de Replicate");

  // Sistema de Polling (Espera activa del resultado)
  let attempts = 0;
  while (!['succeeded', 'failed', 'canceled'].includes(prediction.status)) {
    if (attempts > 60) throw new Error("La IA tardó demasiado en responder");
    await new Promise(r => setTimeout(r, 3000));
    const poll = await fetch(prediction.urls.get, {
      headers: { 'Authorization': `Bearer ${REPLICATE_API_TOKEN}` }
    });
    prediction = await poll.json();
    attempts++;
  }

  if (prediction.status === 'failed') throw new Error(prediction.error || "La generación falló");
  return prediction.output;
}

// Health check para debug en Render
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '14.0 - AutoMask Pro', token: !!REPLICATE_API_TOKEN });
});

// ==========================================
// RUTA PRINCIPAL DE GENERACIÓN
// ==========================================
app.post('/api/generate', upload.single('image'), async (req, res) => {
  try {
    if (!REPLICATE_API_TOKEN) throw new Error("API Token no configurado en Render");
    if (!req.file) return res.status(400).json({ error: "No se subió ninguna imagen" });

    const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const { style = 'natural', density = 'medium', hairline = 'youthful' } = req.body;

    // PASO 1: LA IA DETECTIVE (Generación de Máscara Automática)
    // Detecta exactamente el cuero cabelludo y las entradas para proteger la cara
    console.log("[Follica] Paso 1: Localizando zona capilar...");
    const maskUrl = await callReplicate(
      "961cd6665b37e34af7966970bc35468151eaa05103ca07006f162447fa40510d", 
      { image: base64Image, prompts: "the hair and the bald areas of the forehead" }
    );

    // PASO 2: LA IA CIRUJANA (Inpainting Profesional)
    // Rellena solo la zona de la máscara con cabello realista
    console.log("[Follica] Paso 2: Ejecutando trasplante de alta densidad...");
    const finalResult = await callReplicate(
      "39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b",
      {
        image: base64Image,
        mask: Array.isArray(maskUrl) ? maskUrl[0] : maskUrl,
        prompt: `High-end professional fotorrealistic hair transplant result. The man has a very thick, dense ${style} head of hair. The hairline is perfectly straight, youthful, and full with absolutely no receding areas. Masterpiece, 8k resolution, seamless blend with original skin, matching hair color, sharp focus.`,
        negative_prompt: "bald spots, thinning hair, receding hairline, changed face, different person, blurry, fake, plastic, watermark, low quality",
        prompt_strength: 0.90, // Fuerza máxima porque la máscara protege el rostro
        num_inference_steps: 40,
        guidance_scale: 8.5,
        disable_safety_checker: true
      }
    );

    const outputUrl = Array.isArray(finalResult) ? finalResult[0] : finalResult;
    console.log("[Follica] Proceso completado con éxito.");
    
    return res.json({ success: true, outputUrl });

  } catch (error) {
    console.error("[Follica Error]", error.message);
    res.status(500).json({ error: "Error en el servidor", detail: error.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`🚀 Follica PRO Live en puerto ${PORT}`);
});
