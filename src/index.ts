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
  if (interaction.isChatInputCommand()) {
    const ctx = interaction as ChatInputCommandInteraction;

    if (ctx.guildId !== process.env.GUILD_ID) {
      await ctx.reply({ content: 'This command only works in the allowed server.', ephemeral: true });
      return;
    }

    // --- verifyme ---
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

    // --- vote ---
    if (ctx.commandName === 'vote') {
      const roleName = process.env.VOTE_PERM_ROLE || 'vote perm';
      const voteRole = ctx.guild!.roles.cache.find(r => r.name === roleName);
      const member = ctx.member as GuildMember;

      if (!voteRole || !member.roles.cache.has(voteRole.id)) {
        if (ctx.replied || ctx.deferred) {
          await ctx.followUp({ content: 'You do not have permission to vote.', ephemeral: true });
        } else {
          await ctx.reply({ content: 'You do not have permission to vote.', ephemeral: true });
        }
        return;
      }

      const votingChannelId = process.env.VOTING_CHANNEL_ID;
      if (votingChannelId && ctx.channelId !== votingChannelId) {
        if (ctx.replied || ctx.deferred) {
          await ctx.followUp({ content: `You can only vote in <#${votingChannelId}>`, ephemeral: true });
        } else {
          await ctx.reply({ content: `You can only vote in <#${votingChannelId}>`, ephemeral: true });
        }
        return;
      }

      const pendings = await loadPending();
      if (pendings.length === 0) {
        if (ctx.replied || ctx.deferred) {
          await ctx.followUp({ content: 'No pending levels to vote.', ephemeral: true });
        } else {
          await ctx.reply({ content: 'No pending levels to vote.', ephemeral: true });
        }
        return;
      }

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

      if (ctx.replied || ctx.deferred) {
        await ctx.followUp({ content: 'Select a level to vote for:', components: [row], ephemeral: true });
      } else {
        await ctx.reply({ content: 'Select a level to vote for:', components: [row], ephemeral: true });
      }
      return;
    }

    // --- list ---
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

  // component: select menu (vote select)
  if (interaction.isStringSelectMenu()) {
    const sel = interaction as StringSelectMenuInteraction;
    if (sel.customId === 'vote_select_level') {
      const selectedId = sel.values[0];
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

      // showModal 자동으로 interaction을 acknowledge 하지 않으므로 안전하게 호출
      await sel.showModal(modal);
      return;
    }
  }

  // modal submit (vote)
  if (interaction.isModalSubmit()) {
    const modal = interaction as ModalSubmitInteraction;
    if (!modal.customId.startsWith('vote_modal_')) return;

    // don't defer reply too early — we'll reply at the end
    const postId = modal.customId.replace('vote_modal_', '');
    const song = parseInt(modal.fields.getTextInputValue('songScore'), 10);
    const design = parseInt(modal.fields.getTextInputValue('designScore'), 10);
    const vibe = parseInt(modal.fields.getTextInputValue('vibeScore'), 10);
    const userId = modal.user.id;

    if ([song, design, vibe].some(n => isNaN(n) || n < 1 || n > 10)) {
      await modal.reply({ content: 'Scores must be numbers between 1 and 10.', ephemeral: true });
      return;
    }

    const pendings = await loadPending();
    const lvl = pendings.find(p => p.postIdOrTag === postId);
    if (!lvl) {
      await modal.reply({ content: 'Selected level not found.', ephemeral: true });
      return;
    }

    // 중복 투표 확인
    if (lvl.voters && lvl.voters.includes(userId)) {
      await modal.reply({ content: 'You have already voted for this level.', ephemeral: true });
      return;
    }

    // 투표 저장
    lvl.votes.song.push(song);
    lvl.votes.design.push(design);
    lvl.votes.vibe.push(vibe);
    lvl.voters.push(userId);
    await savePending(pendings);

    await modal.reply({ content: `Thanks — your vote for **${lvl.levelName}** has been recorded.`, ephemeral: true });
    return;
  }
});

// ---------------- message-based commands: !accept, !revote, !say ----------------
client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (message.guild.id !== process.env.GUILD_ID) return;

  // ----- !accept [threadID] (매니저 전용) -----
  if (message.content.startsWith('!accept ')) {
    const managerRoleName = process.env.MANAGER || '';
    const managerRole = message.guild.roles.cache.find(r => r.name === managerRoleName);
    if (!managerRole) {
      await message.reply('Manager role not configured or not found.');
      return;
    }
    if (!message.member?.roles.cache.has(managerRole.id)) {
      await message.reply('❌ You do not have permission to use this command.');
      return;
    }

    const threadId = message.content.slice('!accept '.length).trim();
    if (!threadId) {
      await message.reply('Usage: !accept [threadID]');
      return;
    }

    // load existing pendings
    const pendings = await loadPending();
    if (pendings.find(p => p.postIdOrTag === threadId)) {
      await message.reply('This thread is already accepted.');
      return;
    }

    // try fetch thread for thumbnail & title
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

    // push pending (with voters 초기화)
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

    // announcement: 특정 채널로 보내기 (환경변수 VOTE_ANNOUNCE_CHANNEL_ID 사용)
    const announceChannelId = process.env.VOTE_ANNOUNCE_CHANNEL_ID || message.channel.id;
    const announceCh = await message.guild.channels.fetch(announceChannelId).catch(() => null);
    const threadUrl = `https://discord.com/channels/${message.guild.id}/${process.env.FORUM_CHANNEL_ID || message.guild.id}/${threadId}`;

    const embed = new EmbedBuilder()
      .setTitle(`${levelName} has been accepted!`)
      .setURL(threadUrl)
      .setDescription(`by <@${message.author.id}>`)
      .setThumbnail(thumbnailUrl)
      .setFooter({ text: 'Use /vote for This COOL Level!' })
      .setColor('#00FF00')
      .setTimestamp();

    if (announceCh && announceCh.isTextBased()) {
      await (announceCh as TextChannel).send({ embeds: [embed] });
    } else {
      await (message.channel as TextChannel).send({ embeds: [embed] });
    }

    await message.reply('Accepted and announced.');
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
    if (!message.member?.roles.cache.has(managerRole.id)) {
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

    // 초기화: votes와 voters 비우기
    lvl.votes = { song: [], design: [], vibe: [] };
    lvl.voters = [];
    await savePending(pendings);

    // 공지: 투표 채널에 다시 투표하라고 알림
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
});

// ---------------- message-based !say command ----------------
client.on('messageCreate', async (message: Message) => {
  // !say 처리 - 이미 이전에 구현되어 있었다면 중복으로 두지 마세요.
  // 이 블록은 이미 messageCreate 이벤트에서 처리되므로, 필요하면 기존 !say 핸들러와 합치세요.
  // (여기선 이미 위에서 messageCreate 핸들러가 등록되어 있으니 중복 주의)
});

// ---------------- start HTTP server for uptime ping ----------------
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot running');
}).listen(port, () => console.log('Server running on port', port));

// ---------------- login ----------------
client.login(process.env.TOKEN);
