# Follica AI — Hair Transplant Visualization

AI-powered before & after hair transplant visualization SaaS. Upload a photo, get realistic AI-generated results showing potential hair transplant outcomes.

## 🚀 Deploy to Render (FREE — No coding required)

### Step 1: Push to GitHub

1. Go to your repo: `https://github.com/djmnzz/follica-ai`
2. Delete any old files in the repo
3. Upload ALL files from this folder:
   - `server.js`
   - `package.json`
   - `render.yaml`
   - `.gitignore`
   - `public/index.html`

### Step 2: Deploy on Render

1. Go to **https://render.com** → Sign up with GitHub
2. Click **"New +"** → **"Web Service"**
3. Connect your `follica-ai` repository
4. Render will auto-detect settings from `render.yaml`
5. **Add Environment Variable:**
   - Key: `REPLICATE_API_TOKEN`
   - Value: Your Replicate API token
6. Click **"Create Web Service"**
7. Wait 2-3 minutes for deployment
8. Your app will be live at: `https://follica-ai.onrender.com`

### Step 3: Verify API Token

Make sure your Replicate token is active:
- Go to: https://replicate.com/account/api-tokens
- If expired, create a new one and update it in Render's Environment Variables

## 💡 How It Works

- **Frontend**: Single HTML page served by Express (no build step needed)
- **Backend**: Node.js/Express proxy that calls Replicate's Stable Diffusion XL API
- **AI Model**: Uses img2img with optimized prompts for hair transplant visualization
- **Credits**: Local storage-based credit system (10 free on signup)

## 📁 Project Structure

```
follica-ai/
├── server.js          # Express backend + Replicate API proxy
├── package.json       # Dependencies
├── render.yaml        # Render deployment config
├── .gitignore
└── public/
    └── index.html     # Complete frontend (auth, generate, history, pricing)
```

## 🔧 Local Development

```bash
npm install
REPLICATE_API_TOKEN=your_token npm start
# Open http://localhost:3001
```
