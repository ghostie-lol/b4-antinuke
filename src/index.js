require("dotenv").config();
const {
  Client, GatewayIntentBits, AuditLogEvent, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits, ChannelType,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle
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

function getTemplateCode(input) {
  const value = input.trim();
  const match = value.match(/(?:discord\.new\/|discord\.com\/template\/)([a-zA-Z0-9-]+)/i);
  if (match) return match[1];
  if (/^[a-zA-Z0-9-]{5,100}$/.test(value)) return value;
  return null;
}
function channelType(type) {
  const supported = new Set([
    ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory,
    ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice,
    ChannelType.GuildForum, ChannelType.GuildMedia
  ]);
  return supported.has(type) ? type : null;
}
function previewChannel(channel) {
  const prefix = channel.type === ChannelType.GuildCategory ? "📁" :
    channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice ? "🔊" :
    channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia ? "🗂️" : "#";
  return `${prefix} ${channel.name}`;
}
function templateOverwrites(sourceChannel, sourceGuildId, targetGuild) {
  const overwrites = [];
  for (const overwrite of sourceChannel.permission_overwrites || sourceChannel.permissionOverwrites || []) {
    const id = String(overwrite.id);
    const type = Number(overwrite.type);
    // Role overwrites are intentionally excluded. Only @everyone and existing members can map safely.
    if (type === 0 && id === String(sourceGuildId)) {
      overwrites.push({
        id: targetGuild.id,
        type: 0,
        allow: String(overwrite.allow ?? "0"),
        deny: String(overwrite.deny ?? "0")
      });
    } else if (type === 1 && targetGuild.members.cache.has(id)) {
      overwrites.push({
        id,
        type: 1,
        allow: String(overwrite.allow ?? "0"),
        deny: String(overwrite.deny ?? "0")
      });
    }
  }
  return overwrites;
}
async function applyTemplate(guild, templateSource) {
  const templateChannels = templateSource.channels || [];
  const valid = templateChannels
    .filter(c => channelType(c.type) !== null)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const categories = new Map();
  const channelIds = new Map();
  let created = 0;
  let failed = 0;

  async function createOne(source) {
    const type = channelType(source.type);
    const options = {
      name: source.name,
      type,
      reason: "Apply approved Discord server template without copying roles",
      permissionOverwrites: templateOverwrites(source, templateSource.id, guild)
    };
    const parentId = source.parent_id || source.parentId;
    if (parentId && categories.has(parentId)) options.parent = categories.get(parentId);
    if (source.topic && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(type)) options.topic = source.topic;
    if (typeof source.nsfw === "boolean" && [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia].includes(type)) options.nsfw = source.nsfw;
    const slowmode = source.rate_limit_per_user ?? source.rateLimitPerUser;
    if (Number.isInteger(slowmode) && [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia].includes(type)) options.rateLimitPerUser = slowmode;
    const archive = source.default_auto_archive_duration ?? source.defaultAutoArchiveDuration;
    if (Number.isInteger(archive)) options.defaultAutoArchiveDuration = archive;
    const bitrate = source.bitrate;
    if (Number.isInteger(bitrate) && [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(type)) options.bitrate = bitrate;
    const userLimit = source.user_limit ?? source.userLimit;
    if (Number.isInteger(userLimit) && type === ChannelType.GuildVoice) options.userLimit = userLimit;
    if (source.rtc_region || source.rtcRegion) options.rtcRegion = source.rtc_region || source.rtcRegion;
    if (source.video_quality_mode || source.videoQualityMode) options.videoQualityMode = source.video_quality_mode || source.videoQualityMode;
    if (Number.isInteger(source.rate_limit_per_user) && type === ChannelType.GuildText) options.rateLimitPerUser = source.rate_limit_per_user;
    const createdChannel = await guild.channels.create(options);
    channelIds.set(source.id, createdChannel.id);
    if (type === ChannelType.GuildCategory) categories.set(source.id, createdChannel.id);
    created++;
  }

  for (const source of valid.filter(c => c.type === ChannelType.GuildCategory)) {
    try { await createOne(source); } catch { failed++; }
  }
  for (const source of valid.filter(c => c.type !== ChannelType.GuildCategory)) {
    try { await createOne(source); } catch { failed++; }
  }

  // Restore channel ordering after creation, without touching existing channels.
  try {
    const positions = valid
      .filter(c => channelIds.has(c.id))
      .map(c => ({ channel: channelIds.get(c.id), position: c.position ?? 0 }));
    if (positions.length) await guild.channels.setPositions(positions);
  } catch { /* Position limits or permission issues do not invalidate created channels. */ }

  // Apply supported guild-level settings. Role definitions and role assignments are never copied.
  const settings = {};
  const settingMap = {
    verification_level: "verificationLevel",
    default_message_notifications: "defaultMessageNotifications",
    explicit_content_filter: "explicitContentFilter",
    preferred_locale: "preferredLocale",
    afk_timeout: "afkTimeout",
    description: "description",
    system_channel_flags: "systemChannelFlags"
  };
  for (const [sourceKey, targetKey] of Object.entries(settingMap)) {
    if (templateSource[sourceKey] !== undefined && templateSource[sourceKey] !== null) {
      settings[targetKey] = templateSource[sourceKey];
    }
  }
  const mappedChannels = [
    ["afk_channel_id", "afkChannel"],
    ["system_channel_id", "systemChannel"],
    ["rules_channel_id", "rulesChannel"],
    ["public_updates_channel_id", "publicUpdatesChannel"]
  ];
  for (const [sourceKey, targetKey] of mappedChannels) {
    const mapped = channelIds.get(templateSource[sourceKey]);
    if (mapped) settings[targetKey] = mapped;
  }
  let settingsApplied = false;
  if (Object.keys(settings).length) {
    try { await guild.edit(settings, "Apply approved template settings without copying roles"); settingsApplied = true; }
    catch { settingsApplied = false; }
  }
  return {
    created,
    failed,
    skipped: templateChannels.length - valid.length,
    settingsApplied,
    overwritesCopied: true
  };
}

const commands = [
  new SlashCommandBuilder().setName("antinuke-status").setDescription("Show antinuke protection status"),
  new SlashCommandBuilder().setName("deletechannels").setDescription("Owner-only channel cleanup")
    .addStringOption(o => o.setName("confirm").setDescription('Type DELETE CHANNELS to confirm').setRequired(true)),
  new SlashCommandBuilder().setName("template").setDescription("Preview and apply a Discord server template channel layout")
    .addStringOption(o => o.setName("link").setDescription("Discord server template link or template code").setRequired(true))
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
  if (interaction.isButton() && interaction.customId.startsWith("template:")) {
    const [, action, ownerId] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ ephemeral: true, content: "Only the person who started this preview can confirm it." });
    }
    const pending = client.templatePreviews?.get(ownerId);
    if (!pending) return interaction.update({ content: "This template preview expired. Run /template again.", embeds: [], components: [] });
    client.templatePreviews.delete(ownerId);
    if (action === "cancel") {
      return interaction.update({ content: "Template cancelled. No channels were created.", embeds: [], components: [] });
    }
    await interaction.update({ content: "Applying the approved channel layout…", embeds: [], components: [] });
    const result = await applyTemplate(interaction.guild, pending.source);
    await interaction.editReply({
      content: `Template finished. Created **${result.created}** channels/categories. Failed: **${result.failed}**. Unsupported types skipped: **${result.skipped}**. Server settings: **${result.settingsApplied ? "applied" : "not applied or none available"}**. Role definitions were not copied. Existing channels were not changed or deleted.`
    });
    await log(interaction.guild, `Template layout applied by <@${ownerId}>. Created ${result.created}; failed ${result.failed}; skipped ${result.skipped}.`);
    return;
  }

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
    return;
  }

  if (interaction.commandName === "template") {
    if (!interaction.guild) return interaction.reply({ ephemeral: true, content: "Use this command inside a server." });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.reply({ ephemeral: true, content: "You need Manage Channels permission to use this command." });
    }
    const me = interaction.guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.reply({ ephemeral: true, content: "I need the Manage Channels permission to create the template layout." });
    }
    const code = getTemplateCode(interaction.options.getString("link", true));
    if (!code) return interaction.reply({ ephemeral: true, content: "That doesn't look like a valid Discord template link or code." });
    await interaction.deferReply({ ephemeral: true });
    let template;
    try {
      const response = await fetch(`https://discord.com/api/v10/guilds/templates/${encodeURIComponent(code)}`);
      if (!response.ok) throw new Error(`Template lookup returned HTTP ${response.status}`);
      template = await response.json();
    } catch (error) {
      return interaction.editReply("I couldn't load that template. Check the link and make sure the template is public and valid.");
    }
    const source = template.serialized_source_guild || template.serializedSourceGuild;
    const channels = source?.channels;
    if (!Array.isArray(channels) || channels.length === 0) {
      return interaction.editReply("That template has no readable channel layout.");
    }
    const supported = channels.filter(c => channelType(c.type) !== null);
    const categories = supported.filter(c => c.type === ChannelType.GuildCategory);
    const others = supported.filter(c => c.type !== ChannelType.GuildCategory);
    const preview = supported.slice(0, 35).map(previewChannel).join("\n");
    const embed = new EmbedBuilder()
      .setColor(0xD71920)
      .setTitle(`Template preview: ${template.name || "Discord server"}`)
      .setDescription(`${preview}${supported.length > 35 ? `\n…and ${supported.length - 35} more` : ""}`)
      .addFields(
        { name: "Categories", value: String(categories.length), inline: true },
        { name: "Other channels", value: String(others.length), inline: true },
        { name: "Total to create", value: String(supported.length), inline: true },\n        { name: "Role copying", value: "Disabled", inline: true },\n        { name: "Server settings", value: "Included where supported", inline: true },\n        { name: "Permission overwrites", value: "Compatible @everyone and existing-member rules", inline: true }
      )
      .setFooter({ text: "Copies supported server settings, channel layout and compatible channel permissions. Roles are never copied; existing channels are not deleted." });
    client.templatePreviews ||= new Map();
    client.templatePreviews.set(interaction.user.id, { source });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`template:confirm:${interaction.user.id}`).setLabel("Create channels").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`template:cancel:${interaction.user.id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );
    const message = await interaction.editReply({ embeds: [embed], components: [row] });
    const collector = message.createMessageComponentCollector({ time: 60_000, max: 1 });
    collector.on("end", collected => {
      if (collected.size === 0) {
        client.templatePreviews?.delete(interaction.user.id);
        interaction.editReply({ content: "Template preview expired. No channels were created.", embeds: [], components: [] }).catch(() => {});
      }
    });
  }
});
client.login(process.env.DISCORD_TOKEN);
