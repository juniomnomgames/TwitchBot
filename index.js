require("dotenv").config();
const fs = require("fs");
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

const DATA_FILE = "./data.json";

// -------------------- DATA --------------------

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { guilds: {}, users: {} };
    }

    const raw = fs.readFileSync(DATA_FILE, "utf8");
    if (!raw) return { guilds: {}, users: {} };

    const parsed = JSON.parse(raw);

    return {
      guilds: parsed.guilds || {},
      users: parsed.users || {}
    };
  } catch (e) {
    console.log("data.json corrupted, resetting...");
    return { guilds: {}, users: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getStreamers() {
  const data = loadData();
  return Object.entries(data.users).map(([discordId, twitch]) => ({
    discordId,
    twitch
  }));
}

function getGuildChannel(guildId) {
  const data = loadData();
  return data.guilds?.[guildId]?.channel || null;
}

// -------------------- TWITCH --------------------

let twitchToken = null;
const liveNow = new Set();

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
    } catch (e) {
      continue;
    }

    for (const guildId of Object.keys(guilds)) {
      const guildConfig = guilds[guildId];
      const channelId = guildConfig.channel;

      if (!channelId) continue;

      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) continue;

        const liveKey = `${guildId}-${user.twitch}`;

        if (stream) {
          if (!liveNow.has(liveKey)) {
            liveNow.add(liveKey);

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
          liveNow.delete(liveKey);
        }
      } catch (e) {
        console.log("Guild error:", e.message);
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
        .setDescription("Channel for live alerts")
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
    .setDescription("Test live alert"),

  new SlashCommandBuilder()
    .setName("postlive")
    .setDescription("Manually post live alert")
    .addStringOption(opt =>
      opt.setName("username")
        .setDescription("Twitch username")
        .setRequired(true)
    )
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

async function registerCommands() {
  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    { body: commands }
  );

  console.log("Slash commands registered");
}

// -------------------- EVENTS --------------------

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await getTwitchToken();
  await registerCommands();

  setInterval(async () => {
    try {
      await monitor();
    } catch (e) {
      console.error("Monitor error:", e);
    }
  }, 60000);
});

// -------------------- COMMANDS --------------------

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const data = loadData();

  // ---------------- SETUP ----------------
  if (interaction.commandName === "setup") {
    if (!interaction.memberPermissions.has("Administrator")) {
      return interaction.reply({ content: "Admin only.", ephemeral: true });
    }

    const channel = interaction.options.getChannel("channel");

    data.guilds[interaction.guild.id] = {
      channel: channel.id
    };

    saveData(data);

    return interaction.reply({
      content: `Setup complete → ${channel}`,
      ephemeral: true
    });
  }

  // ---------------- CHANNEL CHANGE ----------------
  if (interaction.commandName === "channel") {
    const channel = interaction.options.getChannel("channel");

    data.guilds[interaction.guild.id] = {
      channel: channel.id
    };

    saveData(data);

    return interaction.reply({
      content: `Channel updated → ${channel}`,
      ephemeral: true
    });
  }

  // ---------------- LINK ----------------
  if (interaction.commandName === "link") {
    const twitch = interaction.options.getString("username");

    data.users[interaction.user.id] = twitch;
    saveData(data);

    return interaction.reply({
      content: `Linked to **${twitch}**`,
      ephemeral: false
    });
  }

  // ---------------- TEST LIVE ----------------
  if (interaction.commandName === "testlive") {
    const channelId = getGuildChannel(interaction.guild.id);

    if (!channelId) {
      return interaction.reply({
        content: "Run /setup first",
        ephemeral: true
      });
    }

    const channel = await client.channels.fetch(channelId);

    await channel.send({
      content: `🔴 TEST ALERT from <@${interaction.user.id}>`
    });

    return interaction.reply({ content: "Sent test", ephemeral: true });
  }

  // ---------------- POST LIVE ----------------
  if (interaction.commandName === "postlive") {
    const twitch = interaction.options.getString("username");

    const stream = await checkStreamer(twitch);

    if (!stream) {
      return interaction.reply({ content: "Not live", ephemeral: true });
    }

    const channelId = getGuildChannel(interaction.guild.id);

    if (!channelId) {
      return interaction.reply({ content: "Run /setup first", ephemeral: true });
    }

    const channel = await client.channels.fetch(channelId);

    await channel.send({
      content: `🔴 Manual: **${stream.user_name}** is LIVE!`
    });

    return interaction.reply({ content: "Posted", ephemeral: true });
  }
});

// ---------------- LOGIN ----------------

client.login(process.env.DISCORD_TOKEN);