/**
 * server.js (LIVE)
 * Auto-mask (LangSAM) + SDXL Inpainting (Replicate) for Hair Transplant Before/After
 * - Fully automatic mask (no clicks)
 * - Optional "draft" mode to spend fewer credits while testing
 * - Simple in-memory cache to avoid re-paying for identical requests
 * - Replicate connection status endpoint: /api/replicate/status
 *
 * Requirements:
 *   - Node 18+ (fetch included). If Node < 18, install node-fetch.
 *   - env: REPLICATE_API_TOKEN
 */

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3001;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

// ---- Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---- Upload (memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ---- Health
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    version: "15.0 - LIVE Replicate (LangSAM mask + SDXL inpaint) + status endpoint + cache",
  });
});

// ---- Replicate status (verifica token/billing sin exponer secretos)
app.get("/api/replicate/status", async (req, res) => {
  try {
    if (!REPLICATE_API_TOKEN) {
      return res.status(200).json({ connected: false, reason: "missing_token" });
    }

    // Endpoint simple de cuenta (si token es válido responde 200)
    const r = await fetch("https://api.replicate.com/v1/account", {
      headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` },
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(200).json({
        connected: false,
        reason: "replicate_error",
        status: r.status,
        detail: data?.detail || data,
      });
    }

    return res.status(200).json({
      connected: true,
      account: {
        // devolvemos algo útil pero no enorme
        username: data?.username,
        name: data?.name,
        type: data?.type,
      },
    });
  } catch (e) {
    return res.status(200).json({
      connected: false,
      reason: "network_or_server_error",
      detail: e.message,
    });
  }
});

/**
 * Replicate helper (version hash) using predictions endpoint + polling.
 * Uses Prefer: wait for faster sync, but still polls in case it's async.
 */
async function runReplicateAPI(versionHash, inputConfig, token) {
  const url = "https://api.replicate.com/v1/predictions";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({ version: versionHash, input: inputConfig }),
  });

  let prediction = await response.json();

  if (!response.ok) {
    console.error("[Replicate API Error]", prediction);
    throw new Error(prediction.detail || JSON.stringify(prediction));
  }

  let attempts = 0;
  while (!["succeeded", "failed", "canceled"].includes(prediction.status)) {
    if (attempts > 80) throw new Error("Timeout esperando a Replicate");
    await new Promise((r) => setTimeout(r, 2500));

    const pollResponse = await fetch(prediction.urls.get, {
      headers: { Authorization: `Bearer ${token}` },
    });

    prediction = await pollResponse.json();
    attempts++;
  }

  if (prediction.status !== "succeeded") {
    throw new Error(`Replicate falló: ${prediction.error || prediction.status}`);
  }

  return prediction.output;
}

/**
 * Simple cache to avoid spending credits repeatedly while testing.
 * Key: hash(image + params)
 */
const memoryCache = new Map();
function makeCacheKey(buffer, paramsObj) {
  const h = crypto.createHash("sha256");
  h.update(buffer);
  h.update(JSON.stringify(paramsObj || {}));
  return h.digest("hex");
}

/**
 * PROMPT builder (hair style/density)
 */
function buildHairPrompt({ style, density }) {
  const densityMap = {
    low: "slightly thicker hair with a subtle improvement",
    medium: "a full head of thick, dense hair",
    high: "very thick, very dense hair with maximum coverage",
  };

  const densityText = densityMap[density] || densityMap.medium;

  const styleText =
    style === "curly"
      ? "curly"
      : style === "wavy"
      ? "wavy"
      : style === "straight"
      ? "straight"
      : "natural";

  return {
    prompt:
      `A professional portrait photograph of the same person. ` +
      `Add realistic ${styleText} hair. The person now has ${densityText} and a natural youthful hairline. ` +
      `Keep the face, eyes, skin, facial features, lighting, and background identical to the original. ` +
      `Photorealistic. High detail.`,
    negative:
      "bald, thinning, receding, unnatural hairline, wig, plastic skin, distorted face, changed eyes, " +
      "extra fingers, blur, low quality, artifacts",
  };
}

/**
 * Versions (hashes) used
 * - LangSAM (segment anything by text): returns mask URI
 * - SDXL Inpainting: uses image + mask to inpaint hair area
 */
const LANGSAM_VERSION =
  "891411c38a6ed2d44c004b7b9e44217df7a5b07848f29ddefd2e28bc7cbf93bc";
const SDXL_INPAINT_VERSION =
  "39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b";

/**
 * Generate endpoint
 * - image: multipart/form-data "image"
 * - body fields: style, density, draft, useCache
 */
app.post("/api/generate", upload.single("image"), async (req, res) => {
  try {
    if (!REPLICATE_API_TOKEN) {
      return res.status(500).json({ error: "Falta el REPLICATE_API_TOKEN en env" });
    }
    if (!req.file) return res.status(400).json({ error: "No se subió imagen" });

    // Params
    const style = (req.body.style || "natural").toLowerCase();
    const density = (req.body.density || "medium").toLowerCase();
    const draft = String(req.body.draft || "false").toLowerCase() === "true";
    const useCache = String(req.body.useCache || "true").toLowerCase() !== "false";

    // Make base64 data URL
    const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;

    // Cache
    const cacheKey = makeCacheKey(req.file.buffer, { style, density, draft });
    if (useCache && memoryCache.has(cacheKey)) {
      return res.json({ success: true, outputUrl: memoryCache.get(cacheKey), cached: true, draft });
    }

    /**
     * STEP 1: AUTO MASK (LangSAM)
     * Goal: select scalp/bald area to replace with hair (white mask area = gets inpainted).
     */
    console.log("[Generate] Step 1: Auto-mask scalp/bald area...");
    const maskOutput = await runReplicateAPI(
      LANGSAM_VERSION,
      {
        image: base64Image,
        text_prompt: "scalp, bald scalp, bald area, receding hairline, forehead hairline",
      },
      REPLICATE_API_TOKEN
    );

    // Normalize mask output to a URL string
    let maskUrl = maskOutput;
    if (Array.isArray(maskOutput)) maskUrl = maskOutput[0];
    if (maskOutput && typeof maskOutput === "object") {
      maskUrl = maskOutput.mask || maskOutput.output || maskOutput.uri || maskOutput.url || maskOutput;
    }
    if (!maskUrl || typeof maskUrl !== "string") {
      throw new Error("No se pudo obtener maskUrl válido desde LangSAM.");
    }

    /**
     * STEP 2: SDXL Inpainting
     * draft=true => cheaper testing
     */
    console.log("[Generate] Step 2: SDXL inpaint hair...");
    const { prompt, negative } = buildHairPrompt({ style, density });

    const numSteps = draft ? 18 : 35;
    const guidance = draft ? 6.5 : 8.0;
    const strength = draft ? 0.65 : 0.75; // lower preserves identity more

    const finalOutput = await runReplicateAPI(
      SDXL_INPAINT_VERSION,
      {
        image: base64Image,
        mask: maskUrl,
        prompt,
        negative_prompt: negative,
        prompt_strength: strength,
        num_inference_steps: numSteps,
        guidance_scale: guidance,
        disable_safety_checker: true,
      },
      REPLICATE_API_TOKEN
    );

    let outputUrl = finalOutput;
    if (Array.isArray(finalOutput)) outputUrl = finalOutput[0];
    if (!outputUrl || typeof outputUrl !== "string") {
      throw new Error("No se pudo obtener outputUrl válido desde SDXL.");
    }

    if (useCache) memoryCache.set(cacheKey, outputUrl);

    return res.json({ success: true, outputUrl, cached: false, draft });
  } catch (error) {
    console.error("[Generate] Error Fatal:", error.message);
    res.status(500).json({ error: "Error en la generación", detail: error.message });
  }
});

// SPA fallback
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
