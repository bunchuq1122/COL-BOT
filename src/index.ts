// src/index.ts
import {
  Client,
  GatewayIntentBits,
  Partials,
  TextChannel,
  GuildMember,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Interaction,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  Message,
  roleMention,
  Collection
} from 'discord.js';
import * as dotenv from 'dotenv';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { docs_v1 } from 'googleapis';
console.log('TOKEN =', process.env.TOKEN); // 디버깅용
dotenv.config();

/**
 * Required env variables:
 * TOKEN, CLIENT_ID, GUILD_ID, MANAGER, VOTE_PERM_ROLE, VOTING_CHANNEL_ID, FORUM_CHANNEL_ID
 * GOOGLE_SERVICE_ACCOUNT (JSON string of service account creds)
 * GOOGLE_DOC_ID (Google Docs ID to save/load pending data)
 * optional: REACTION_EMOJI_ID
 */

// ---------------- Google Docs setup ----------------
const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT;
let authClient: any = null;
let docs: docs_v1.Docs | null = null;
const googleDocId = process.env.GOOGLE_DOC_ID || null;

if (GOOGLE_SERVICE_ACCOUNT) {
  try {
    const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT);
    authClient = new google.auth.JWT({
      email: creds.client_email,
      // Render 등에 넣을 때 private_key에 "\\n"으로 들어오는 경우를 위해 변환
      key: (creds.private_key as string).replace(/\\n/g, '\n'),
      scopes: [
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/drive.file',
      ],
    } as any);
    if (authClient && googleDocId) {
      docs = google.docs({ version: 'v1', auth: authClient });
    }
  } catch (e) {
    console.error('Failed to init Google service account:', e);
  }
}

// local fallback path (if Google Docs not available)
const LOCAL_PENDING_PATH = path.resolve('./pending.json');

// ---------------- types ----------------
type PendingLevel = {
  postIdOrTag: string;
  levelName: string;
  authorId: string;
  thumbnailUrl?: string;
  ranks: number[];
  votes: {
    song: number[];
    design: number[];
    vibe: number[];
  };
  // 새로운 필드: 이미 투표한 사용자 아이디 목록 (한 사람 한 레벨 1회 제한)
  voters: string[];
};

// ---------------- helper: load/save pending ----------------
async function loadPending(): Promise<PendingLevel[]> {
  if (docs && googleDocId) {
    try {
      const res = await docs.documents.get({ documentId: googleDocId });
      const content = res.data.body?.content;
      if (!content) return [];

      let fullText = '';
      for (const element of content) {
        if (element.paragraph) {
          for (const elem of element.paragraph.elements || []) {
            if (elem.textRun?.content) fullText += elem.textRun.content;
          }
        }
      }

      return JSON.parse(fullText.trim() || '[]') as PendingLevel[];
    } catch (e) {
      console.error('Failed to load pending from Google Docs:', e);
    }
  }

  // local fallback
  if (fs.existsSync(LOCAL_PENDING_PATH)) {
    try {
      const raw = fs.readFileSync(LOCAL_PENDING_PATH, 'utf8');
      return JSON.parse(raw) as PendingLevel[];
    } catch (e) {
      console.error('Failed to read local pending.json:', e);
    }
  }
  return [];
}

async function savePending(data: PendingLevel[]) {
  if (docs && googleDocId) {
    try {
      const doc = await docs.documents.get({ documentId: googleDocId });
      const content = doc.data.body?.content;
      const endIndex = content ? content[content.length - 1].endIndex || 1 : 1;

      const requests: docs_v1.Schema$Request[] = [];

      if (endIndex > 1) {
        requests.push({
          deleteContentRange: {
            range: { startIndex: 1, endIndex: endIndex - 1 },
          },
        });
      }

      requests.push({
        insertText: {
          text: JSON.stringify(data, null, 2),
          location: { index: 1 },
        },
      });

      await docs.documents.batchUpdate({
        documentId: googleDocId,
        requestBody: { requests },
      });
      return;
    } catch (e) {
      console.error('Failed to save pending to Google Docs:', e);
    }
  }

  // local fallback
  try {
    fs.writeFileSync(LOCAL_PENDING_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write local pending.json:', e);
  }
}

// ---------------- arg parser for !say ----------------
function parseArgs(content: string): string[] {
  const regex = /"([^"]+)"|(\S+)/g;
  const args: string[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (match[1]) args.push(match[1]);
    else if (match[2]) args.push(match[2]);
  }
  return args;
}

// ---------------- discord client ----------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel]
});


client.commands = new Collection();

// commands 폴더 로드
const commands: any[] = [];
const commandsPath = path.join(__dirname, "commands");
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith(".ts") || file.endsWith(".js"));


for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if ("data" in command && "execute" in command) {
    client.commands.set(command.data.name, command);
    commands.push(command.data.toJSON()); // 등록용
  }
}

// badapple 명령어 직접 등록 (만약 자동 로드가 안될 경우)
try {
  const badapple = require(path.join(commandsPath, "badapple.ts"));
  if ("data" in badapple && "execute" in badapple) {
    client.commands.set(badapple.data.name, badapple);
    commands.push(badapple.data.toJSON());
  }
} catch (e) {
  console.warn('badapple.ts not found or failed to load:', e);
}

// Register slash commands (guild-scoped)
const verifyCmd = new SlashCommandBuilder()
  .setName('verifyme')
  .setDescription('Get verified (fun tiered roles)')
  .toJSON();

const voteCmd = new SlashCommandBuilder()
  .setName('vote')
  .setDescription('Start voting (pick a pending level)')
  .toJSON();

const listCmd = new SlashCommandBuilder()
  .setName('list')
  .setDescription('Show list of voted levels (by avg)')
  .toJSON();

// verification stages
const VERIFY_STAGES = ['verified', 'double verified', 'triple verified', 'ultimately verified'];

// once ready: register commands
client.once('ready', async () => {
  console.log('✅ Logged in as', client.user?.tag);
  const guildId = process.env.GUILD_ID!;
  const guild = await client.guilds.fetch(guildId);

  const cmds = [verifyCmd, voteCmd, listCmd];
  await guild.commands.set(cmds);
  console.log('✅ Registered commands in guild', guild.name);
});

// single interaction handler for commands / select / modal
client.on('interactionCreate', async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const ctx = interaction;
  const { commandName, guild, member } = ctx;

  if (!guild || !member || !(member instanceof GuildMember)) {
    await ctx.reply({ content: 'Guild or member not found', ephemeral: true });
    return;
  }

  const guildMember = member as GuildMember;

  // ------------------ /verifyme ------------------
  if (commandName === 'verifyme') {
    
    await ctx.deferReply({ ephemeral: true });

    let currentStage = -1;
    for (let i = VERIFY_STAGES.length - 1; i >= 0; i--) {
      if (guildMember.roles.cache.some(r => r.name.toLowerCase() === VERIFY_STAGES[i].toLowerCase())) {
        currentStage = i;
        break;
      }
    }

    const nextStage = Math.min(currentStage + 1, VERIFY_STAGES.length - 1);
    const roleName = VERIFY_STAGES[nextStage];

    let role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (!role) {
      role = await guild.roles.create({ name: roleName, reason: 'Verification role' });
    }

    if (!guildMember.roles.cache.has(role.id)) {
      await guildMember.roles.add(role);
    }

    if (roleName === 'verified') {
      await ctx.editReply({ content: '✅ You are now verified!' });
    } else if (roleName === 'double verified' || roleName === 'triple verified') {
      await ctx.editReply({ content: 'You are now verified!...... more?' });
    } else {
      await ctx.editReply({ content: 'YOU GOT ULTIMATELY VERIFIED!' });
    }
    console.log('Verify command received from', guildMember.user.tag);
    return;
  }

  // ------------------ /vote ------------------
  if (commandName === 'vote') {
    await ctx.deferReply({ ephemeral: true });

    const roleId = process.env.VOTE_PERM_ROLE!;
    const voteRole = guild.roles.cache.get(roleId);

    if (!voteRole || !guildMember.roles.cache.has(voteRole.id)) {
      await ctx.editReply({ content: 'You do not have permission to vote.' });
      return;
    }

    const votingChannelId = process.env.VOTING_CHANNEL_ID!;
    if (ctx.channelId !== votingChannelId) {
      await ctx.editReply({ content: `You can only vote in <#${votingChannelId}>.` });
      return;
    }

    const pendings = await loadPending();
    if (pendings.length === 0) {
      await ctx.editReply({ content: 'No pending levels to vote.' });
      return;
    }

    const options = pendings.slice(0, 25).map(p => ({
      label: p.levelName.length > 100 ? p.levelName.slice(0, 97) + '...' : p.levelName,
      description: p.postIdOrTag,
      value: p.postIdOrTag,
    }));

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('vote_select_level')
        .setPlaceholder('Choose a level to vote')
        .addOptions(options)
    );

    await ctx.editReply({ content: 'Select a level to vote for:', components: [row] });
    return;
  }

  // ------------------ /list ------------------
  if (commandName === 'list') {
    const pendings = await loadPending();
    if (pendings.length === 0) {
      await ctx.reply({ content: 'No voted levels yet.', ephemeral: true });
      return;
    }

    const sorted = pendings
      .filter(p => p.votes && p.votes.design)
      .sort((a, b) => {
        const avgA =
          a.votes.design.reduce((sum, x) => sum + x, 0) / (a.votes.design.length || 1);
        const avgB =
          b.votes.design.reduce((sum, x) => sum + x, 0) / (b.votes.design.length || 1);
        return avgB - avgA;
      });

    const listText = sorted
      .map(
        (p, i) =>
          `#${i + 1} - ${p.levelName} | Avg Design Score: ${
            (p.votes.design.reduce((sum, x) => sum + x, 0) / (p.votes.design.length || 1)).toFixed(2)
          }`
      )
      .join('\n');

    await ctx.reply({ content: '🏆 Voted Levels:\n' + listText, ephemeral: true });
    return;
  }
});


// ---------------- message-based commands: !accept, !revote, !say ----------------
client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (message.guild.id !== process.env.GUILD_ID) return;

  const member = message.member;

  // ----- !accept [threadID] (매니저 전용) -----
  if (message.content.startsWith('!accept ')) {
    
    const managerRoleName = process.env.MANAGER || '';
    const managerRole = message.guild.roles.cache.find(r => r.name === managerRoleName);
    if (!managerRole) {
      await message.reply('Manager role not configured or not found.');
      return;
    }
    if (!member?.roles.cache.has(managerRole.id)) {
      await message.reply('❌ You do not have permission to use this command.');
      return;
    }

    const threadId = message.content.slice('!accept '.length).trim();
    if (!threadId) {
      await message.reply('Usage: !accept [threadID]');
      return;
    }

    const pendings = await loadPending();
    if (pendings.find(p => p.postIdOrTag === threadId)) {
      await message.reply('This thread is already accepted.');
      return;
    }

    // fetch thread for thumbnail & title
    let thumbnailUrl = 'https://via.placeholder.com/150';
    let levelName = threadId;
    try {
      const fetched = await client.channels.fetch(threadId);
      if (fetched && fetched.isThread()) {
        const thread = fetched;
        levelName = thread.name ?? threadId;
        const starter = await (thread as any).fetchStarterMessage().catch(() => null);
        if (starter) {
          const img = starter.attachments.find((a: any) => a.contentType?.startsWith('image/'));
          if (img) thumbnailUrl = img.url;
          else if (starter.embeds.length > 0) {
            const e = starter.embeds[0];
            thumbnailUrl = e.thumbnail?.url ?? e.image?.url ?? thumbnailUrl;
          }
        }
      }
    } catch (e) {
      console.log('fetch thread failed or not thread:', e);
    }

    pendings.push({
      postIdOrTag: threadId,
      levelName,
      authorId: message.author.id,
      thumbnailUrl,
      ranks: [],
      votes: { song: [], design: [], vibe: [] },
      voters: []
    });

    await savePending(pendings);
    console.log('Pending levels saved:', pendings.length);

    // announcement
    const announceChannelId = process.env.VOTE_ANNOUNCE_CHANNEL_ID || message.channel.id;
    const announceCh = await message.guild.channels.fetch(announceChannelId).catch(() => null);
    const threadUrl = `https://discord.com/channels/${message.guild.id}/${process.env.FORUM_CHANNEL_ID || message.guild.id}/${threadId}`;

    const embed = new EmbedBuilder()
      .setTitle(`'${levelName}' has been accepted!`)
      .setURL(threadUrl)
      .setDescription(`by <@${message.author.id}>`)
      .setThumbnail(thumbnailUrl)
      .setFooter({ text: 'Use /vote for This COOL Level!' + roleMention(process.env.VOTING_NOTIFICATION || 'voting notification') })
      .setColor('#00FF00')
      .setTimestamp();

    if (announceCh && announceCh.isTextBased()) {
      await (announceCh as TextChannel).send({ embeds: [embed] });
    } else {
      await (message.channel as TextChannel).send({ embeds: [embed] });
    }

    const emojiId = process.env.REACTION_EMOJI_ID;
    if (emojiId) {
      await message.react(emojiId).catch(() => {});
    } else {
      await message.react('1404415892120539216').catch(() => {});
    }
    console.log('!accept command received:', message.content);
    return;
  }

  // ----- !revote [postId] (매니저 전용) -----
  if (message.content.startsWith('!revote ')) {
    const managerRoleName = process.env.MANAGER || '';
    const managerRole = message.guild.roles.cache.find(r => r.name === managerRoleName);
    if (!managerRole) {
      await message.reply('Manager role not configured or not found.');
      return;
    }
    if (!member?.roles.cache.has(managerRole.id)) {
      await message.reply('❌ You do not have permission to use this command.');
      return;
    }

    const postId = message.content.slice('!revote '.length).trim();
    if (!postId) {
      await message.reply('Usage: !revote [postId]');
      return;
    }

    const pendings = await loadPending();
    const lvl = pendings.find(p => p.postIdOrTag === postId);
    if (!lvl) {
      await message.reply('Level not found in pending list.');
      return;
    }

    lvl.votes = { song: [], design: [], vibe: [] };
    lvl.voters = [];
    await savePending(pendings);

    const votingChannelId = process.env.VOTING_CHANNEL_ID;
    if (votingChannelId) {
      const gch = await message.guild.channels.fetch(votingChannelId).catch(() => null);
      if (gch && (gch as TextChannel).isTextBased && (gch as TextChannel).isTextBased()) {
        await (gch as TextChannel).send(`🔄 Voting for **${lvl.levelName}** (${lvl.postIdOrTag}) has been reset by <@${message.author.id}>. Please vote again using /vote!`);
      }
    }

    await message.reply(`Votes for ${lvl.levelName} have been reset and voters cleared.`);
    return;
  }

  // ----- !say [#channel or ID] "content" ... -----
  if (message.content.startsWith('!say')) {
    const baseRoleName = process.env.MANAGER || '';
    const baseRole = message.guild.roles.cache.find(r => r.name === baseRoleName);
    if (!baseRole) {
      await message.reply(`Base role "${baseRoleName}" not found.`);
      return;
    }

    if (!member || member.roles.highest.position < baseRole.position) {
      await message.reply('❌ You do not have permission to use this command.');
      return;
    }

    const raw = message.content.slice('!say'.length).trim();
    const args = parseArgs(raw);
    if (args.length < 2) {
      await message.reply(
        '❌ Usage: !say [#channel or channelID] "content" "title(optional)" "description(optional)" "imageURL(optional)" "color(optional)"'
      );
      return;
    }

    const channelArg = args[0];
    const mention = channelArg.match(/^<#(\d+)>$/);
    const channelId = mention ? mention[1] : channelArg;
    const ch = message.guild.channels.cache.get(channelId);

    if (!ch || !ch.isTextBased()) {
      await message.reply('❌ Provide a valid text channel mention or ID.');
      return;
    }
    const target = ch as TextChannel;

    const content = args[1];
    const title = args[2] || '';
    const description = args[3] || '';
    const imageUrl = args[4] || '';
    const colorInput = args[5] || '#5865F2';

    const isValidHexColor = /^#([0-9A-F]{6}|[0-9A-F]{3})$/i.test(colorInput);
    const embedColor = isValidHexColor ? parseInt(colorInput.replace('#', ''), 16) : 0x5865F2;

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setDescription(`**${content}**`)
      .setTimestamp();

    if (title.trim() !== '') embed.setTitle(`📢 ${title}`);
    if (description.trim() !== '') embed.setFooter({ text: description, iconURL: client.user?.displayAvatarURL() ?? undefined });
    if (imageUrl.trim() !== '') embed.setThumbnail(imageUrl);

    try {
      await target.send({ embeds: [embed] });
      const emojiId = process.env.REACTION_EMOJI_ID;
      if (emojiId) await message.react(emojiId).catch(() => {});
      else await message.react('1404415892120539216').catch(() => {});
    } catch (e) {
      console.error('!say send failed', e);
      await message.reply('❌ Failed to send message.');
    }
    console.log('!say command received:', message.content);
    return;
  }

  // ----- !fuckrozy -----
  if (message.content.startsWith('!fuckrozy')) {
    const roleName = process.env.FUCKROZY_ROLE || '';
    const role = message.guild.roles.cache.find(r => r.name === roleName);

    if (!role) {
      await message.reply(`can't find "${roleName}"`);
      return;
    }

    if (!member?.roles.cache.has(role.id)) {
      await message.reply('❌ You do not have permission to fuck rrozy!');
      return;
    }

    const args = message.content.trim().split(/\s+/);
    let count: string | number = 1;
    if (args.length > 1) {
      const n = parseInt(args[1], 10);
      count = isNaN(n) ? args[1] : n;
    }

    const rrozyMention = roleMention(process.env.RROZY || '1404793396404682793');
    if (message.channel.isTextBased()) {
      await (message.channel as TextChannel).send(`${rrozyMention} fucked by ${member.toString()} ${count} times!`);
    }
    return;
  }
});



// ---------------- start HTTP server for uptime ping ----------------
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot running');
}).listen(port, () => console.log('Server running on port', port));

// ---------------- login ----------------
client.login(process.env.TOKEN)
  .then(() => console.log('Login attempt sent'))
  .catch(console.error);
