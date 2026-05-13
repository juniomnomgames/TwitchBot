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
    if (!fs.existsSync(DATA_FILE)) return {};
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.log("data.json corrupted, resetting...");
    return {};
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getStreamers() {
  const data = loadData();

  return Object.entries(data).map(([discordId, twitch]) => ({
    discordId,
    twitch
  }));
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
  const channel = await client.channels.fetch(process.env.PROMO_CHANNEL);
  if (!channel) return;

  const streamers = getStreamers();

  for (const user of streamers) {
    try {
      const stream = await checkStreamer(user.twitch);

      if (stream) {
        if (!liveNow.has(user.twitch)) {
          liveNow.add(user.twitch);

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

          const member = await channel.guild.members.fetch(user.discordId).catch(() => null);

          await channel.send({
            content: member ? `🔴 ${member} is LIVE on Twitch!` : "🔴 Someone is LIVE!",
            embeds: [embed],
          });

          console.log("LIVE:", user.twitch);
        }
      } else {
        liveNow.delete(user.twitch);
      }
    } catch (err) {
      console.log("Error checking", user.twitch, err.message);
    }
  }
}

// -------------------- SLASH COMMANDS --------------------

const commands = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Twitch account")
    .addStringOption(opt =>
      opt.setName("username")
        .setDescription("Your Twitch username")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("testlive")
    .setDescription("Test live Twitch embed message"),

  new SlashCommandBuilder()
    .setName("postlive")
    .setDescription("Manually post a Twitch live alert")
    .addStringOption(opt =>
      opt.setName("username")
        .setDescription("Twitch username")
        .setRequired(true)
    )
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

async function registerCommands() {
  try {
    console.log("Registering slash commands...");

    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );

    console.log("Slash commands registered SUCCESSFULLY");
  } catch (err) {
    console.error("Command register error:", err);
  }
}

// -------------------- EVENTS --------------------

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await getTwitchToken();
  await registerCommands();

  setInterval(monitor, 60000);
});

// -------------------- INTERACTIONS --------------------

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  console.log("Slash command received:", interaction.commandName);

  // ---------------- LINK ----------------
  if (interaction.commandName === "link") {
    const twitch = interaction.options.getString("username");

    const data = loadData();
    data[interaction.user.id] = twitch;
    saveData(data);

    return interaction.reply({
      content: `✅ Linked successfully!\nDiscord: <@${interaction.user.id}>\nTwitch: **${twitch}**`,
      ephemeral: false
    });
  }

  // ---------------- TEST LIVE ----------------
  if (interaction.commandName === "testlive") {
    const channel = await client.channels.fetch(process.env.PROMO_CHANNEL);

    const fakeStream = {
      user_name: "TEST STREAMER",
      title: "This is a test stream 🚀",
      game_name: "Testing System",
      viewer_count: 999,
      thumbnail_url:
        "https://static-cdn.jtvnw.net/previews-ttv/live_user_test-{width}x{height}"
    };

    const embed = new EmbedBuilder()
      .setTitle(`${fakeStream.user_name} is LIVE 🔴`)
      .setURL(`https://twitch.tv/test`)
      .setDescription(fakeStream.title)
      .addFields(
        { name: "Game", value: fakeStream.game_name, inline: true },
        { name: "Viewers", value: String(fakeStream.viewer_count), inline: true }
      )
      .setImage(
        fakeStream.thumbnail_url
          .replace("{width}", "1280")
          .replace("{height}", "720")
      )
      .setColor("Purple");

    await channel.send({
      content: `🔴 <@${interaction.user.id}> triggered a LIVE TEST`,
      embeds: [embed],
    });

    return interaction.reply({
      content: "✅ Test live message sent!",
      ephemeral: true
    });
  }

  // ---------------- POST LIVE ----------------
  if (interaction.commandName === "postlive") {
    const twitchName = interaction.options.getString("username");

    const stream = await checkStreamer(twitchName);

    if (!stream) {
      return interaction.reply({
        content: `❌ ${twitchName} is NOT live right now.`,
        ephemeral: true
      });
    }

    const channel = await client.channels.fetch(process.env.PROMO_CHANNEL);

    const embed = new EmbedBuilder()
      .setTitle(`${stream.user_name} is LIVE 🔴`)
      .setURL(`https://twitch.tv/${twitchName}`)
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
      content: `🔴 Manual alert triggered for **${twitchName}**`,
      embeds: [embed],
    });

    return interaction.reply({
      content: `✅ Posted live alert for **${twitchName}**`,
      ephemeral: true
    });
  }
});

// -------------------- LOGIN --------------------

client.login(process.env.DISCORD_TOKEN);