// src/index.ts
import {
  Client,
  Collection,
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
  ButtonBuilder,
  ButtonStyle,
  InteractionType,
  ComponentType
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



async function getLevelInfo(guild: any, postIdOrTag: string): Promise<{ name: string, creator: string }> {
  try {
    const forumChannelRaw = await guild.channels.fetch(process.env.FORUM_CHANNEL_ID || '');
    if (forumChannelRaw && forumChannelRaw.type === 15) { // 15 = GuildForum
      const forumChannel = forumChannelRaw as any;
      const thread = await forumChannel.threads.fetch(postIdOrTag).catch(() => null);
      if (thread && thread.isTextBased()) {
        const name = thread.name;
        const creator = thread.ownerId ? `<@${thread.ownerId}>` : '';
        return { name, creator };
      }
    }
    return { name: postIdOrTag, creator: '' };
  } catch {
    return { name: postIdOrTag, creator: '' };
  }
}

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

      const docText = JSON.stringify(data, null, 2); // <-- 추가

      const requests: docs_v1.Schema$Request[] = [];
      // endIndex > 2일 때만 삭제 요청 (빈 문서면 삭제하지 않음)
      if (endIndex > 2) {
        requests.push({
          deleteContentRange: {
            range: { startIndex: 1, endIndex: endIndex - 1 },
          },
        });
      }
      requests.push({
        insertText: {
          text: docText,
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
client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (message.guild.id !== process.env.GUILD_ID) return;

  // ================= !accept / !ac / !a =================
  const acceptPrefixes = ['!accept ', '!ac ', '!a '];
  const acceptPrefix = acceptPrefixes.find(prefix => message.content.startsWith(prefix));
  if (acceptPrefix) {
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

    const threadInput = message.content.slice(acceptPrefix.length).trim();

    function getThreadId(input: string): { id?: string; error?: string } {
      if (/^\d{10,}$/.test(input)) return { id: input };
      const mention = input.match(/^<#(\d+)>$/);
      if (mention) return { id: mention[1] };
      const m3 = input.match(/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
      if (m3) {
        const [, , second, third] = m3;
        const forumId = process.env.FORUM_CHANNEL_ID || '';
        if (forumId && second === forumId) return { id: third };
        return { id: second };
      }
      if (/discord\.com\/channels\/\d+\/\d+/.test(input)) {
        return { error: '❌ This is a channel link. Provide thread link or ID.' };
      }
      return { error: '❌ Invalid thread link or ID.' };
    }

    // 상위 스코프에서 threadId 선언
    let threadId: string | undefined;
    const { id, error } = getThreadId(threadInput);
    if (!id) {
      await message.reply(error || '❌ Unable to find thread ID.');
      return;
    }
    threadId = id;

    // Load pendings
    const pendings = await loadPending();
    if (pendings.find(p => p.postIdOrTag === threadId)) {
      await message.reply('This thread is already accepted.');
      return;
    }

    // Fetch thread
    let levelName = '';
    let creator = '';
    let thumbnailUrl = 'https://via.placeholder.com/150';

    try {
      const forumChannelRaw = await client.channels.fetch(process.env.FORUM_CHANNEL_ID || '');
      if (forumChannelRaw?.type === 15) {
        const forumChannel = forumChannelRaw as any;
        const thread = await forumChannel.threads.fetch(threadId).catch(() => null);
        if (thread && thread.isTextBased()) {
          levelName = thread.name;
          creator = thread.ownerId ? `<@${thread.ownerId}>` : '';

          const firstMsg = await thread.messages.fetch({ limit: 1 })
          .then((msgs: Collection<string, Message>) => msgs.first() ?? null)
          .catch(() => null);

          if (firstMsg) {
            const img = firstMsg.attachments.find((a: import('discord.js').Attachment) => a.contentType?.startsWith('image/'));
            if (img) thumbnailUrl = img.url;
            else if (firstMsg.embeds.length > 0) {
              const e = firstMsg.embeds[0];
              thumbnailUrl = e.thumbnail?.url ?? e.image?.url ?? thumbnailUrl;
            }
          }
        }
      }
    } catch (e) {
      console.log('Thread fetch failed:', e);
    }

    if (!levelName) levelName = threadId;

    pendings.push({
      postIdOrTag: threadId,
      levelName,
      authorId: creator,
      thumbnailUrl,
      ranks: [],
      votes: { song: [], design: [], vibe: [] },
      voters: []
    });

    await savePending(pendings);

    const announceChannelId = process.env.VOTE_ANNOUNCE_CHANNEL_ID || message.channel.id;
    const announceCh = await message.guild.channels.fetch(announceChannelId).catch(() => null);
    const threadUrl = `https://discord.com/channels/${message.guild.id}/${process.env.FORUM_CHANNEL_ID || message.guild.id}/${threadId}`;

    let creatorMention = creator;
    if (creator && !/^<@!?(\d+)>$/.test(creator)) {
      creatorMention = `<@${creator}>`;
    }

    let creatorUserMention = creatorMention;
    try {
      const forumChannelRaw = await client.channels.fetch(process.env.FORUM_CHANNEL_ID || '');
      if (forumChannelRaw?.type === 15) {
        const forumChannel = forumChannelRaw as any;
        const thread = await forumChannel.threads.fetch(threadId).catch(() => null);
        if (thread?.ownerId) {
          creatorUserMention = `<@${thread.ownerId}>`;
        }
      }
    } catch (e) {}

    const embed = new EmbedBuilder()
      .setTitle(`'${levelName}' | has been accepted!`)
      .setURL(threadUrl)
      .setDescription(`by ${creatorUserMention || 'Unknown'}`)
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
    await message.react(emojiId || '1404415892120539216').catch(() => {});
    return;
  }

  // ================= !revote =================
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

    lvl.votes = { song: [], design: [], vibe: [] };
    lvl.voters = [];
    await savePending(pendings);

    const votingChannelId = process.env.VOTING_CHANNEL_ID;
    if (votingChannelId) {
      const gch = await message.guild.channels.fetch(votingChannelId).catch(() => null);
      if (gch?.isTextBased()) {
        await (gch as TextChannel).send(`🔄 Voting for **${lvl.levelName}** (${lvl.postIdOrTag}) has been reset by <@${message.author.id}>. Please vote again using /vote!`);
      }
    }

    await message.reply(`Votes for ${lvl.levelName} have been reset and voters cleared.`);
    return;
  }

  // ================= !say =================
  if (message.content.startsWith('!say')) {
    const member = message.member;
    if (!member) return;
    const baseRoleName = process.env.MANAGER || '';
    const baseRole = message.guild.roles.cache.find(r => r.name === baseRoleName);
    if (!baseRole) return;
    if (member.roles.highest.position < baseRole.position) {
      await message.reply('❌ You do not have permission to use this command.');
      return;
    }

    const raw = message.content.slice('!say'.length).trim();
    const args = parseArgs(raw);
    if (args.length < 2) {
      await message.reply('❌ Usage: !say [#channel or channelID] "content" "title(optional)" "description(optional)" "imageURL(optional)" "color(optional)"');
      return;
    }

    const channelArg = args[0];
    const mention = channelArg.match(/^<#(\d+)>$/);
    const channelId = mention ? mention[1] : channelArg;
    const ch = message.guild.channels.cache.get(channelId) as TextChannel;
    if (!ch?.isTextBased()) {
      await message.reply('❌ Provide a valid text channel mention or ID.');
      return;
    }

    const content = args[1];
    const title = args[2] || '';
    const description = args[3] || '';
    const imageUrl = args[4] || '';
    const colorInput = args[5] || '#5865F2';
    const embedColor = /^#([0-9A-F]{6}|[0-9A-F]{3})$/i.test(colorInput)
      ? parseInt(colorInput.replace('#', ''), 16)
      : 0x5865F2;

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setDescription(`**${content}**`)
      .setTimestamp();
    if (title) embed.setTitle(`📢 ${title}`);
    if (description) embed.setFooter({ text: description, iconURL: client.user?.displayAvatarURL() });
    if (imageUrl) embed.setThumbnail(imageUrl);

    try {
      await ch.send({ embeds: [embed] });
      await message.react(process.env.REACTION_EMOJI_ID || '1404415892120539216').catch(() => {});
    } catch (e) {
      console.error('!say send failed', e);
      await message.reply('❌ Failed to send message.');
    }
  }
});


// ---------------- message-based commands: !accept, !revote, !say ----------------
client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (message.guild.id !== process.env.GUILD_ID) return;

  // ----- !accept [threadID] (매니저 전용) -----
  const acceptPrefixes = ['!accept ', '!ac ', '!a '];
  const acceptPrefix = acceptPrefixes.find(prefix => message.content.startsWith(prefix));
  if (acceptPrefix) {
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

    const threadInput = message.content.slice(acceptPrefix.length).trim();
    // 링크에서 threadId 추출
    function getThreadId(input: string): { id?: string; error?: string } {
  // 숫자만
  if (/^\d{10,}$/.test(input)) return { id: input };

  // 스레드 멘션
  const mention = input.match(/^<#(\d+)>$/);
  if (mention) return { id: mention[1] };

  // 포럼 스레드 URL (guild/channel/thread)
  const m3 = input.match(/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (m3) {
    const [, , second, third] = m3;
    const forumId = process.env.FORUM_CHANNEL_ID || '';
    // /guildId/forumId/threadId
    if (forumId && second === forumId) return { id: third };
    // /guildId/threadId/messageId
    return { id: second };
  }

  // 채널 링크 (guild/channel) → 에러
  if (/discord\.com\/channels\/\d+\/\d+/.test(input)) {
    return { error: '❌ 이건 채널 링크입니다. 스레드 링크나 스레드 ID를 입력하세요.' };
  }

  return { error: '❌ 유효한 스레드 링크나 ID가 아닙니다.' };
}

const { id: threadId, error } = getThreadId(threadInput);

    if (!threadId) {
      await message.reply('Usage: !accept [thread link or threadID]');
      return;
    }

    // load existing pendings
    const pendings = await loadPending();
    if (pendings.find(p => p.postIdOrTag === threadId)) {
      await message.reply('This thread is already accepted.');
      return;
    }

    // 포스트 내용에서 name, creator 추출
    let thumbnailUrl = 'https://via.placeholder.com/150';
    let levelName = '';
    let creator = '';
    try {
      const forumChannelRaw = await client.channels.fetch(process.env.FORUM_CHANNEL_ID || '');
      // ForumChannel 타입 체크
      if (forumChannelRaw && forumChannelRaw.type === 15) { // 15 = GuildForum
      const forumChannel = forumChannelRaw as any; // Discord.js v14: ForumChannel
      // 스레드(포스트) fetch
      const thread = await forumChannel.threads.fetch(threadId).catch(() => null);
      if (thread && thread.isTextBased()) {
        levelName = thread.name;
        creator = thread.ownerId ? `<@${thread.ownerId}>` : '';
        // 썸네일 추출
        const firstMsg = await thread.messages.fetch({ limit: 1 })
        .then((msgs: Collection<string, Message>) => msgs.first() ?? null)
        .catch(() => null);
        if (firstMsg) {
        const img = firstMsg.attachments.find((a: import('discord.js').Attachment) => a.contentType?.startsWith('image/'));
        if (img) thumbnailUrl = img.url;
        else if (firstMsg.embeds.length > 0) {
          const e = firstMsg.embeds[0];
          thumbnailUrl = e.thumbnail?.url ?? e.image?.url ?? thumbnailUrl;
        }
        }
      } else {
        console.log('❌ thread fetch failed for threadId:', threadId);
      }
      } else {
      console.log('❌ FORUM_CHANNEL_ID is not a forum channel!');
      }
    } catch (e) {
      console.log('fetch thread failed:', e);
    }

    // levelName이 없으면 threadId로 fallback
    if (!levelName) levelName = threadId;

    // push pending (with voters 초기화)
    pendings.push({
      postIdOrTag: threadId,
      levelName: levelName,
      authorId: creator,
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

    // creator가 <@...> 형식이 아니면 멘션으로 변환
    let creatorMention = creator;
    if (creator && !/^<@!?(\d+)>$/.test(creator)) {
      // creator가 userId라면 멘션으로
      creatorMention = `<@${creator}>`;
    }

    
    // 포스트 게시자 멘션 추출
    let creatorUserMention = creatorMention;
    try {
      const forumChannelRaw = await client.channels.fetch(process.env.FORUM_CHANNEL_ID || '');
      if (forumChannelRaw && forumChannelRaw.type === 15) { // 15 = GuildForum
      const forumChannel = forumChannelRaw as any;
      const thread = await forumChannel.threads.fetch(threadId).catch(() => null);
      if (thread && thread.ownerId) {
        creatorUserMention = `<@${thread.ownerId}>`;
      }
      }
    } catch (e) {
      // fallback to creatorMention
    }

    const embed = new EmbedBuilder()
      .setTitle(`'${levelName}' | has been accepted!`)
      .setURL(threadUrl)
      .setDescription(`by ${creatorUserMention || 'Unknown'}`)
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
  const colorInput = args[5] || '#5865F2'; // 기본 색상

  // 색상 유효성 검사
  const isValidHexColor = /^#([0-9A-F]{6}|[0-9A-F]{3})$/i.test(colorInput);
  const embedColor = isValidHexColor
    ? parseInt(colorInput.replace('#', ''), 16)
    : 0x5865F2;

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setDescription(`**${content}**`)
    .setTimestamp();

  if (title && title != "" && title != " ") embed.setTitle(`📢 ${title}`);
  if (description && description != "" && description != " ")
    embed.setFooter({
      text: description,
      iconURL: client.user?.displayAvatarURL() ?? undefined
    });
  if (imageUrl && imageUrl != "" && imageUrl != " ") embed.setThumbnail(imageUrl);

  try {
    await target.send({ embeds: [embed] });
    const emojiId = process.env.REACTION_EMOJI_ID;
    if (emojiId) {
      await message.react(emojiId).catch(() => {});
    } else {
      await message.react('1404415892120539216').catch(() => {});
    }
  } catch (e) {
    console.error('!say send failed', e);
    await message.reply('❌ Failed to send message.');
  }
});

client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const PREFIX = '!fuckrozy';
  if (!message.content.startsWith(PREFIX)) return;

  const member = message.member;
  if (!member) return;

  // name of role
  const roleName = process.env.FUCKROZY_ROLE || '';
  const role = message.guild.roles.cache.find(r => r.name === roleName);

  if (!role) {
    await message.reply(`can't find "${roleName}"`);
    return;
  }

  if (!member.roles.cache.has(role.id)) {
    await message.reply('❌ You do not have permission to fuck rrozy!');
    return;
  }

  // Parse number argument
  const args = message.content.trim().split(/\s+/);
  let count: string | number = 1;
  if (args.length > 1) {
    // 숫자면 숫자로, 아니면 문자열로
    const n = parseInt(args[1], 10);
    count = isNaN(n) ? args[1] : n;
  }

  const rrozyMention = roleMention(process.env.RROZY || '1404793396404682793');
  if (message.channel.isTextBased()) {
    await (message.channel as TextChannel).send(`${rrozyMention} fucked by ${member.toString()} ${count} times!`);
  }
});

// ---- Save ranked levels to Google Docs (manager only) ----
client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (message.guild.id !== process.env.GUILD_ID) return;

  if (!message.content.startsWith('!saveranked')) return;

  // 매니저 권한 확인
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

  // 새 Google Docs ID
  const rankedDocId = process.env.GOOGLE_RANKED_DOC_ID;
  if (!rankedDocId) {
    await message.reply('GOOGLE_RANKED_DOC_ID need env var.');
    return;
  }
  if (!authClient) {
    await message.reply('Google 인증이 필요합니다.');
    return;
  }
  const rankedDocs = google.docs({ version: 'v1', auth: authClient });

  // 데이터 불러오기 및 정렬
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
    await message.reply('No levels yet.');
    return;
  }

  // 각 pending의 메시지에서 name, id, creator 추출
  async function extractInfoFromPost(postIdOrTag: string): Promise<{ name: string, id: string, creator: string }> {
  try {
    const forumChannelRaw = await message.guild?.channels.fetch(process.env.FORUM_CHANNEL_ID || '');
    if (forumChannelRaw && forumChannelRaw.type === 15) {
      const forumChannel = forumChannelRaw as any;
      const thread = await forumChannel.threads.fetch(postIdOrTag).catch(() => null);
      if (thread && thread.isTextBased()) {
        return {
          name: thread.name,
          id: thread.id,
          creator: thread.ownerId ? `<@${thread.ownerId}>` : ''
        };
      }
    }
    return { name: '', id: '', creator: '' };
  } catch {
    return { name: '', id: '', creator: '' };
  }
}

  // 모든 레벨 정보 추출
  const levelInfos = await Promise.all(
    scored.map(lvl => extractInfoFromPost(lvl.postIdOrTag))
  );

  // 포맷팅
  const lines: string[] = scored.map((p, i) => {
    const info = levelInfos[i];
    return `${i + 1}. ${info.name || p.levelName} by ${info.creator || `<@${p.authorId}>`} | ${info.id || p.postIdOrTag}\n   Song: ${p.s.toFixed(2)}, Design: ${p.d.toFixed(2)}, Vibe: ${p.v.toFixed(2)}, Overall: ${p.overall.toFixed(2)}`;
  });
  const docText = lines.join('\n\n');

  // 기존 내용 삭제 후 새로 입력
  try {
    const doc = await rankedDocs.documents.get({ documentId: rankedDocId });
    const content = doc.data.body?.content;
    const endIndex = content ? content[content.length - 1].endIndex || 1 : 1;

    const requests: docs_v1.Schema$Request[] = [];
    if (endIndex > 2) {
      requests.push({
        deleteContentRange: {
          range: { startIndex: 1, endIndex: endIndex - 1 },
        },
      });
    }
    requests.push({
      insertText: {
        text: docText,
        location: { index: 1 },
      },
    });

    await rankedDocs.documents.batchUpdate({
      documentId: rankedDocId,
      requestBody: { requests },
    });

    await message.reply('✅ Ranking has been saved!.');
  } catch (e) {
    console.error('Ranking save failed!:', e);
    await message.reply('❌ Google Docs save failed.');
  }
});

// ================ !remove command ================
client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (message.guild.id !== process.env.GUILD_ID) return;

  const removePrefixes = ['!remove', '!rmv', '!r'];
  const removePrefix = removePrefixes.find(prefix => message.content.startsWith(prefix));
  if (!removePrefix) return;

  // 권한 체크
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

  // pending 목록 불러오기
  const pendings = await loadPending();
  if (pendings.length === 0) {
    await message.reply('No levels to remove.');
    return;
  }

  // 레벨 정보 동시 추출
  const levelInfos = await Promise.all(
    pendings.slice(0, 25).map(p => getLevelInfo(message.guild, p.postIdOrTag))
  );

  // 선택 메뉴 생성 (제목: 레벨명, 설명: 개발자)
  const options = pendings.slice(0, 25).map((p, i) => ({
    label: levelInfos[i].name.length > 100 ? levelInfos[i].name.slice(0, 97) + '...' : levelInfos[i].name,
    // description이 빈 문자열이면 undefined로!
    description: levelInfos[i].creator && levelInfos[i].creator.length > 0 ? levelInfos[i].creator : undefined,
    value: p.postIdOrTag
  }));

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('remove_level_select')
    .setPlaceholder('Select a level to remove')
    .addOptions(options);

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

  await message.reply({ content: 'Select a level to remove:', components: [row] });
});

// select menu → 모달
client.on('interactionCreate', async interaction => {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId !== 'remove_level_select') return;

  const postIdOrTag = interaction.values[0];

  // 이유 입력 모달
  const modal = new ModalBuilder()
    .setCustomId(`remove_reason_modal_${postIdOrTag}`)
    .setTitle('Remove Level - Reason');

  const reasonInput = new TextInputBuilder()
    .setCustomId('removeReason')
    .setLabel('Reason for removal')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Enter the reason for removing this level')
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput)
  );

  await interaction.showModal(modal);
});

// 모달 제출 → 삭제 및 announce embed
client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit()) return;
  if (!interaction.customId.startsWith('remove_reason_modal_')) return;

  const postIdOrTag = interaction.customId.replace('remove_reason_modal_', '');
  const reason = interaction.fields.getTextInputValue('removeReason');

  // 권한 체크
  const guild = interaction.guild;
  if (!guild) return;
  const managerRoleName = process.env.MANAGER || '';
  const managerRole = guild.roles.cache.find(r => r.name === managerRoleName);
  const member = await guild.members.fetch(interaction.user.id);
  if (!managerRole || !member.roles.cache.has(managerRole.id)) {
    await interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
    return;
  }

  // pending에서 삭제
  const pendings = await loadPending();
  const idx = pendings.findIndex(p => p.postIdOrTag === postIdOrTag);
  if (idx === -1) {
    await interaction.reply({ content: 'Level not found in pending list.', ephemeral: true });
    return;
  }
  const removed = pendings.splice(idx, 1)[0];
  await savePending(pendings);

  // announce 채널로 embed 전송
  const announceChannelId = process.env.VOTE_ANNOUNCE_CHANNEL_ID || interaction.channelId;
  let announceCh: TextChannel | null = null;
  if (announceChannelId) {
    const ch = await guild.channels.fetch(announceChannelId).catch(() => null);
    if (ch && ch.isTextBased()) announceCh = ch as TextChannel;
  }

  const embed = new EmbedBuilder()
    .setTitle(`'${removed.levelName}' has been removed`)
    .setDescription('Its. sad')
    .setFooter({ text: `reason : ${reason}` })
    .setColor('#FF0000')
    .setTimestamp();

  // 썸네일(이미지) 추가 (env에 REMOVE_THUMBNAIL_URL 있으면)
  if (process.env.REMOVE_THUMBNAIL_URL) {
    embed.setThumbnail(process.env.REMOVE_THUMBNAIL_URL);
  }

  // .send는 TextChannel에서만 사용
  if (announceCh && announceCh.isTextBased()) {
    await (announceCh as TextChannel).send({ embeds: [embed] });
  } else if (interaction.channel && interaction.channel.isTextBased()) {
    await (interaction.channel as TextChannel).send({ embeds: [embed] });
  }

  await interaction.reply({ content: `✅ Level **${removed.levelName}** has been removed.`, ephemeral: true });
});


// ---------------- start HTTP server for uptime ping ----------------
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot running');
}).listen(port, () => console.log('Server running on port', port));

// ---------------- login ----------------
client.login(process.env.TOKEN);
