// server.js
// Follica AI Server (LIVE) + SaaS Credits (in-memory)
// Fixes: correct Replicate version hash for lucataco/realistic-vision-v5.1
// Adds: /api/credits, /api/credits/add, /api/credits/reset, /api/replicate/status
//
// Run:
//   export REPLICATE_API_TOKEN="YOUR_TOKEN"
//   node server.js
//
// Optional:
//   export DEFAULT_CREDITS=100

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

// ==============================
// ✅ SaaS Credits (in-memory)
// ==============================
const DEFAULT_CREDITS = Number(process.env.DEFAULT_CREDITS || 100);
let credits = Number.isFinite(DEFAULT_CREDITS) ? DEFAULT_CREDITS : 100;

function spendCredits(amount = 1) {
  if (credits < amount) return false;
  credits -= amount;
  return true;
}
function refundCredits(amount = 1) {
  credits += amount;
}

// ==============================
// ✅ Replicate Model Versions (HASHES)
// ==============================

// lucataco/realistic-vision-v5.1 (Latest at time of writing)
const REALISTIC_VISION_V51_VERSION =
  "2c8e954decbf70b7607a4414e5785ef9e4de4b8c51d50fb8b8b349160e0ef6bb";

// ------------------------------
// Middleware
// ------------------------------
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Multer for file uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files allowed"), false);
  },
});

// ------------------------------
// Health check
// ------------------------------
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    hasApiKey: !!REPLICATE_API_TOKEN,
    credits,
    timestamp: new Date().toISOString(),
    version: "12.0 - LIVE (Realistic Vision v5.1) + Credits + Status",
  });
});

// ------------------------------
// Replicate status (token/billing check)
// ------------------------------
app.get("/api/replicate/status", async (req, res) => {
  try {
    if (!REPLICATE_API_TOKEN) {
      return res.status(200).json({ connected: false, reason: "missing_token" });
    }

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

// ==============================
// ✅ Credits API
// ==============================

// Get credits
app.get("/api/credits", (req, res) => {
  res.json({ success: true, credits });
});

// Add credits (POST { amount: 100 })
app.post("/api/credits/add", (req, res) => {
  const amount = Number(req.body?.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ success: false, error: "invalid_amount" });
  }
  credits += amount;
  return res.json({ success: true, credits });
});

// Reset credits (POST { amount: 100 })
app.post("/api/credits/reset", (req, res) => {
  const amount = Number(req.body?.amount ?? DEFAULT_CREDITS);
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ success: false, error: "invalid_amount" });
  }
  credits = amount;
  return res.json({ success: true, credits });
});

// ==============================
// Replicate helpers
// ==============================
async function createPrediction(versionHash, input) {
  const resp = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({ version: versionHash, input }),
  });

  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from Replicate: ${text.slice(0, 300)}`);
  }

  if (!resp.ok) {
    const detail = json?.detail || json?.error || JSON.stringify(json);
    throw new Error(detail);
  }

  return json;
}

async function pollPrediction(getUrl) {
  const maxAttempts = 60;
  let attempts = 0;

  while (attempts < maxAttempts) {
    const r = await fetch(getUrl, {
      headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` },
    });
    const pred = await r.json();

    if (["succeeded", "failed", "canceled"].includes(pred.status)) {
      return pred;
    }

    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error("Prediction timed out after 3 minutes");
}

function normalizeOutputUrl(output) {
  if (!output) return null;
  if (Array.isArray(output)) return output[0] || null;
  if (typeof output === "string") return output;
  // sometimes models return objects
  return output.url || output.uri || output.output || null;
}

// ==============================
// Generate endpoint
// ==============================
app.post("/api/generate", upload.single("image"), async (req, res) => {
  // validate image
  if (!req.file) {
    return res.status(400).json({ error: "No image uploaded" });
  }

  // validate token
  if (!REPLICATE_API_TOKEN) {
    return res.status(500).json({ error: "API token not configured." });
  }

  // charge credits
  if (!spendCredits(1)) {
    return res.status(402).json({
      error: "No credits available",
      detail: "You have 0 credits. Please add credits to continue.",
      credits,
    });
  }

  try {
    const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString(
      "base64"
    )}`;

    const style = (req.body.style || "natural").toLowerCase();
    const density = (req.body.density || "medium").toLowerCase();
    const hairline = (req.body.hairline || "age-appropriate").toLowerCase();

    const prompt = buildHairPrompt(style, density, hairline);
    const negativePrompt = buildNegativePrompt();

    console.log(
      `[Follica] Generating... style=${style} density=${density} hairline=${hairline} credits_left=${credits}`
    );

    // Create prediction
    const prediction = await createPrediction(REALISTIC_VISION_V51_VERSION, {
      image: base64Image,
      prompt,
      negative_prompt: negativePrompt,

      // Protect identity
      prompt_strength: 0.35,
      num_inference_steps: 40,
      guidance_scale: 7,
      scheduler: "K_EULER_ANCESTRAL",
      disable_safety_checker: true,
    });

    // If succeeded immediately
    if (prediction.status === "succeeded" && prediction.output) {
      const outputUrl = normalizeOutputUrl(prediction.output);
      if (!outputUrl) throw new Error("Missing outputUrl in succeeded prediction");
      return res.json({ success: true, outputUrl, credits });
    }

    // Poll if needed
    if (prediction.urls?.get) {
      const result = await pollPrediction(prediction.urls.get);

      if (result.status === "succeeded") {
        const outputUrl = normalizeOutputUrl(result.output);
        if (!outputUrl) throw new Error("Missing outputUrl in succeeded result");
        return res.json({ success: true, outputUrl, credits });
      }

      // failed/canceled => refund
      refundCredits(1);
      return res.status(500).json({
        error: "Generation failed",
        detail: result.error || result.status || "Unknown error",
        credits,
      });
    }

    // unexpected => refund
    refundCredits(1);
    return res.status(500).json({
      error: "Unexpected Replicate response",
      detail: JSON.stringify(prediction).slice(0, 300),
      credits,
    });
  } catch (err) {
    console.error("[Follica Error]", err.message);
    refundCredits(1);
    return res.status(500).json({ error: "Server error", detail: err.message, credits });
  }
});

// ==============================
// Prompts
// ==============================
function buildHairPrompt(style, density, hairline) {
  // Light mapping (you can tune anytime)
  const densityMap = {
    low: "noticeably thicker hair with modest density",
    medium: "a full head of thick, dense hair",
    high: "very thick, very dense hair with maximum coverage",
  };
  const densityText = densityMap[density] || densityMap.medium;

  const styleMap = {
    natural: "natural textured hairstyle",
    straight: "straight hairstyle",
    wavy: "wavy hairstyle",
    curly: "curly hairstyle",
  };
  const styleText = styleMap[style] || styleMap.natural;

  const hairlineText =
    hairline === "youthful"
      ? "a youthful, natural-looking hairline"
      : hairline === "conservative"
      ? "a conservative, age-appropriate hairline"
      : "an age-appropriate, natural-looking hairline";

  return (
    `A professional portrait photograph of the same person. ` +
    `Hair transplant AFTER result: add realistic ${styleText}. ` +
    `The person now has ${densityText} and ${hairlineText}. ` +
    `All receding areas and bald spots are filled naturally. ` +
    `Keep the face, eyes, skin texture, facial structure, expression, clothing, lighting, and background identical to the original image. ` +
    `Photorealistic, high detail, natural hair texture, no wig.`
  );
}

function buildNegativePrompt() {
  return (
    "changed face, different person, altered facial features, distorted face, " +
    "changed eyes, blurry eyes, plastic skin, deformed, low quality, artifacts, " +
    "text, watermark, logo, celebrity lookalike, wig, unrealistic hairline"
  );
}

// Serve frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Follica AI Server running on port ${PORT}`);
  console.log(`📡 Replicate token: ${REPLICATE_API_TOKEN ? "✅ Configured" : "❌ Missing"}`);
  console.log(`💳 SaaS Credits (in-memory): ${credits}`);
});
