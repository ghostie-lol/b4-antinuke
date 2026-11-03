require("dotenv").config();
const {
  Client, GatewayIntentBits, AuditLogEvent, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits, ChannelType
} = require("discord.js");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration]
});
const trusted = new Set((process.env.TRUSTED_ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean));
const strikes = new Map();
const WINDOW_MS = 12_000;
const LIMIT = 3;

async function log(guild, message) {
  const channel = guild.channels.cache.get(process.env.LOG_CHANNEL_ID);
  if (channel?.isTextBased()) await channel.send({ content: message }).catch(() => {});
}
function trustedUser(guild, id) {
  return id === guild.ownerId || trusted.has(id);
}
async function findExecutor(guild, action, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type: action, limit: 5 });
    const entry = logs.entries.find(e =>
      e.target?.id === targetId && Date.now() - e.createdTimestamp < 8_000
    );
    return entry?.executor || null;
  } catch { return null; }
}
async function flag(guild, user, reason) {
  if (!user || user.bot || trustedUser(guild, user.id)) return;
  const key = `${guild.id}:${user.id}`;
  const now = Date.now();
  const recent = (strikes.get(key) || []).filter(t => now - t < WINDOW_MS);
  recent.push(now);
  strikes.set(key, recent);
  await log(guild, `⚠️ **Antinuke alert**\nUser: <@${user.id}> (${user.id})\nAction: ${reason}\nRecent suspicious actions: ${recent.length}`);
  if (recent.length >= LIMIT) {
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (member?.moderatable) {
      await member.timeout(10 * 60 * 1000, `Antinuke: ${reason}`).catch(() => {});
      await log(guild, `🛡️ Timed out <@${user.id}> for 10 minutes. Review the audit log.`);
    } else {
      await log(guild, `Could not timeout <@${user.id}>. Ensure the bot role is above theirs.`);
    }
  }
}

client.on("channelDelete", async channel => {
  const executor = await findExecutor(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
  await flag(channel.guild, executor, `Deleted channel: ${channel.name}`);
});
client.on("roleDelete", async role => {
  const executor = await findExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
  await flag(role.guild, executor, `Deleted role: ${role.name}`);
});
client.on("guildBanAdd", async ban => {
  const executor = await findExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  await flag(ban.guild, executor, `Banned member: ${ban.user.tag}`);
});
client.on("guildMemberRemove", async member => {
  const executor = await findExecutor(member.guild, AuditLogEvent.MemberKick, member.id);
  if (executor) await flag(member.guild, executor, `Kicked member: ${member.user?.tag || member.id}`);
});
client.on("guildMemberAdd", async member => {
  if (!member.user.bot) return;
  const executor = await findExecutor(member.guild, AuditLogEvent.BotAdd, member.id);
  if (executor) await flag(member.guild, executor, `Added bot: ${member.user.tag}`);
});

const commands = [
  new SlashCommandBuilder().setName("antinuke-status").setDescription("Show antinuke protection status"),
  new SlashCommandBuilder().setName("deletechannels").setDescription("Owner-only channel cleanup")
    .addStringOption(o => o.setName("confirm").setDescription('Type DELETE CHANNELS to confirm').setRequired(true))
].map(c => c.toJSON());

client.once("ready", async () => {
  console.log(`Ready as ${client.user.tag}`);
  if (process.env.GUILD_ID && process.env.CLIENT_ID) {
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    console.log("Registered guild slash commands");
  }
});
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "antinuke-status") {
    return interaction.reply({ ephemeral: true, content: "🛡️ Antinuke monitoring is online. Alerts are sent to the configured security log channel." });
  }
  if (interaction.commandName === "deletechannels") {
    if (interaction.user.id !== interaction.guild.ownerId) {
      return interaction.reply({ ephemeral: true, content: "Only the server owner can use this command." });
    }
    if (process.env.ENABLE_CHANNEL_CLEANUP !== "true") {
      return interaction.reply({ ephemeral: true, content: "Channel cleanup is disabled. Set ENABLE_CHANNEL_CLEANUP=true to enable it." });
    }
    if (interaction.options.getString("confirm") !== "DELETE CHANNELS") {
      return interaction.reply({ ephemeral: true, content: 'Confirmation did not match. Type exactly: DELETE CHANNELS' });
    }
    await interaction.reply({ ephemeral: true, content: "Cleanup started. Deleting channels except the security log channel…" });
    const guild = interaction.guild;
    const channels = [...guild.channels.cache.values()].filter(c => c.id !== process.env.LOG_CHANNEL_ID);
    for (const channel of channels) await channel.delete("Owner-confirmed channel cleanup").catch(() => {});
    await log(guild, `Owner <@${interaction.user.id}> ran channel cleanup. Attempted ${channels.length} deletions.`);
  }
});
client.login(process.env.DISCORD_TOKEN);
