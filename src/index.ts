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
  REST,
  Routes,
  Interaction,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  Message
} from 'discord.js';
import * as dotenv from 'dotenv';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { docs_v1 } from 'googleapis';


dotenv.config();

/**
 * Required env variables (set these in Render dashboard):
 * TOKEN, CLIENT_ID, GUILD_ID, MANAGER, VOTE_PERM_ROLE, VOTING_CHANNEL_ID, FORUM_CHANNEL_ID
 * GOOGLE_SERVICE_ACCOUNT (JSON string of service account creds)
 * optional: GOOGLE_DRIVE_FILE_ID, REACTION_EMOJI_ID
 */

// ---------------- Google Drive setup ----------------
const DRIVE_FILE_NAME = 'pending.json';
const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT;
if (!GOOGLE_SERVICE_ACCOUNT) {
  console.error('Missing GOOGLE_SERVICE_ACCOUNT env var. Storing pending locally will be used as fallback.');
}

let driveFileId = process.env.GOOGLE_DRIVE_FILE_ID || null;
let drive: any = null;
let authClient: any = null;

let docs: docs_v1.Docs | null = null;
const googleDocId = process.env.GOOGLE_DOC_ID || null;

if (authClient && googleDocId) {
  docs = google.docs({ version: 'v1', auth: authClient });
}

if (GOOGLE_SERVICE_ACCOUNT) {
  try {
    const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT);
    authClient = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/drive.file',
    ],
  } as any);
    drive = google.drive({ version: 'v3', auth: authClient });
  } catch (e) {
    console.error('Failed to init Google service account:', e);
    drive = null;
  }
}

// local fallback path (if Google Drive not available)
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
};

// ---------------- helper: load/save pending ----------------
async function ensureDriveFile(): Promise<void> {
  if (!drive) return;
  if (driveFileId) return;

  // try find file
  const res = await drive.files.list({
    q: `name='${DRIVE_FILE_NAME}' and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive'
  });
  if (res.data.files && res.data.files.length > 0) {
    driveFileId = res.data.files[0].id!;
    return;
  }

  // create file
  const createRes = await drive.files.create({
    requestBody: {
      name: DRIVE_FILE_NAME,
      mimeType: 'application/json'
    },
    media: {
      mimeType: 'application/json',
      body: JSON.stringify([], null, 2)
    },
    fields: 'id'
  });
  driveFileId = createRes.data.id!;
  console.log('Created drive file id:', driveFileId);
}

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

  // 로컬 fallback
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
      // 문서 전체 길이 가져오기
      const doc = await docs.documents.get({ documentId: googleDocId });
      const content = doc.data.body?.content;
      const endIndex = content ? content[content.length - 1].endIndex || 1 : 1;

      const requests: docs_v1.Schema$Request[] = [];

      // 문서 내용 전체 삭제 (본문 1부터 끝까지)
      if (endIndex > 1) {
        requests.push({
          deleteContentRange: {
            range: {
              startIndex: 1,
              endIndex: endIndex - 1,
            }
          }
        });
      }

      // 새 JSON 텍스트 삽입
      requests.push({
        insertText: {
          text: JSON.stringify(data, null, 2),
          location: { index: 1 }
        }
      });

      await docs.documents.batchUpdate({
        documentId: googleDocId,
        requestBody: { requests }
      });

      return;
    } catch (e) {
      console.error('Failed to save pending to Google Docs:', e);
    }
  }

  // 로컬 fallback
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

// Register slash commands (guild-scoped)
const verifyCmd = new SlashCommandBuilder()
  .setName('verifyme')
  .setDescription('Get verified (fun tiered roles)')
  .toJSON();

const acceptCmd = new SlashCommandBuilder()
  .setName('accept')
  .setDescription('Accept a forum post by Thread ID')
  .addStringOption(opt => opt.setName('postid').setDescription('Thread ID').setRequired(true))
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
  console.log('✅Logged in as', client.user?.tag);
  const guildId = process.env.GUILD_ID!;
  const guild = await client.guilds.fetch(guildId);

  const cmds = [verifyCmd, acceptCmd, voteCmd, listCmd];
  await guild.commands.set(cmds);
  console.log('✅Registered commands in guild', guild.name);
});

// single interaction handler for commands / select / modal
client.on('interactionCreate', async (interaction: Interaction) => {
  // Slash commands
  if (interaction.isChatInputCommand()) {
    const ctx = interaction as ChatInputCommandInteraction;
    // restrict to guild
    if (ctx.guildId !== process.env.GUILD_ID) {
      await ctx.reply({ content: 'This command only works in the allowed server.', ephemeral: true });
      return;
    }

    // ---------- verifyme ----------
    if (ctx.commandName === 'verifyme') {
      await ctx.deferReply({ ephemeral: true });
      const member = ctx.member as GuildMember;
      let currentStage = -1;
      for (let i = VERIFY_STAGES.length - 1; i >= 0; i--) {
        if (member.roles.cache.some(r => r.name.toLowerCase() === VERIFY_STAGES[i].toLowerCase())) {
          currentStage = i;
          break;
        }
      }
      const nextStage = Math.min(currentStage + 1, VERIFY_STAGES.length - 1);
      const roleName = VERIFY_STAGES[nextStage];

      let role = ctx.guild!.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
      if (!role) {
        role = await ctx.guild!.roles.create({ name: roleName, reason: 'Verification role' });
      }
      if (!member.roles.cache.has(role.id)) await member.roles.add(role);

      if (roleName === 'verified') {
        await ctx.editReply({ content: '✅ You are now verified!' });
      } else if (roleName === 'double verified' || roleName === 'triple verified') {
        await ctx.editReply({ content: 'You are now verified!...... more?' });
      } else {
        await ctx.editReply({ content: 'YOU GOT ULTIMATELY VERIFIED!' });
      }
      return;
    }

    // ---------- accept ----------
    if (ctx.commandName === 'accept') {
      // permission: MANAGER role
      const managerRoleName = process.env.MANAGER || '';
      const member = ctx.member as GuildMember;
      if (!member.roles.cache.some(r => r.name === managerRoleName)) {
        await ctx.reply({ content: 'You do not have permission to use /accept', ephemeral: true });
        return;
      }
      await ctx.deferReply({ ephemeral: true });

      const postId = ctx.options.getString('postid', true).trim();
      // load pending
      const pendings = await loadPending();
      if (pendings.find(p => p.postIdOrTag === postId)) {
        await ctx.editReply('This thread is already accepted.');
        return;
      }

      // attempt to fetch thread and get thumbnail & thread info
      let thumbnailUrl = 'https://via.placeholder.com/150';
      let levelName = postId;
      try {
        const fetched = await client.channels.fetch(postId);
        if (fetched && fetched.isThread()) {
          const thread = fetched;
          // threadName
          levelName = thread.name ?? postId;
          // starter message
          const starter = await (thread as any).fetchStarterMessage().catch(() => null);
          if (starter) {
            // attachments
            const img = starter.attachments.find((a: any) => a.contentType?.startsWith('image/'));
            if (img) thumbnailUrl = img.url;
            // embeds
            else if (starter.embeds.length > 0) {
              const e = starter.embeds[0];
              thumbnailUrl = e.thumbnail?.url ?? e.image?.url ?? thumbnailUrl;
            }
          }
        }
      } catch (e) {
        console.log('fetch thread failed or not thread:', e);
      }

      // save pending
      pendings.push({
        postIdOrTag: postId,
        levelName,
        authorId: ctx.user.id,
        thumbnailUrl,
        ranks: [],
        votes: { song: [], design: [], vibe: [] }
      });

      // pendings 저장 (Google Drive로 저장, 실패 시 로컬에 저장하는 savePending 사용)
      await savePending(pendings);
      console.log('Pending levels saved:', pendings.length);

      // build thread URL using FORUM_CHANNEL_ID env (recommended)
      const forumChannelId = process.env.FORUM_CHANNEL_ID || '';
      const threadUrl = `https://discord.com/channels/${ctx.guildId}/${forumChannelId || (ctx.guildId ?? '')}/${postId}`;

      const embed = new EmbedBuilder()
        .setTitle(`${levelName} has been accepted!`)
        .setURL(threadUrl)
        .setDescription(`by <@${ctx.user.id}>`)
        .setThumbnail(thumbnailUrl)
        .setFooter({ text: 'Use /vote for This COOL Level!' })
        .setColor('#00FF00')
        .setTimestamp();

      // send to the channel where command was used (if supports send)
      const ch = ctx.channel as TextChannel | null;
      if (ch?.isTextBased && ch.isTextBased()) {
        await ch.send({ embeds: [embed] });
      } else {
        await ctx.followUp({ content: 'Cannot send announcement in this channel.', ephemeral: true });
      }

      await ctx.editReply('Accepted and announced.');
      return;
    }

    // ---------- vote ----------
    if (ctx.commandName === 'vote') {
      // permission: role + channel restriction
      const roleName = process.env.VOTE_PERM_ROLE || 'vote perm';
      const voteRole = ctx.guild!.roles.cache.find(r => r.name === roleName);
      const member = ctx.member as GuildMember;
      if (!voteRole || !member.roles.cache.has(voteRole.id)) {
        await ctx.reply({ content: 'You do not have permission to vote.', ephemeral: true });
        return;
      }
      const votingChannelId = process.env.VOTING_CHANNEL_ID;
      if (votingChannelId && ctx.channelId !== votingChannelId) {
        await ctx.reply({ content: `You can only vote in <#${votingChannelId}>`, ephemeral: true });
        return;
      }

      const pendings = await loadPending();
      if (pendings.length === 0) {
        await ctx.reply({ content: 'No pending levels to vote.', ephemeral: true });
        return;
      }

      // build select menu
      const options = pendings.slice(0, 25).map(p => ({
        label: p.levelName.length > 100 ? p.levelName.slice(0, 97) + '...' : p.levelName,
        description: p.postIdOrTag,
        value: p.postIdOrTag
      }));

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('vote_select_level')
          .setPlaceholder('Choose a level to vote')
          .addOptions(options)
      );

      await ctx.reply({ content: 'Select a level to vote for:', components: [row], ephemeral: true });
      return;
    }

    // ---------- list ----------
    if (ctx.commandName === 'list') {
      await ctx.deferReply({ ephemeral: true });
      const pendings = await loadPending();
      const scored = pendings
        .filter(p => p.votes && p.votes.song.length > 0)
        .map(p => {
          const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
          const s = avg(p.votes.song);
          const d = avg(p.votes.design);
          const v = avg(p.votes.vibe);
          const overall = (s + d + v) / 3;
          return { ...p, overall, s, d, v };
        })
        .sort((a, b) => b.overall - a.overall);

      if (scored.length === 0) {
        await ctx.editReply('No levels have votes yet.');
        return;
      }

      const lines = scored.map((p, i) =>
        `${i + 1}. ${p.levelName} (${p.postIdOrTag}) — Avg: ${p.overall.toFixed(2)} (Song:${p.s.toFixed(2)}, Design:${p.d.toFixed(2)}, Vibe:${p.v.toFixed(2)})`
      );
      await ctx.editReply({ content: `**Voted levels:**\n${lines.join('\n')}` });
      return;
    }
  }

  // --------------- component interactions: select menu ---------------
  if (interaction.isStringSelectMenu()) {
    const sel = interaction as StringSelectMenuInteraction;
    if (sel.customId === 'vote_select_level') {
      const selectedId = sel.values[0];
      // show modal to collect 3 scores
      const modal = new ModalBuilder()
        .setCustomId(`vote_modal_${selectedId}`)
        .setTitle('Vote (1-10)');

      const songInput = new TextInputBuilder()
        .setCustomId('songScore')
        .setLabel('Song (1-10)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 7')
        .setRequired(true);

      const designInput = new TextInputBuilder()
        .setCustomId('designScore')
        .setLabel('Level Design (1-10)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 8')
        .setRequired(true);

      const vibeInput = new TextInputBuilder()
        .setCustomId('vibeScore')
        .setLabel("Level's Vibe (1-10)")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 6')
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(songInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(designInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(vibeInput)
      );

      await sel.showModal(modal);
      return;
    }
  }

  // --------------- modal submit ---------------
  if (interaction.isModalSubmit()) {
    const modal = interaction as ModalSubmitInteraction;
    if (!modal.customId.startsWith('vote_modal_')) return;
    await modal.deferReply({ ephemeral: true });

    const postId = modal.customId.replace('vote_modal_', '');
    const song = parseInt(modal.fields.getTextInputValue('songScore'), 10);
    const design = parseInt(modal.fields.getTextInputValue('designScore'), 10);
    const vibe = parseInt(modal.fields.getTextInputValue('vibeScore'), 10);

    if ([song, design, vibe].some(n => isNaN(n) || n < 1 || n > 10)) {
      await modal.editReply({ content: 'Scores must be numbers between 1 and 10.' });
      return;
    }

    const pendings = await loadPending();
    const lvl = pendings.find(p => p.postIdOrTag === postId);
    if (!lvl) {
      await modal.editReply({ content: 'Selected level not found.' });
      return;
    }

    lvl.votes.song.push(song);
    lvl.votes.design.push(design);
    lvl.votes.vibe.push(vibe);
    await savePending(pendings);

    await modal.editReply({ content: `Thanks — your vote for **${lvl.levelName}** has been recorded.` });
    return;
  }
});

// ---------------- message-based !say command ----------------
client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (message.guild.id !== process.env.GUILD_ID) return;

  const PREFIX = '!say';
  if (!message.content.startsWith(PREFIX)) return;

  const member = message.member;
  if (!member) return;

  const baseRoleName = process.env.MANAGER || '';
  const baseRole = message.guild.roles.cache.find(r => r.name === baseRoleName);
  if (!baseRole) {
    await message.reply(`Base role "${baseRoleName}" not found.`);
    return;
  }
  if (member.roles.highest.position < baseRole.position) {
    await message.reply('❌ You do not have permission to use this command.');
    return;
  }

  const raw = message.content.slice(PREFIX.length).trim();
  const args = parseArgs(raw);
  if (args.length < 2) {
    await message.reply('❌ Usage: !say [#channel or channelID] "content" "title(optional)" "description(optional)"');
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

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setDescription(`**${content}**`)
    .setTimestamp();

  if (title) embed.setTitle(`📢 ${title}`);
  if (description) embed.setFooter({ text: description, iconURL: client.user?.displayAvatarURL() ?? undefined });

  try {
    await target.send({ embeds: [embed] });
    const emojiId = process.env.REACTION_EMOJI_ID;
    if (emojiId) {
      await message.react(emojiId).catch(() => { /* ignore */ });
    } else {
      await message.react('1404415892120539216').catch(() => { /* ignore non-custom */ });
    }
  } catch (e) {
    console.error('!say send failed', e);
    await message.reply('❌ Failed to send message.');
  }
});

// ---------------- start HTTP server for uptime ping ----------------
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot running');
}).listen(port, () => console.log('Server running on port', port));

// ---------------- login ----------------
client.login(process.env.TOKEN);
