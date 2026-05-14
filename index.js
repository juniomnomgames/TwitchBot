require("dotenv").config();
const fs = require("fs");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  Routes,
  REST
} = require("discord.js");
const axios = require("axios");

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// -------------------- DATA --------------------

const DATA_FILE = "./data.json";

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

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getGuildChannel(guildId) {
  const data = loadData();
  return data.guilds?.[guildId]?.channel || null;
}

function getStreamers() {
  const data = loadData();
  return Object.entries(data.users).map(([discordId, twitch]) => ({
    discordId,
    twitch
  }));
}

// -------------------- HISTORY LOGGING --------------------

// key = twitch_login -> { streamId, startedAt, peakViewers }
const sessionMeta = new Map();

function logStreamStart(twitchLogin, stream) {
  const data = loadData();
  if (!data.history[twitchLogin]) data.history[twitchLogin] = [];

  const entry = {
    id: stream.id,
    title: stream.title,
    game: stream.game_name || "Unknown",
    startedAt: new Date().toISOString(),
    endedAt: null,
    peakViewers: stream.viewer_count,
    avgViewers: stream.viewer_count,
    viewerSamples: [stream.viewer_count]
  };

  data.history[twitchLogin].push(entry);
  // Keep last 500 sessions per streamer
  if (data.history[twitchLogin].length > 500) {
    data.history[twitchLogin] = data.history[twitchLogin].slice(-500);
  }

  saveData(data);
  sessionMeta.set(twitchLogin, { streamId: stream.id, startedAt: entry.startedAt });
  console.log(`[history] Logged stream start for ${twitchLogin}`);
}

function logViewerSample(twitchLogin, stream) {
  const data = loadData();
  if (!data.history[twitchLogin]) return;

  const meta = sessionMeta.get(twitchLogin);
  if (!meta) return;

  const sessions = data.history[twitchLogin];
  const entry = sessions.find(s => s.id === meta.streamId);
  if (!entry) return;

  entry.viewerSamples.push(stream.viewer_count);
  entry.peakViewers = Math.max(entry.peakViewers, stream.viewer_count);
  entry.avgViewers = Math.round(
    entry.viewerSamples.reduce((a, b) => a + b, 0) / entry.viewerSamples.length
  );

  saveData(data);
}

function logStreamEnd(twitchLogin) {
  const meta = sessionMeta.get(twitchLogin);
  if (!meta) return;

  const data = loadData();
  if (!data.history[twitchLogin]) return;

  const entry = data.history[twitchLogin].find(s => s.id === meta.streamId);
  if (entry && !entry.endedAt) {
    entry.endedAt = new Date().toISOString();
    const durationMs = new Date(entry.endedAt) - new Date(entry.startedAt);
    entry.durationMinutes = Math.round(durationMs / 60000);
    saveData(data);
    console.log(`[history] Logged stream end for ${twitchLogin} (${entry.durationMinutes}m)`);
  }

  sessionMeta.delete(twitchLogin);
}

// -------------------- TWITCH --------------------

let twitchToken = null;
// key = guildId:twitch -> lastStreamId
const liveCache = new Map();

async function getTwitchToken() {
  const res = await axios.post(
    "https://id.twitch.tv/oauth2/token",
    null,
    {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: "client_credentials",
      },
    }
  );
  twitchToken = res.data.access_token;
  console.log("Twitch token loaded");
}

async function checkStreamer(user_login) {
  const res = await axios.get(
    `https://api.twitch.tv/helix/streams?user_login=${user_login}`,
    {
      headers: {
        "Client-Id": process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${twitchToken}`,
      },
    }
  );
  return res.data.data[0] || null;
}

// -------------------- MONITOR --------------------

async function monitor() {
  const data = loadData();
  const guilds = data.guilds || {};
  const streamers = getStreamers();

  for (const user of streamers) {
    let stream;
    try {
      stream = await checkStreamer(user.twitch);
    } catch {
      continue;
    }

    // Track viewer samples for active sessions
    if (stream && sessionMeta.has(user.twitch)) {
      logViewerSample(user.twitch, stream);
    }

    for (const guildId of Object.keys(guilds)) {
      const channelId = guilds[guildId]?.channel;
      if (!channelId) continue;

      const key = `${guildId}:${user.twitch}`;

      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) continue;

        if (stream) {
          if (liveCache.get(key) !== stream.id) {
            liveCache.set(key, stream.id);

            // Log history on new session (only once, not per guild)
            if (guildId === Object.keys(guilds)[0]) {
              logStreamStart(user.twitch, stream);
            }

            const embed = new EmbedBuilder()
              .setTitle(`${stream.user_name} is LIVE 🔴`)
              .setURL(`https://twitch.tv/${user.twitch}`)
              .setDescription(stream.title)
              .addFields(
                { name: "Game", value: stream.game_name || "Unknown", inline: true },
                { name: "Viewers", value: String(stream.viewer_count), inline: true }
              )
              .setImage(
                stream.thumbnail_url
                  .replace("{width}", "1280")
                  .replace("{height}", "720") +
                `?t=${Date.now()}`
              )
              .setColor("Purple");

            await channel.send({
              content: `🔴 **${stream.user_name}** is LIVE!`,
              embeds: [embed],
            });
          }
        } else {
          if (liveCache.has(key)) {
            liveCache.delete(key);
            // End session when all guilds show offline (track per streamer)
            const stillLiveAnywhere = [...liveCache.keys()].some(k => k.endsWith(`:${user.twitch}`));
            if (!stillLiveAnywhere) {
              logStreamEnd(user.twitch);
            }
          }
        }

      } catch (err) {
        console.log("Monitor error:", err.message);
      }
    }
  }
}

// -------------------- SLASH COMMANDS --------------------

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Set Twitch alert channel")
    .addChannelOption(opt =>
      opt.setName("channel")
        .setDescription("Live alert channel")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("channel")
    .setDescription("Change alert channel")
    .addChannelOption(opt =>
      opt.setName("channel")
        .setDescription("New alert channel")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link Twitch account")
    .addStringOption(opt =>
      opt.setName("username")
        .setDescription("Twitch username")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("testlive")
    .setDescription("Test alert"),

  new SlashCommandBuilder()
    .setName("postlive")
    .setDescription("Manual live post")
    .addStringOption(opt =>
      opt.setName("username")
        .setDescription("Twitch username")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("dashboard")
    .setDescription("Get a link to your stream stats dashboard"),

].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

async function registerCommands() {
  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    { body: commands }
  );
  console.log("Slash commands registered");
}

// -------------------- BOT EVENTS --------------------

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await getTwitchToken();
  await registerCommands();

  setInterval(async () => {
    try {
      await monitor();
    } catch (e) {
      console.error("Monitor crash:", e);
    }
  }, 60000);
});

// -------------------- COMMANDS --------------------

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const data = loadData();

  if (interaction.commandName === "setup") {
    if (!interaction.memberPermissions.has("Administrator")) {
      return interaction.reply({ content: "Admin only", ephemeral: true });
    }
    const channel = interaction.options.getChannel("channel");
    data.guilds[interaction.guild.id] = { channel: channel.id };
    saveData(data);
    return interaction.reply({ content: `Setup complete → ${channel}`, ephemeral: true });
  }

  if (interaction.commandName === "channel") {
    const channel = interaction.options.getChannel("channel");
    data.guilds[interaction.guild.id] = { channel: channel.id };
    saveData(data);
    return interaction.reply({ content: `Channel updated → ${channel}`, ephemeral: true });
  }

  if (interaction.commandName === "link") {
    const twitch = interaction.options.getString("username");
    data.users[interaction.user.id] = twitch;
    saveData(data);
    return interaction.reply({ content: `Linked → **${twitch}**`, ephemeral: false });
  }

  if (interaction.commandName === "testlive") {
    const channelId = getGuildChannel(interaction.guild.id);
    if (!channelId) return interaction.reply({ content: "Run /setup first", ephemeral: true });
    const channel = await client.channels.fetch(channelId);
    await channel.send("🔴 TEST ALERT");
    return interaction.reply({ content: "Sent", ephemeral: true });
  }

  if (interaction.commandName === "postlive") {
    const twitch = interaction.options.getString("username");
    const stream = await checkStreamer(twitch);
    if (!stream) return interaction.reply({ content: "Not live", ephemeral: true });
    const channelId = getGuildChannel(interaction.guild.id);
    if (!channelId) return interaction.reply({ content: "Run /setup first", ephemeral: true });
    const channel = await client.channels.fetch(channelId);
    await channel.send(`🔴 **${stream.user_name}** is LIVE (manual)`);
    return interaction.reply({ content: "Posted", ephemeral: true });
  }

  if (interaction.commandName === "dashboard") {
    const dashUrl = process.env.DASHBOARD_URL || `http://localhost:3001`;
    return interaction.reply({
      content: `📊 View your stream stats: ${dashUrl}`,
      ephemeral: true
    });
  }
});

// -------------------- LOGIN --------------------

client.login(process.env.DISCORD_TOKEN);