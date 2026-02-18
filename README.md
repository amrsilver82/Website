# Ramadan Notifier — Setup Guide

## Step 1: Generate VAPID Keys (do this once)

Install web-push globally and generate keys:

```bash
npm install -g web-push
web-push generate-vapid-keys
```

You will get:
- Public Key
- Private Key

Save both — you will need them in Step 3.

---

## Step 2: Upload to GitHub

1. Go to github.com → New repository → name it `ramadan-notifier`
2. Upload all these files to the repo
3. Commit

---

## Step 3: Deploy on Render

1. Go to render.com → New → Web Service
2. Connect your GitHub repo
3. Settings:
   - Environment: **Node**
   - Build Command: `npm install`
   - Start Command: `node server.js`
4. Add Environment Variables:
   - `VAPID_PUBLIC_KEY` = (your public key from Step 1)
   - `VAPID_PRIVATE_KEY` = (your private key from Step 1)
5. Click Deploy!

---

## Step 4: Use the App on iPhone

1. Copy your Render app URL (e.g. `https://ramadan-notifier.onrender.com`)
2. Open it in **Safari** on your iPhone
3. Tap **Share** → **Add to Home Screen**
4. Open the app from home screen
5. Tap **Enable Notifications** and allow
6. Tap **Send Test Notification** to confirm it works

Done! You will receive notifications automatically every day. 🌙
