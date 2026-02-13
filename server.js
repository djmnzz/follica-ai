// server.js
// Follica AI Server + SaaS Credits (in-memory)
// - Adds /api/credits, /api/credits/add, /api/credits/reset
// - Charges 1 credit per /api/generate (refunds on failure)

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
const DEFAULT_CREDITS = Number(process.env.DEFAULT_CREDITS || 100); // start with 100
let credits = Number.isFinite(DEFAULT_CREDITS) ? DEFAULT_CREDITS : 100;

function spendCredits(amount = 1) {
  if (credits < amount) return false;
  credits -= amount;
  return true;
}
function refundCredits(amount = 1) {
  credits += amount;
}

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Multer for file uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files allowed"), false);
  },
});

// ==============================
// ✅ Credits API
// ==============================

// Get current credits
app.get("/api/credits", (req, res) => {
  res.json({ success: true, credits });
});

// Add credits (e.g. { "amount": 100 })
app.post("/api/credits/add", (req, res) => {
  const amount = Number(req.body?.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ success: false, error: "invalid_amount" });
  }
  credits += amount;
  return res.json({ success: true, credits });
});

// Reset credits (optional) (e.g. { "amount": 100 })
app.post("/api/credits/reset", (req, res) => {
  const amount = Number(req.body?.amount ?? DEFAULT_CREDITS);
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ success: false, error: "invalid_amount" });
  }
  credits = amount;
  return res.json({ success: true, credits });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    hasApiKey: !!REPLICATE_API_TOKEN,
    credits,
    timestamp: new Date().toISOString(),
    version: "11.1 - Professional Descriptive Style (No Celebs) + SaaS Credits",
  });
});

// Generate AI hair transplant result
app.post("/api/generate", upload.single("image"), async (req, res) => {
  // 1) Validate input
  if (!req.file) {
    return res.status(400).json({ error: "No image uploaded" });
  }

  // 2) Validate Replicate token
  if (!REPLICATE_API_TOKEN) {
    return res.status(500).json({ error: "API token not configured." });
  }

  // 3) Charge 1 credit upfront
  const charged = spendCredits(1);
  if (!charged) {
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
    const style = req.body.style || "natural";
    const density = req.body.density || "medium";
    const hairline = req.body.hairline || "age-appropriate";

    const prompt = buildHairPrompt(style, density, hairline);
    const negativePrompt = buildNegativePrompt();

    console.log(
      `[Generate] Starting PRO Descriptive - Style: ${style} | Credits left after charge: ${credits}`
    );

    const createResponse = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
      body: JSON.stringify({
        // Realistic Vision V5.1
        version: "9936c2001faa2194a261c01381f90e65261879985476014a0a37a334593a05eb",
        input: {
          image: base64Image,
          prompt: prompt,
          negative_prompt: negativePrompt,
          // Keep identity
          prompt_strength: 0.35,
          num_inference_steps: 40,
          guidance_scale: 7,
          scheduler: "K_EULER_ANCESTRAL",
          disable_safety_checker: true,
        },
      }),
    });

    const responseText = await createResponse.text();
    console.log(`[Generate] API response status: ${createResponse.status}`);

    let prediction;
    try {
      prediction = JSON.parse(responseText);
    } catch (e) {
      console.error("[Generate] Failed to parse response:", responseText.substring(0, 500));
      refundCredits(1); // refund on failure
      return res.status(500).json({
        error: "Invalid API response",
        detail: responseText.substring(0, 200),
        credits,
      });
    }

    if (!createResponse.ok) {
      console.error("[Generate] API error:", prediction);
      refundCredits(1); // refund on failure
      return res.status(createResponse.status).json({
        error: "API error",
        detail: prediction.detail || prediction.error || JSON.stringify(prediction),
        credits,
      });
    }

    // Sometimes "Prefer: wait" returns succeeded immediately
    if (prediction.status === "succeeded" && prediction.output) {
      const outputUrl = Array.isArray(prediction.output)
        ? prediction.output[0]
        : prediction.output;
      console.log("[Generate] Instant success!");
      return res.json({ success: true, outputUrl, credits });
    }

    // Otherwise poll
    if (prediction.id) {
      console.log(`[Generate] Prediction created: ${prediction.id}, polling...`);
      const result = await pollPrediction(
        prediction.urls?.get || `https://api.replicate.com/v1/predictions/${prediction.id}`
      );

      if (result.status === "succeeded") {
        const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output;
        console.log("[Generate] Success!");
        return res.json({ success: true, outputUrl, credits });
      } else {
        console.error("[Generate] Failed:", result.error);
        refundCredits(1); // refund on failure
        return res.status(500).json({
          error: "Generation failed",
          detail: result.error || "Unknown error",
          credits,
        });
      }
    }

    // Unexpected response => refund
    refundCredits(1);
    return res.status(500).json({
      error: "Unexpected API response",
      detail: JSON.stringify(prediction).substring(0, 200),
      credits,
    });
  } catch (error) {
    console.error("[Generate] Server error:", error.message);
    refundCredits(1); // refund on failure
    res.status(500).json({ error: "Server error", detail: error.message, credits });
  }
});

async function pollPrediction(url) {
  const maxAttempts = 60;
  let attempts = 0;

  while (attempts < maxAttempts) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` },
    });
    const prediction = await response.json();
    console.log(`[Poll] Status: ${prediction.status} (${attempts * 3}s)`);

    if (["succeeded", "failed", "canceled"].includes(prediction.status)) {
      return prediction;
    }

    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error("Prediction timed out after 3 minutes");
}

// PROMPTS (NO CELEBS)
function buildHairPrompt(style, density, hairline) {
  // You can expand these mappings later if you want
  return `Based on image_0.png, the man now has a full head of ultra-thick, dense, healthy hair. It is a modern, professionally groomed hairstyle with perfect volume. All receding areas and bald spots are completely filled in with a sharp, flawless, youthful hairline with absolutely no recession. The hair texture is realistic. Crucially, the man's face, facial structure, skin, eyes, expression, clothing, and the background are absolutely identical to image_0.png. Only the hair changed. Photorealistic, 8k, highly detailed.`;
}

function buildNegativePrompt() {
  return "changed face, different person, altered facial features, plastic surgery look, distorted face, blurry eyes, receding hairline, bald spots, thinning hair, low quality, ugly, deformed, watermark, text, celebrity lookalike";
}

// Serve frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Follica AI Server running on port ${PORT}`);
  console.log(`📡 API Token: ${REPLICATE_API_TOKEN ? "✅ Configured" : "❌ Missing"}`);
  console.log(`💳 SaaS Credits (in-memory): ${credits}`);
});
