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
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'), false);
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', hasApiKey: !!REPLICATE_API_TOKEN });
});

// ──────────────────────────────────────────────
// FUNCIONES AUXILIARES REPLICATE
// ──────────────────────────────────────────────

// Función genérica para llamar a Replicate y esperar el resultado
async function runReplicatePrediction(modelVersion, inputData) {
    console.log(`[Replicate] Iniciando modelo: ${modelVersion.substring(0, 10)}...`);
    const startResponse = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
            'Content-Type': 'application/json',
            'Prefer': 'wait' // Intentar esperar un poco
        },
        body: JSON.stringify({
            version: modelVersion,
            input: inputData
        })
    });

    const initialResult = await startResponse.json();
    if (!startResponse.ok) throw new Error(initialResult.detail || 'Error iniciando predicción');

    if (initialResult.status === 'succeeded') {
        return initialResult.output;
    }

    // Si no terminó inmediatamente, hacemos polling
    let prediction = initialResult;
    while (['starting', 'processing'].includes(prediction.status)) {
        await new Promise(r => setTimeout(r, 2000)); // Esperar 2s
        const pollResponse = await fetch(prediction.urls.get, {
            headers: { 'Authorization': `Bearer ${REPLICATE_API_TOKEN}` }
        });
        prediction = await pollResponse.json();
        console.log(`[Replicate] Estado: ${prediction.status}`);
    }

    if (prediction.status === 'succeeded') {
        return prediction.output;
    } else {
        throw new Error(`Predicción falló con estado: ${prediction.status}`);
    }
}

// ──────────────────────────────────────────────
// RUTA PRINCIPAL DE GENERACIÓN (Inpainting Pipeline)
// ──────────────────────────────────────────────

app.post('/api/generate', upload.single('image'), async (req, res) => {
    try {
        if (!REPLICATE_API_TOKEN) return res.status(500).json({ error: 'Missing API Token' });
        if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

        const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        const density = req.body.density || 'medium';

        console.log("--- INICIANDO PROCESO DE INPAINTING ---");

        // --- PASO 1: Generar la MÁSCARA automáticamente (El Detective) ---
        // Usamos CLIPSeg para encontrar "pelo" y "cabeza calva".
        // Devuelve una imagen en blanco y negro donde blanco = zona a modificar.
        console.log("Paso 1: Generando máscara de aislamiento...");
        // Modelo: cjwbw/clipseg
        const maskVersion = "2dd80560d125b53925679e6f843f9e43d8d277d51480c841f4657f424631904f";
        const maskOutput = await runReplicatePrediction(maskVersion, {
            image: base64Image,
            prompts: "hair, bald head area, forehead", // Qué áreas queremos seleccionar
            mask_blur: 5 // Suavizar bordes
        });
        // CLIPSeg a veces devuelve un array, tomamos el primero.
        const maskUrl = Array.isArray(maskOutput) ? maskOutput[0] : maskOutput;
        console.log("Máscara generada exitosamente.");


        // --- PASO 2: Aplicar INPAINTING usando la máscara (El Cirujano) ---
        // Usamos un modelo potente de Stable Diffusion XL especializado en Inpainting.
        // Solo tocará lo que la máscara diga que es blanco.
        console.log("Paso 2: Aplicando cabello nuevo en zona enmascarada...");

        const densityMap = { low: 'natural density', medium: 'full, thick', high: 'extremely dense, thick' };
        const d = densityMap[density] || 'full, thick';

        // El prompt ahora solo describe lo que va DENTRO de la máscara.
        // No necesitamos decirle "no cambies la cara" porque la máscara ya lo impide.
        const inpaintPrompt = `A professional photograph of a man's head with new ${d} hair. The hair is healthy, has realistic texture, and seamlessly matches the color and flow of the existing hair on the sides. High resolution, photorealistic.`;

        // Modelo: diffusers/stable-diffusion-xl-inpainting-1.0
        const inpaintVersion = "c8f0a6d5099c91105727a7f3e13c680694195937536507036680786878809091";
        const finalOutput = await runReplicatePrediction(inpaintVersion, {
            image: base64Image,
            mask: maskUrl, // ¡Aquí está la clave! La máscara protege la cara.
            prompt: inpaintPrompt,
            negative_prompt: "blurry, low quality, fake, unnatural, bald patches, deformed",
            prompt_strength: 0.85, // Fuerza alta porque confiamos en la máscara
            num_inference_steps: 30,
            guidance_scale: 8
        });

        const finalImageUrl = Array.isArray(finalOutput) ? finalOutput[0] : finalOutput;
        console.log("--- PROCESO TERMINADO EXITOSAMENTE ---");

        // Devolvemos la URL directamente de Replicate
        return res.json({ success: true, outputUrl: finalImageUrl });

    } catch (error) {
        console.error('[Error Fatal]:', error.message);
        res.status(500).json({ error: 'Generation failed', detail: error.message });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`\n🚀 Follica AI (Inpainting Engine) running on port ${PORT}\n`);
});
