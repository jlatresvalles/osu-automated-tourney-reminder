require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

// Configuration
const CONFIG = {
  TOKEN: process.env.DISCORD_TOKEN,
  DRAFT_CHANNEL_ID: process.env.DRAFT_CHANNEL_ID,
  ANNOUNCEMENT_CHANNEL_ID: process.env.ANNOUNCEMENT_CHANNEL_ID,
  CHECK_INTERVAL: 3600000, // Check every hour (in milliseconds)
  FORUM_URL: 'https://osu.ppy.sh/community/forums/55',
  PROCESSED_FILE: 'processed_tournaments.json', // File to store seen tournaments
  RANK_ROLES: {
    'openrank': process.env.OPENRANK_ROLE_ID,
    '3digit': process.env.THREE_DIGIT_ROLE_ID,
    '4digit': process.env.FOUR_DIGIT_ROLE_ID,
    '5digit': process.env.FIVE_DIGIT_ROLE_ID,
    '6digit': process.env.SIX_DIGIT_ROLE_ID
  }
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Store processed tournaments and draft data
let processedTournaments = new Set();
const draftData = new Map();

// Load processed tournaments from file
function loadProcessedTournaments() {
  try {
    if (fs.existsSync(CONFIG.PROCESSED_FILE)) {
      const data = fs.readFileSync(CONFIG.PROCESSED_FILE, 'utf8');
      const array = JSON.parse(data);
      processedTournaments = new Set(array);
      console.log(`Loaded ${processedTournaments.size} previously seen tournaments`);
    }
  } catch (error) {
    console.error('Error loading processed tournaments:', error.message);
  }
}

// Save processed tournaments to file
function saveProcessedTournaments() {
  try {
    const array = Array.from(processedTournaments);
    fs.writeFileSync(CONFIG.PROCESSED_FILE, JSON.stringify(array, null, 2));
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
    
    // Check if it's effectively open rank (min <= 100 and max >= 10000)
    if (min <= 100 && max >= 10000) {
      return { min: 1, max: 1000000, isOpen: true };
    }
    
    // Check if inverted (e.g., #99-1)
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
  // Pattern 1: "3v3", "2v2", "1v1"
  const vPattern = /(\d+)v\d+/i;
  const vMatch = text.match(vPattern);
  if (vMatch) {
    return vMatch[0];
  }

  // Pattern 2: "2v2 TS4", "3v3 Team Size 5"
  const tsPattern = /(\d+v\d+)\s*(?:ts|team\s*size)\s*(\d+)/i;
  const tsMatch = text.match(tsPattern);
  if (tsMatch) {
    return `${tsMatch[1]} TS${tsMatch[2]}`;
  }

  // Pattern 3: Just "Team Size 4"
  const teamSizePattern = /team\s*size\s*(\d+)/i;
  const teamSizeMatch = text.match(teamSizePattern);
  if (teamSizeMatch) {
    return `TS${teamSizeMatch[1]}`;
  }

  return 'Not detected';
}

// Determine which rank roles to ping
function getRankRolesToPing(rankRange) {
  if (!rankRange) return [];

  // If it's open rank, only ping the open rank role
  if (rankRange.isOpen) {
    return ['openrank'];
  }

  const roles = [];
  const { min, max } = rankRange;

  if (min <= 999 && max >= 100) roles.push('3digit');
  if (min <= 9999 && max >= 1000) roles.push('4digit');
  if (min <= 99999 && max >= 10000) roles.push('5digit');
  if (max >= 100000) roles.push('6digit');

  return roles;
}

// Scrape tournament forum posts
async function scrapeTournaments(limit = 20) {
  try {
    const response = await axios.get(CONFIG.FORUM_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    const tournaments = [];

    $('a.forum-topic-entry__title').each((i, elem) => {
      if (tournaments.length >= limit) return false; // Stop after limit
      
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

    console.log(`Found ${tournaments.length} tournaments (${tournaments.filter(t => t.isNew).length} new)`);
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
    
    // Get the first post content
    const postContent = $('.forum-post-content').first();
    
    // Look for the first image (usually the banner)
    const firstImage = postContent.find('img').first();
    if (firstImage.length) {
      const imgSrc = firstImage.attr('src');
      if (imgSrc) {
        return imgSrc.startsWith('http') ? imgSrc : `https://osu.ppy.sh${imgSrc}`;
      }
    }
    
    // Alternative: look for image in markdown format or direct links
    const imageMatch = postContent.html()?.match(/https?:\/\/[^\s<>"]+?\.(?:png|jpg|jpeg|gif|webp)/i);
    if (imageMatch) {
      return imageMatch[0];
    }
    
    return null;
  } catch (error) {
    console.error('Error fetching banner:', error.message);
    return null;
  }
}

// Create draft embed
function createDraftEmbed(data) {
  const rankText = data.rankRange 
    ? (data.rankRange.isOpen ? 'Open Rank' : `${data.rankRange.min.toLocaleString()} - ${data.rankRange.max.toLocaleString()}`)
    : 'Not detected';

  const rankRoles = getRankRolesToPing(data.rankRange);
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
  
  // Add banner as image if available
  if (data.banner) {
    embed.setImage(data.banner);
  }

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

// Format final announcement message
function formatAnnouncement(data, rankRoles) {
  const mentions = rankRoles
    .map(role => CONFIG.RANK_ROLES[role])
    .filter(roleId => roleId && roleId !== 'ROLE_ID_HERE')
    .map(roleId => `<@&${roleId}>`)
    .join(' ');

  // Format rank display
  const rankDisplay = data.rankRange.isOpen 
    ? 'Open Rank' 
    : `${data.rankRange.min.toLocaleString()}-${data.rankRange.max.toLocaleString()}`;
  
  let description = `### Forum Post\n${data.link}\n\n`;
  description += `**Format:** ${data.teamSize}\n**Rank:** ${rankDisplay}`;
  
  if (data.comments) {
    // Split comments by line and add -# prefix to each line for small text
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
    .setDescription(description);
  
  // Add banner image if available (no URL shown, just the image)
  if (data.banner) {
    embed.setImage(data.banner);
  }

  return { content: mentions, embed };
}

// Check for new tournaments
async function checkTournaments() {
  console.log('Checking for new tournaments...');
  
  const isFirstRun = processedTournaments.size === 0;
  const limit = isFirstRun ? 20 : 100; // Get 20 on first run, more on subsequent runs
  
  const tournaments = await scrapeTournaments(limit);
  
  // Filter to only new tournaments (unless first run)
  const tournamentsToShow = isFirstRun 
    ? tournaments 
    : tournaments.filter(t => t.isNew);
  
  if (tournamentsToShow.length === 0) {
    console.log('No new tournaments to show');
    return;
  }

  console.log(`Showing ${tournamentsToShow.length} tournaments`);
  const channel = await client.channels.fetch(CONFIG.DRAFT_CHANNEL_ID);

  for (const tournament of tournamentsToShow) {
    // Auto-parse from title
    const rankRange = parseRankRange(tournament.title);
    const teamSize = parseTeamSize(tournament.title);
    
    // Fetch banner image
    console.log(`Fetching banner for: ${tournament.title}`);
    const banner = await getTournamentBanner(tournament.link);

    const tournamentId = Buffer.from(tournament.link).toString('base64').substring(0, 80);
    
    // Store draft data
    const data = {
      name: tournament.title,
      link: tournament.link,
      rankRange: rankRange,
      teamSize: teamSize,
      comments: '', // Empty by default - can include host info here
      banner: banner || '' // Empty if not found
    };
    
    draftData.set(tournamentId, data);

    const embed = createDraftEmbed(data);
    const buttons = createActionButtons(tournamentId);

    await channel.send({
      embeds: [embed],
      components: buttons
    });

    processedTournaments.add(tournament.link);
    console.log(`Posted draft for: ${tournament.title}`);

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // Save processed tournaments after checking
  saveProcessedTournaments();
}

// Handle interactions
client.on('interactionCreate', async interaction => {
  try {
    // Handle modal submission
    if (interaction.isModalSubmit()) {
      const tournamentId = interaction.customId.replace('edit_modal_', '');
      const data = draftData.get(tournamentId);
      
      if (!data) {
        await interaction.reply({ content: '❌ Tournament data not found', ephemeral: true });
        return;
      }

      // Get updated values
      data.name = interaction.fields.getTextInputValue('name_input');
      
      // Parse combined rank range (e.g., "10000-99999" or "open rank")
      const rankRangeStr = interaction.fields.getTextInputValue('rank_range_input').trim();
      
      // Check if it's open rank
      if (/open\s*rank|open|unrestricted|all\s*ranks|no\s*rank/i.test(rankRangeStr)) {
        data.rankRange = { min: 1, max: 1000000, isOpen: true };
      } else {
        // Parse numeric range
        const rankParts = rankRangeStr.split('-').map(s => parseInt(s.trim().replace(/,/g, '')));
        if (rankParts.length === 2 && !isNaN(rankParts[0]) && !isNaN(rankParts[1])) {
          data.rankRange = { min: rankParts[0], max: rankParts[1], isOpen: false };
        }
      }
      
      data.teamSize = interaction.fields.getTextInputValue('team_size_input');
      data.banner = interaction.fields.getTextInputValue('banner_input') || '';
      data.comments = interaction.fields.getTextInputValue('comments_input') || '';

      draftData.set(tournamentId, data);

      // Update the embed
      const updatedEmbed = createDraftEmbed(data);
      const buttons = createActionButtons(tournamentId);

      await interaction.update({
        embeds: [updatedEmbed],
        components: buttons
      });

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

    if (action === 'edit') {
      // Show edit modal
      const modal = new ModalBuilder()
        .setCustomId(`edit_modal_${tournamentId}`)
        .setTitle('Edit Tournament Details');

      const nameInput = new TextInputBuilder()
        .setCustomId('name_input')
        .setLabel('Tournament Name')
        .setStyle(TextInputStyle.Short)
        .setValue(data.name)
        .setRequired(true);

      const rankRangeInput = new TextInputBuilder()
        .setCustomId('rank_range_input')
        .setLabel('Rank Range (e.g., 10000-99999 or "open")')
        .setStyle(TextInputStyle.Short)
        .setValue(data.rankRange ? (data.rankRange.isOpen ? 'Open Rank' : `${data.rankRange.min}-${data.rankRange.max}`) : '1-999999')
        .setRequired(true);

      const teamSizeInput = new TextInputBuilder()
        .setCustomId('team_size_input')
        .setLabel('Team Size (e.g., 3v3, 2v2 TS4, 1v1)')
        .setStyle(TextInputStyle.Short)
        .setValue(data.teamSize)
        .setRequired(true);

      const bannerInput = new TextInputBuilder()
        .setCustomId('banner_input')
        .setLabel('Banner Image URL (optional)')
        .setStyle(TextInputStyle.Short)
        .setValue(data.banner || '')
        .setRequired(false);

      const commentsInput = new TextInputBuilder()
        .setCustomId('comments_input')
        .setLabel('Additional Info (host, notes, etc.)')
        .setStyle(TextInputStyle.Paragraph)
        .setValue(data.comments || '')
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(nameInput),
        new ActionRowBuilder().addComponents(rankRangeInput),
        new ActionRowBuilder().addComponents(teamSizeInput),
        new ActionRowBuilder().addComponents(bannerInput),
        new ActionRowBuilder().addComponents(commentsInput)
      );

      // THIS WAS MISSING - SHOW THE MODAL!
      await interaction.showModal(modal);
      
    } else if (action === 'approve') {
      await interaction.deferUpdate();

      const rankRoles = getRankRolesToPing(data.rankRange);
      const announcement = formatAnnouncement(data, rankRoles);

      const announcementChannel = await client.channels.fetch(CONFIG.ANNOUNCEMENT_CHANNEL_ID);
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

// Manual check command
client.on('messageCreate', async message => {
  if (message.content === '!check' && message.author.id === process.env.USER_ID) {
    await checkTournaments();
    await message.reply('🔍 Checking for tournaments...');
  }
});

client.on('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log('Bot is ready to monitor tournaments!');
  
  // Load previously seen tournaments
  loadProcessedTournaments();
  
  // Start periodic checks
  checkTournaments();
  setInterval(checkTournaments, CONFIG.CHECK_INTERVAL);
});

client.login(CONFIG.TOKEN);