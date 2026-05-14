require("dotenv").config();
const express = require("express");
const session = require("express-session");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3001;
const DATA_FILE = path.join(__dirname, "./data.json");

// -------------------- DATA --------------------

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { guilds: {}, users: {}, history: {} };
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    if (!raw) return { guilds: {}, users: {}, history: {} };
    const parsed = JSON.parse(raw);
    return {
      guilds: parsed.guilds || {},
      users: parsed.users || {},
      history: parsed.history || {}
    };
  } catch {
    return { guilds: {}, users: {}, history: {} };
  }
}

// -------------------- ADMIN LIST --------------------

// Comma-separated Discord user IDs in .env: ADMIN_IDS=123456789,987654321
function getAdminIds() {
  const raw = process.env.ADMIN_IDS || "";
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

function isAdmin(discordId) {
  return getAdminIds().has(discordId);
}

// -------------------- SESSION --------------------

app.use(session({
  secret: process.env.SESSION_SECRET || "changeme-use-a-random-string",
  resave: false,
  saveUninitialized: false,
  cookie: {
    // Tailscale HTTPS → set secure: true and use `tailscale serve`
    // Local HTTP → keep false
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

app.use(express.static(path.join(__dirname, "public")));

// -------------------- DISCORD OAUTH --------------------

const DISCORD_CLIENT_ID = process.env.CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.DASHBOARD_URL
  ? `${process.env.DASHBOARD_URL}/auth/callback`
  : `http://localhost:${PORT}/auth/callback`;

app.get("/auth/login", (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "identify"
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect("/?error=no_code");

  try {
    // Exchange code for token
    const tokenRes = await axios.post(
      "https://discord.com/api/oauth2/token",
      new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        scope: "identify"
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const accessToken = tokenRes.data.access_token;

    // Get Discord user info
    const userRes = await axios.get("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const discordUser = userRes.data;
    const data = loadData();

    // Admin gate — only Discord IDs in ADMIN_IDS env var get in
    if (!isAdmin(discordUser.id)) {
      return res.status(403).send(`
        <!DOCTYPE html><html><head>
        <style>
          body{background:#0a0a0f;color:#e8e8f0;font-family:monospace;display:flex;
               align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:1rem}
          .code{color:#a855f7;font-size:2rem}
          .msg{color:#6b6b80;font-size:0.85rem}
          a{color:#a855f7;font-size:0.75rem}
        </style></head><body>
        <div class="code">403</div>
        <div>Access denied.</div>
        <div class="msg">Your Discord account is not authorised for this dashboard.</div>
        <a href="/">← back</a>
        </body></html>
      `);
    }

    const twitchLogin = data.users[discordUser.id];

    req.session.user = {
      discordId: discordUser.id,
      username: discordUser.username,
      avatar: discordUser.avatar,
      twitchLogin: twitchLogin || null
    };

    res.redirect("/");
  } catch (err) {
    console.error("OAuth error:", err.message);
    res.redirect("/?error=oauth_failed");
  }
});

app.get("/auth/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/");
});

// -------------------- AUTH MIDDLEWARE --------------------

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Not authenticated" });
  if (!isAdmin(req.session.user.discordId)) return res.status(403).json({ error: "Forbidden" });
  next();
}

// -------------------- API ROUTES --------------------

// Current session user info
app.get("/api/me", (req, res) => {
  if (!req.session.user) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: req.session.user });
});

// Get stats for a specific twitch user
app.get("/api/stats/:twitchLogin", requireAdmin, (req, res) => {
  const { twitchLogin } = req.params;
  const data = loadData();

  const allTwitchUsers = Object.values(data.users);
  if (!allTwitchUsers.includes(twitchLogin)) {
    return res.status(404).json({ error: "Streamer not found" });
  }

  const sessions = data.history[twitchLogin] || [];
  res.json(buildStats(twitchLogin, sessions));
});

// Get all streamers list
app.get("/api/streamers", requireAdmin, (req, res) => {
  const data = loadData();
  const streamers = Object.entries(data.users).map(([discordId, twitch]) => {
    const sessions = data.history[twitch] || [];
    const lastSession = sessions.filter(s => s.endedAt).slice(-1)[0];
    const liveNow = sessions.some(s => !s.endedAt);
    return {
      discordId,
      twitch,
      totalSessions: sessions.length,
      lastStream: lastSession?.startedAt || null,
      liveNow
    };
  });
  res.json(streamers);
});

// -------------------- STATS BUILDER --------------------

function buildStats(twitchLogin, sessions) {
  const completed = sessions.filter(s => s.endedAt);
  const totalStreams = sessions.length;
  const totalMinutes = completed.reduce((a, s) => a + (s.durationMinutes || 0), 0);
  const avgDuration = completed.length ? Math.round(totalMinutes / completed.length) : 0;
  const peakViewers = sessions.reduce((a, s) => Math.max(a, s.peakViewers || 0), 0);
  const avgViewers = sessions.length
    ? Math.round(sessions.reduce((a, s) => a + (s.avgViewers || 0), 0) / sessions.length)
    : 0;

  // Game frequency
  const gameCounts = {};
  for (const s of sessions) {
    const g = s.game || "Unknown";
    gameCounts[g] = (gameCounts[g] || 0) + 1;
  }
  const topGames = Object.entries(gameCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([game, count]) => ({ game, count }));

  // Streams by day of week
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayCount = Array(7).fill(0);
  for (const s of sessions) {
    if (s.startedAt) {
      const d = new Date(s.startedAt).getDay();
      dayCount[d]++;
    }
  }
  const streamsByDay = dayNames.map((name, i) => ({ day: name, count: dayCount[i] }));

  // Streams by hour of day
  const hourCount = Array(24).fill(0);
  for (const s of sessions) {
    if (s.startedAt) {
      const h = new Date(s.startedAt).getHours();
      hourCount[h]++;
    }
  }
  const streamsByHour = hourCount.map((count, hour) => ({ hour, count }));

  // Recent sessions (last 20)
  const recentSessions = sessions
    .slice(-20)
    .reverse()
    .map(s => ({
      title: s.title,
      game: s.game,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationMinutes: s.durationMinutes,
      peakViewers: s.peakViewers,
      avgViewers: s.avgViewers
    }));

  // Monthly stream count (last 6 months)
  const now = new Date();
  const monthly = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleString("default", { month: "short", year: "2-digit" });
    const count = sessions.filter(s => {
      if (!s.startedAt) return false;
      const sd = new Date(s.startedAt);
      return sd.getFullYear() === d.getFullYear() && sd.getMonth() === d.getMonth();
    }).length;
    monthly.push({ label, count });
  }

  return {
    twitchLogin,
    totalStreams,
    totalMinutes,
    avgDuration,
    peakViewers,
    avgViewers,
    topGames,
    streamsByDay,
    streamsByHour,
    recentSessions,
    monthly,
    liveNow: sessions.some(s => !s.endedAt)
  };
}

// -------------------- START --------------------

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Dashboard running on http://127.0.0.1:${PORT}`);
  console.log(`OAuth redirect URI: ${REDIRECT_URI}`);
  if (!process.env.ADMIN_IDS) {
    console.warn("⚠️  WARNING: ADMIN_IDS is not set — no one can log in!");
  } else {
    console.log(`Admin IDs: ${process.env.ADMIN_IDS}`);
  }
});