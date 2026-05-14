# StreamBot Dashboard — Setup Guide

## New Files
- `index.js` — updated bot with stream history logging
- `dashboard.js` — separate Express dashboard server (admin-only, localhost-bound)
- `public/index.html` — frontend (served by dashboard.js)

## New `.env` Variables

Add these to your existing `.env`:

```env
# Already have these:
DISCORD_TOKEN=...
TWITCH_CLIENT_ID=...
TWITCH_CLIENT_SECRET=...
CLIENT_ID=...

# New — add these:
DISCORD_CLIENT_SECRET=your_discord_app_client_secret
SESSION_SECRET=some-long-random-string-change-this
DASHBOARD_PORT=3001

# Comma-separated Discord user IDs allowed to access the dashboard
# Get your ID: Discord → Settings → Advanced → Developer Mode → right-click yourself → Copy ID
ADMIN_IDS=123456789012345678,987654321098765432

# Set after Tailscale is configured (see below)
DASHBOARD_URL=https://your-machine.tailnet-name.ts.net
COOKIE_SECURE=true
```

---

## Discord OAuth Setup (5 min)

1. Go to https://discord.com/developers/applications → your app
2. Click **OAuth2** in the sidebar
3. Under **Redirects**, add your callback URL (set this after Tailscale is set up):
   `https://your-machine.tailnet-name.ts.net/auth/callback`
4. Copy the **Client Secret** → put in `DISCORD_CLIENT_SECRET`

---

## Tailscale Setup

The dashboard binds to `127.0.0.1` only — it's not reachable from the network at all without Tailscale.

```bash
# Install on Pi Zero W
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Enable HTTPS via Tailscale (gives you a real cert, no self-signed warnings)
sudo tailscale serve https / http://localhost:3001

# Get your machine's Tailscale hostname
tailscale status
# e.g. your-pi.tailnet-name.ts.net
```

Then:
- Set `DASHBOARD_URL=https://your-pi.tailnet-name.ts.net` in `.env`
- Set `COOKIE_SECURE=true` in `.env`
- Update the Discord OAuth redirect to match
- Install Tailscale on any device you want dashboard access from

---

## Running Both Processes

Install new dep:
```bash
npm install express-session
```

Run with PM2 (recommended for Pi — survives crashes and reboots):
```bash
npm install -g pm2
pm2 start index.js --name bot
pm2 start dashboard.js --name dashboard
pm2 save
pm2 startup   # follow the printed command to enable autostart
```

---

## Access Control Summary

| Layer | What it does |
|-------|-------------|
| **Tailscale** | Network gate — only devices on your tailnet can reach the server at all |
| **Discord OAuth** | Identity — users must log in with Discord |
| **ADMIN_IDS** | Application gate — only listed Discord IDs get past the login screen |

Anyone not in `ADMIN_IDS` gets a `403 Access denied` page after OAuth. No data is ever served to them.

---

## What Gets Tracked

Each stream session logs:
- Title, game, start/end time
- Duration (minutes)
- Viewer samples every 60s → peak & average viewers
- Capped at 500 sessions per streamer

Dashboard shows per streamer:
- KPIs: total streams, avg duration, total hours, peak/avg viewers
- Streams by day of week
- Top 8 games
- Activity by hour heatmap
- Monthly stream count (last 6 months)
- Recent 20 sessions table