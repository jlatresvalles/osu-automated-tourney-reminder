require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, ChannelType, SlashCommandBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const packageJson = require('./package.json');

// Bot info
const BOT_VERSION = packageJson.version;
const BOT_CREATOR = 'jstyn';
const GITHUB_URL = 'https://github.com/jlatresvalles';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Store per-server configurations and auto-scan intervals
const serverConfigs = new Map();
const autoScanIntervals = new Map(); // Track active auto-scans per guild
const CONFIG_FILE = 'server_configs.json';
const PROCESSED_FILE = 'processed_tournaments.json';
const FORUM_URL = 'https://osu.ppy.sh/community/forums/55';

// Global processed tournaments (shared across all servers)
let processedTournaments = new Set();
const draftData = new Map();

// Role colors (Discord hex format)
const ROLE_COLORS = {
  'openrank': 0xEF4444, // Red
  '3digit': 0xA855F7,   // Purple
  '4digit': 0x22C55E,   // Green
  '5digit': 0x3B82F6,   // Blue
  '6digit': 0xEAB308    // Yellow
};

// Load server configurations
function loadServerConfigs() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      const configs = JSON.parse(data);
      Object.entries(configs).forEach(([guildId, config]) => {
        serverConfigs.set(guildId, config);
      });
      console.log(`Loaded configurations for ${serverConfigs.size} servers`);
    }
  } catch (error) {
    console.error('Error loading server configs:', error.message);
  }
}

// Save server configurations
function saveServerConfigs() {
  try {
    const configs = Object.fromEntries(serverConfigs);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2));
  } catch (error) {
    console.error('Error saving server configs:', error.message);
  }
}

// Load processed tournaments
function loadProcessedTournaments() {
  try {
    if (fs.existsSync(PROCESSED_FILE)) {
      const data = fs.readFileSync(PROCESSED_FILE, 'utf8');
      const array = JSON.parse(data);
      processedTournaments = new Set(array);
      console.log(`Loaded ${processedTournaments.size} previously seen tournaments`);
    }
  } catch (error) {
    console.error('Error loading processed tournaments:', error.message);
  }
}

// Save processed tournaments
function saveProcessedTournaments() {
  try {
    const array = Array.from(processedTournaments);
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify(array, null, 2));
  } catch (error) {
    console.error('Error saving processed tournaments:', error.message);
  }
}

// Parse rank range from text
function parseRankRange(text) {
  // Check for open rank keywords first
  if (/open\s*rank|no\s*rank|unrestricted|all\s*ranks/i.test(text)) {
    return { min: 1, max: 1000000, isOpen: true };
  }

  // Pattern 1: "1-10K", "100k-999k", "1k-5k"
  const kPattern = /(\d+)k?\s*[-–—]+\s*(\d+)k/i;
  const kMatch = text.match(kPattern);
  if (kMatch) {
    let min = parseInt(kMatch[1]);
    let max = parseInt(kMatch[2]);
    
    if (/\d+k/i.test(kMatch[0])) {
      min = min * 1000;
      max = max * 1000;
    }
    
    // Check if it's effectively open rank
    if (min <= 100 && max >= 10000) {
      return { min: 1, max: 1000000, isOpen: true };
    }
    
    // Check if inverted (e.g., #99-1)
    if (min > max) {
      return { min: 1, max: 1000000, isOpen: true };
    }
    
    return { min, max, isOpen: false };
  }

  // Pattern 2: Standard format "#1,000 - #99,999" or "1000-99999"
  const standardPattern = /#?(\d{1,3}(?:,\d{3})*)\s*[-–—]+\s*#?(\d{1,3}(?:,\d{3})*)/i;
  const standardMatch = text.match(standardPattern);
  if (standardMatch) {
    const min = parseInt(standardMatch[1].replace(/,/g, ''));
    const max = parseInt(standardMatch[2].replace(/,/g, ''));
    
    // Check if it's effectively open rank
    if (min <= 100 && max >= 10000) {
      return { min: 1, max: 1000000, isOpen: true };
    }
    
    // Check if inverted
    if (min > max) {
      return { min: 1, max: 1000000, isOpen: true };
    }
    
    return { min, max, isOpen: false };
  }

  // Pattern 3: Digit-based
  if (/3[\s-]?digit/i.test(text)) return { min: 100, max: 999, isOpen: false };
  if (/4[\s-]?digit/i.test(text)) return { min: 1000, max: 9999, isOpen: false };
  if (/5[\s-]?digit/i.test(text)) return { min: 10000, max: 99999, isOpen: false };
  if (/6[\s-]?digit/i.test(text)) return { min: 100000, max: 999999, isOpen: false };

  return null;
}

// Parse team size from text
function parseTeamSize(text) {
  const vPattern = /(\d+)v\d+/i;
  const vMatch = text.match(vPattern);
  if (vMatch) return vMatch[0];

  const tsPattern = /(\d+v\d+)\s*(?:ts|team\s*size)\s*(\d+)/i;
  const tsMatch = text.match(tsPattern);
  if (tsMatch) return `${tsMatch[1]} TS${tsMatch[2]}`;

  const teamSizePattern = /team\s*size\s*(\d+)/i;
  const teamSizeMatch = text.match(teamSizePattern);
  if (teamSizeMatch) return `TS${teamSizeMatch[1]}`;

  return 'Not detected';
}

// Determine which rank roles to ping
function getRankRolesToPing(rankRange, config) {
  if (!rankRange || !config) return [];

  if (rankRange.isOpen) {
    return config.roles.openrank ? ['openrank'] : [];
  }

  const roles = [];
  const { min, max } = rankRange;

  if (min <= 999 && max >= 100 && config.roles['3digit']) roles.push('3digit');
  if (min <= 9999 && max >= 1000 && config.roles['4digit']) roles.push('4digit');
  if (min <= 99999 && max >= 10000 && config.roles['5digit']) roles.push('5digit');
  if (max >= 100000 && config.roles['6digit']) roles.push('6digit');

  return roles;
}

// Scrape tournament forum posts
async function scrapeTournaments(limit = 20) {
  try {
    const response = await axios.get(FORUM_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    const tournaments = [];

    $('a.forum-topic-entry__title').each((i, elem) => {
      if (tournaments.length >= limit) return false;
      
      const title = $(elem).text().trim();
      const link = $(elem).attr('href');
      
      if (title && link) {
        const fullLink = link.startsWith('http') ? link : `https://osu.ppy.sh${link}`;
        tournaments.push({
          title,
          link: fullLink,
          isNew: !processedTournaments.has(fullLink)
        });
      }
    });

    return tournaments;
  } catch (error) {
    console.error('Error scraping tournaments:', error.message);
    return [];
  }
}

// Get tournament banner image
async function getTournamentBanner(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    const postContent = $('.forum-post-content').first();
    const firstImage = postContent.find('img').first();
    
    if (firstImage.length) {
      const imgSrc = firstImage.attr('src');
      if (imgSrc) {
        return imgSrc.startsWith('http') ? imgSrc : `https://osu.ppy.sh${imgSrc}`;
      }
    }
    
    const imageMatch = postContent.html()?.match(/https?:\/\/[^\s<>"]+?\.(?:png|jpg|jpeg|gif|webp)/i);
    if (imageMatch) return imageMatch[0];
    
    return null;
  } catch (error) {
    console.error('Error fetching banner:', error.message);
    return null;
  }
}

// Create draft embed
function createDraftEmbed(data, config) {
  const rankText = data.rankRange 
    ? (data.rankRange.isOpen ? 'Open Rank' : `${data.rankRange.min.toLocaleString()} - ${data.rankRange.max.toLocaleString()}`)
    : 'Not detected';

  const rankRoles = getRankRolesToPing(data.rankRange, config);
  const rolesText = rankRoles.length > 0 ? rankRoles.map(r => `@${r}`).join(', ') : 'None';

  let description = `**Name:** ${data.name}\n`;
  description += `**Link:** ${data.link}\n`;
  description += `**Rank Range:** ${rankText}\n`;
  description += `**Team Size:** ${data.teamSize}\n`;
  if (data.banner) description += `**Banner:** Found ✓\n`;
  if (data.comments) description += `\n**Additional Info:**\n${data.comments}`;
  description += `\n\n**Will ping:** ${rolesText}`;

  const embed = new EmbedBuilder()
    .setColor('#FF66AA')
    .setTitle('🎮 Tournament Draft')
    .setDescription(description)
    .setTimestamp();
  
  if (data.banner) embed.setImage(data.banner);

  return embed;
}

// Create action buttons
function createActionButtons(tournamentId) {
  const row1 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_${tournamentId}`)
        .setLabel('✅ Approve & Send')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`deny_${tournamentId}`)
        .setLabel('❌ Deny')
        .setStyle(ButtonStyle.Danger)
    );
  
  const row2 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`edit_${tournamentId}`)
        .setLabel('✏️ Edit Details')
        .setStyle(ButtonStyle.Primary)
    );

  return [row1, row2];
}

// Format final announcement
function formatAnnouncement(data, rankRoles, config) {
  const mentions = rankRoles
    .map(role => config.roles[role])
    .filter(roleId => roleId)
    .map(roleId => `<@&${roleId}>`)
    .join(' ');

  const rankDisplay = data.rankRange.isOpen 
    ? 'Open Rank' 
    : `${data.rankRange.min.toLocaleString()}-${data.rankRange.max.toLocaleString()}`;
  
  let description = `### Forum Post\n${data.link}\n\n`;
  description += `**Format:** ${data.teamSize}\n**Rank:** ${rankDisplay}`;
  
  if (data.comments) {
    const formattedComments = data.comments
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => `-# ${line}`)
      .join('\n');
    description += `\n\n${formattedComments}`;
  }

  const embed = new EmbedBuilder()
    .setColor('#3b82f6')
    .setTitle(data.name)
    .setDescription(description)
    .setFooter({ text: `Bot by ${BOT_CREATOR}` });
  
  if (data.banner) embed.setImage(data.banner);

  return { content: mentions, embed };
}

// Check for new tournaments (for a specific server)
async function checkTournaments(guildId) {
  const config = serverConfigs.get(guildId);
  if (!config) {
    console.log(`No configuration found for guild ${guildId}`);
    return;
  }

  console.log(`Checking tournaments for guild ${guildId}...`);
  
  const isFirstRun = processedTournaments.size === 0;
  const limit = isFirstRun ? 20 : 100;
  
  const tournaments = await scrapeTournaments(limit);
  const tournamentsToShow = isFirstRun ? tournaments : tournaments.filter(t => t.isNew);
  
  if (tournamentsToShow.length === 0) {
    console.log('No new tournaments to show');
    return;
  }

  console.log(`Showing ${tournamentsToShow.length} tournaments`);
  const channel = await client.channels.fetch(config.draftChannelId);

  for (const tournament of tournamentsToShow) {
    const rankRange = parseRankRange(tournament.title);
    const teamSize = parseTeamSize(tournament.title);
    const banner = await getTournamentBanner(tournament.link);

    const tournamentId = Buffer.from(tournament.link).toString('base64').substring(0, 80);
    
    const data = {
      guildId,
      name: tournament.title,
      link: tournament.link,
      rankRange,
      teamSize,
      comments: '',
      banner: banner || ''
    };
    
    draftData.set(tournamentId, data);

    const embed = createDraftEmbed(data, config);
    const buttons = createActionButtons(tournamentId);

    await channel.send({ embeds: [embed], components: buttons });

    processedTournaments.add(tournament.link);
    console.log(`Posted draft for: ${tournament.title}`);

    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  saveProcessedTournaments();
}

// Handle interactions
client.on('interactionCreate', async interaction => {
  try {
    // Handle slash commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'setup') {
        await handleSetupCommand(interaction);
      } else if (interaction.commandName === 'about') {
        await handleAboutCommand(interaction);
      } else if (interaction.commandName === 'scan') {
        await handleScanCommand(interaction);
      } else if (interaction.commandName === 'autoscan') {
        await handleAutoScanCommand(interaction);
      }
      return;
    }

    // Handle modal submission
    if (interaction.isModalSubmit()) {
      const tournamentId = interaction.customId.replace('edit_modal_', '');
      const data = draftData.get(tournamentId);
      
      if (!data) {
        await interaction.reply({ content: '❌ Tournament data not found', ephemeral: true });
        return;
      }

      data.name = interaction.fields.getTextInputValue('name_input');
      
      const rankRangeStr = interaction.fields.getTextInputValue('rank_range_input').trim();
      if (/open\s*rank|open|unrestricted|all\s*ranks|no\s*rank/i.test(rankRangeStr)) {
        data.rankRange = { min: 1, max: 1000000, isOpen: true };
      } else {
        const rankParts = rankRangeStr.split('-').map(s => parseInt(s.trim().replace(/,/g, '')));
        if (rankParts.length === 2 && !isNaN(rankParts[0]) && !isNaN(rankParts[1])) {
          data.rankRange = { min: rankParts[0], max: rankParts[1], isOpen: false };
        }
      }
      
      data.teamSize = interaction.fields.getTextInputValue('team_size_input');
      data.banner = interaction.fields.getTextInputValue('banner_input') || '';
      data.comments = interaction.fields.getTextInputValue('comments_input') || '';

      draftData.set(tournamentId, data);

      const config = serverConfigs.get(data.guildId);
      const updatedEmbed = createDraftEmbed(data, config);
      const buttons = createActionButtons(tournamentId);

      await interaction.update({ embeds: [updatedEmbed], components: buttons });
      console.log(`✅ Draft updated by ${interaction.user.tag}`);
      return;
    }

    // Handle button clicks
    if (!interaction.isButton()) return;

    const [action, tournamentId] = interaction.customId.split('_');
    const data = draftData.get(tournamentId);
    
    if (!data) {
      await interaction.reply({ content: '❌ Tournament data not found', ephemeral: true });
      return;
    }

    const config = serverConfigs.get(data.guildId);

    if (action === 'edit') {
      const modal = new ModalBuilder()
        .setCustomId(`edit_modal_${tournamentId}`)
        .setTitle('Edit Tournament Details');

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('name_input')
            .setLabel('Tournament Name')
            .setStyle(TextInputStyle.Short)
            .setValue(data.name)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('rank_range_input')
            .setLabel('Rank Range (e.g., 10000-99999 or "open")')
            .setStyle(TextInputStyle.Short)
            .setValue(data.rankRange ? (data.rankRange.isOpen ? 'Open Rank' : `${data.rankRange.min}-${data.rankRange.max}`) : '1-999999')
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('team_size_input')
            .setLabel('Team Size (e.g., 3v3, 2v2 TS4, 1v1)')
            .setStyle(TextInputStyle.Short)
            .setValue(data.teamSize)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('banner_input')
            .setLabel('Banner Image URL (optional)')
            .setStyle(TextInputStyle.Short)
            .setValue(data.banner || '')
            .setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('comments_input')
            .setLabel('Additional Info (host, notes, etc.)')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(data.comments || '')
            .setRequired(false)
        )
      );

      await interaction.showModal(modal);
      
    } else if (action === 'approve') {
      await interaction.deferUpdate();

      const rankRoles = getRankRolesToPing(data.rankRange, config);
      const announcement = formatAnnouncement(data, rankRoles, config);

      const announcementChannel = await client.channels.fetch(config.announcementChannelId);
      await announcementChannel.send({
        content: announcement.content,
        embeds: [announcement.embed]
      });

      await interaction.editReply({
        content: '✅ **Approved and sent!**',
        embeds: [],
        components: []
      });

      draftData.delete(tournamentId);
      console.log(`✅ Tournament approved by ${interaction.user.tag}`);

    } else if (action === 'deny') {
      await interaction.deferUpdate();

      await interaction.editReply({
        content: '❌ **Denied and discarded**',
        embeds: [],
        components: []
      });

      draftData.delete(tournamentId);
      console.log(`❌ Tournament denied by ${interaction.user.tag}`);
    }

  } catch (error) {
    console.error('❌ ERROR:', error);
    console.error(error.stack);
  }
});

// Handle /setup command
async function handleSetupCommand(interaction) {
  if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: '❌ You need Administrator permissions to use this command.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const guild = interaction.guild;
    const announcementChannel = interaction.options.getChannel('announcement_channel');

    // Create or find roles
    const roles = {};
    const roleNames = {
      'openrank': 'Open Rank Tourney Pings',
      '3digit': '3 Digit Tourney Pings',
      '4digit': '4 Digit Tourney Pings',
      '5digit': '5 Digit Tourney Pings',
      '6digit': '6 Digit Tourney Pings'
    };

    for (const [key, name] of Object.entries(roleNames)) {
      let role = guild.roles.cache.find(r => r.name === name);
      if (!role) {
        role = await guild.roles.create({
          name: name,
          color: ROLE_COLORS[key],
          mentionable: true,
          reason: 'osu! Tournament Bot Setup'
        });
        console.log(`Created role: ${name}`);
      } else {
        console.log(`Found existing role: ${name}`);
      }
      roles[key] = role.id;
    }

    // Create draft channel
    let draftChannel = guild.channels.cache.find(c => c.name === 'tournament-review');
    if (!draftChannel) {
      draftChannel = await guild.channels.create({
        name: 'tournament-review',
        type: ChannelType.GuildText,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel]
          },
          {
            id: guild.members.me.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
          }
        ],
        reason: 'osu! Tournament Bot Setup'
      });
      console.log('Created #tournament-review channel');
    }

    // Save configuration
    const config = {
      guildId: guild.id,
      draftChannelId: draftChannel.id,
      announcementChannelId: announcementChannel.id,
      roles: roles
    };

    serverConfigs.set(guild.id, config);
    saveServerConfigs();

    const embed = new EmbedBuilder()
      .setColor('#22C55E')
      .setTitle('✅ Setup Complete!')
      .setDescription(
        `**Roles Created/Found:**\n` +
        `${Object.values(roleNames).map(name => `• @${name}`).join('\n')}\n\n` +
        `**Channels:**\n` +
        `• Draft Review: ${draftChannel}\n` +
        `• Announcements: ${announcementChannel}\n\n` +
        `**Next Steps:**\n` +
        `• Use \`/scan\` for a quick 1-minute check\n` +
        `• Use \`/autoscan start\` for continuous monitoring\n` +
        `• Drafts will appear in ${draftChannel}\n` +
        `• Use \`/about\` to learn more\n\n` +
        `💙 This bot was created by **${BOT_CREATOR}**\n` +
        `⭐ Star on GitHub: ${GITHUB_URL}`
      );

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('Setup error:', error);
    await interaction.editReply({ content: `❌ Setup failed: ${error.message}` });
  }
}

// Handle /about command
async function handleAboutCommand(interaction) {
  const embed = new EmbedBuilder()
    .setColor('#3b82f6')
    .setTitle('🎮 osu! Tournament Notification Bot')
    .setDescription(
      `This bot gets a list of the most recent tournaments posted in the osu! community website, and is sent out to the public after being approved. A tourney can either be rejected, accepted, or edited for more information.`
    )
    .addFields(
      {
        name: '✨ Key Features',
        value: 
          '• Auto-detects rank ranges and team sizes\n' +
          '• Fetches tournament banners automatically\n' +
          '• Smart role-based pinging\n' +
          '• Edit tournaments before posting\n' +
          '• Multi-server support',
        inline: false
      },
      {
        name: '📝 Commands',
        value:
          '`/setup` - Initial server setup (Admin only)\n' +
          '`/scan` - Quick scan for 1 minute (Admin only)\n' +
          '`/autoscan start` - Start continuous scanning (Admin only)\n' +
          '`/autoscan stop` - Stop continuous scanning (Admin only)\n' +
          '`/autoscan status` - Check scan status (Admin only)\n' +
          '`/about` - Show this information',
        inline: false
      },
      {
        name: '👤 Creator',
        value: `**${BOT_CREATOR}**\n[GitHub](${GITHUB_URL})`,
        inline: true
      },
      {
        name: '📌 Version',
        value: BOT_VERSION,
        inline: true
      },
      {
        name: '🎨 Banner Art',
        value: 'Artwork by [h3p0](https://osu.ppy.sh/users/18091103) from osu! Winter 2025 Fanart Contest',
        inline: false
      }
    )
    .setImage('https://assets.ppy.sh/contests/269/entries/Arrogant%20Monitor.jpg')
    .setThumbnail('https://upload.wikimedia.org/wikipedia/commons/d/d3/Osu%21Logo_%282015%29.png')
    .setFooter({ text: `Bot by ${BOT_CREATOR}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// Handle /scan command (one-time scan for 1 minute)
async function handleScanCommand(interaction) {
  if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: '❌ You need Administrator permissions to use this command.', ephemeral: true });
    return;
  }

  const config = serverConfigs.get(interaction.guild.id);
  if (!config) {
    await interaction.reply({ content: '❌ Server not configured. Run `/setup` first.', ephemeral: true });
    return;
  }

  await interaction.reply({ content: '🔍 Starting quick scan... Will check for up to 1 minute or until new tournaments are found.', ephemeral: true });

  const startTime = Date.now();
  const maxDuration = 60000; // 1 minute
  const checkInterval = 10000; // Check every 10 seconds
  let foundNew = false;

  const scanLoop = setInterval(async () => {
    const elapsed = Date.now() - startTime;
    
    if (elapsed >= maxDuration || foundNew) {
      clearInterval(scanLoop);
      if (!foundNew) {
        await interaction.followUp({ content: '⏱️ Scan complete. No new tournaments found in the last minute.', ephemeral: true });
      }
      return;
    }

    console.log(`Scanning... (${Math.round(elapsed / 1000)}s elapsed)`);
    const tournaments = await scrapeTournaments(50);
    const newTournaments = tournaments.filter(t => t.isNew);

    if (newTournaments.length > 0) {
      foundNew = true;
      clearInterval(scanLoop);
      await checkTournaments(interaction.guild.id);
      await interaction.followUp({ content: `✅ Found ${newTournaments.length} new tournament(s)! Check ${config.draftChannelId ? `<#${config.draftChannelId}>` : 'the draft channel'}.`, ephemeral: true });
    }
  }, checkInterval);
}

// Handle /autoscan command (continuous scanning)
async function handleAutoScanCommand(interaction) {
  if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: '❌ You need Administrator permissions to use this command.', ephemeral: true });
    return;
  }

  const config = serverConfigs.get(interaction.guild.id);
  if (!config) {
    await interaction.reply({ content: '❌ Server not configured. Run `/setup` first.', ephemeral: true });
    return;
  }

  const action = interaction.options.getString('action');

  if (action === 'start') {
    if (autoScanIntervals.has(interaction.guild.id)) {
      await interaction.reply({ content: '⚠️ Auto-scan is already running! Use `/autoscan stop` to stop it.', ephemeral: true });
      return;
    }

    // Start continuous scanning every 5 minutes
    const intervalId = setInterval(async () => {
      console.log(`Auto-scan running for guild ${interaction.guild.id}`);
      await checkTournaments(interaction.guild.id);
    }, 300000); // 5 minutes

    autoScanIntervals.set(interaction.guild.id, intervalId);

    await interaction.reply({ 
      content: '✅ **Auto-scan started!**\n' +
               '🔄 The bot will now check for tournaments every 5 minutes.\n' +
               '⏹️ Use `/autoscan stop` to stop scanning.',
      ephemeral: true 
    });

    // Do an immediate check
    await checkTournaments(interaction.guild.id);

  } else if (action === 'stop') {
    const intervalId = autoScanIntervals.get(interaction.guild.id);
    
    if (!intervalId) {
      await interaction.reply({ content: '⚠️ Auto-scan is not running.', ephemeral: true });
      return;
    }

    clearInterval(intervalId);
    autoScanIntervals.delete(interaction.guild.id);

    await interaction.reply({ content: '⏹️ **Auto-scan stopped.** Use `/autoscan start` to resume.', ephemeral: true });

  } else if (action === 'status') {
    const isRunning = autoScanIntervals.has(interaction.guild.id);
    
    const embed = new EmbedBuilder()
      .setColor(isRunning ? '#22C55E' : '#6B7280')
      .setTitle('🔍 Auto-Scan Status')
      .setDescription(
        isRunning 
          ? '✅ **Status:** Running\n⏱️ **Interval:** Every 5 minutes\n⏹️ Use `/autoscan stop` to stop.'
          : '⏸️ **Status:** Not running\n▶️ Use `/autoscan start` to begin scanning.'
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
}

// Message commands (admin only)
client.on('messageCreate', async message => {
  if (message.content === '!check') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      await message.reply('❌ Only administrators can use this command.');
      return;
    }

    const config = serverConfigs.get(message.guild.id);
    if (!config) {
      await message.reply('❌ Server not configured. Run `/setup` first.');
      return;
    }

    await checkTournaments(message.guild.id);
    await message.reply('🔍 Checking for tournaments...');
  }
});

client.on('ready', async () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log(`║  osu! Tournament Bot by ${BOT_CREATOR.padEnd(17)}║`);
  console.log(`║  GitHub: ${GITHUB_URL.padEnd(30)}║`);
  console.log(`║  Version: v${BOT_VERSION.padEnd(31)}║`);
  console.log('╚════════════════════════════════════════════╝\n');
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📦 Running version ${BOT_VERSION}`);
  
  loadServerConfigs();
  loadProcessedTournaments();

  // Register slash commands
  const commands = [
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Setup the tournament bot for this server')
      .addChannelOption(option =>
        option.setName('announcement_channel')
          .setDescription('Channel for tournament announcements')
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('about')
      .setDescription('Learn about this bot'),
    new SlashCommandBuilder()
      .setName('scan')
      .setDescription('Quick scan for tournaments (checks for 1 minute then stops)'),
    new SlashCommandBuilder()
      .setName('autoscan')
      .setDescription('Manage continuous tournament scanning')
      .addStringOption(option =>
        option.setName('action')
          .setDescription('Action to perform')
          .setRequired(true)
          .addChoices(
            { name: 'Start auto-scan', value: 'start' },
            { name: 'Stop auto-scan', value: 'stop' },
            { name: 'Check status', value: 'status' }
          ))
  ].map(command => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('✅ Slash commands registered');
  } catch (error) {
    console.error('Error registering commands:', error);
  }

  console.log('\n💡 Tip: Use /scan for quick checks or /autoscan start for continuous monitoring');
});

// Cleanup on shutdown
process.on('SIGINT', () => {
  console.log('\n⏹️ Shutting down...');
  
  // Clear all auto-scan intervals
  for (const [guildId, intervalId] of autoScanIntervals) {
    clearInterval(intervalId);
    console.log(`Stopped auto-scan for guild ${guildId}`);
  }
  
  console.log('✅ Cleanup complete. Goodbye!');
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);