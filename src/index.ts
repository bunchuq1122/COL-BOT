import {
  Client,
  GatewayIntentBits,
  Partials,
  TextChannel,
  GuildMember,
  SlashCommandBuilder,
  EmbedBuilder,
  REST,
  Routes
} from 'discord.js';
import * as dotenv from 'dotenv';
import http from 'http';
import fs from 'fs';
import path from 'path';  

dotenv.config();

// Create REST client for Discord API
const rest = new REST({ version: '10' }).setToken(process.env.TOKEN!);

// pending levels
const PENDING_PATH = path.resolve('./pending.json');

type PendingLevel = {
  postIdOrTag: string;
  levelName: string;
  authorId: string;
  thumbnailUrl?: string;
  ranks: number[];
  votes?: {
    song: number[];
    design: number[];
    vibe: number[];
  }
};

function loadPending(): PendingLevel[] {
  if (!fs.existsSync(PENDING_PATH)) return [];
  const raw = fs.readFileSync(PENDING_PATH, 'utf-8');
  return JSON.parse(raw);
}

function savePending(data: PendingLevel[]) {
  fs.writeFileSync(PENDING_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// ====== Functions ======
function parseArgs(content: string): string[] {
  const regex = /"([^"]+)"|(\S+)/g;
  const args: string[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (match[1]) {
      args.push(match[1]); // 큰따옴표 안 문자열
    } else if (match[2]) {
      args.push(match[2]); // 공백 없는 단어
    }
  }
  return args;
}

// ====== Global Command Deletion ======
(async () => {
  try {
    console.log('Fetching commands...');
    const commands = await rest.get(
      Routes.applicationCommands(process.env.CLIENT_ID!)
    ) as any[];

    console.log(`Found ${commands.length} commands:`);
    for (const cmd of commands) {
      console.log(`Deleting: ${cmd.name}`);
      await rest.delete(
        Routes.applicationCommand(process.env.CLIENT_ID!, cmd.id)
      );
    }

    console.log('✅ All global commands deleted.');
  } catch (error) {
    console.error(error);
  }
})();

// ====== Simple HTTP server for uptime checks ======
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is running');
}).listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// ====== Discord Client ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel]
});

// Verification stages for /verifyme
const VERIFY_STAGES = [
  'verified',
  'double verified',
  'triple verified',
  'ultimately verified'
];

// ====== Accept Command ======
const acceptCommand = new SlashCommandBuilder()
  .setName('accept')
  .setDescription('Accept a level by Thread ID')
  .addStringOption(option => 
    option.setName('postid')
      .setDescription('Thread ID of the level submission to accept')
      .setRequired(true)
  )
  .toJSON();
// ====== List Command ======
const listCommand = new SlashCommandBuilder()
  .setName('list')
  .setDescription('Show list of levels with votes sorted by average score')
  .toJSON();

// ======  vote command ======
const voteCommand = new SlashCommandBuilder()
  .setName('vote')
  .setDescription('Vote for a pending level')
  .toJSON();

// ====== Bot Ready ======
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);

  // Guild-specific command registration
  const guildId = process.env.GUILD_ID!;
  const guild = await client.guilds.fetch(guildId);


  const data = [
    new SlashCommandBuilder()
      .setName('verifyme')
      .setDescription('Get verified (...What if you sennd this multiple times...?)')
      .toJSON()
  ];

  const commands = [
  new SlashCommandBuilder()
    .setName('verifyme')
    .setDescription('Get verified (...What if you sennd this multiple times...?)')
    .toJSON(),
  voteCommand,
  listCommand,
  acceptCommand
];

  await guild.commands.set(commands);
console.log(`✅ All slash commands registered in guild: ${guild.name}`);
});

// ====== Handle Slash Commands ======
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.guildId !== process.env.GUILD_ID) {
    await interaction.reply({ content: '❌ This command can only be used in the allowed server.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'verifyme') {
    if (!interaction.guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }

    // Wait for the interaction to be deferred
    await interaction.deferReply({ ephemeral: true });

    const member = interaction.member as GuildMember;

    // find the current verification stage based on roles
    let currentStage = -1;
    for (let i = VERIFY_STAGES.length - 1; i >= 0; i--) {
      if (member.roles.cache.some(r => r.name.toLowerCase() === VERIFY_STAGES[i].toLowerCase())) {
        currentStage = i;
        break;
      }
    }

    const nextStage = Math.min(currentStage + 1, VERIFY_STAGES.length - 1);
    const roleName = VERIFY_STAGES[nextStage];

    // find or create the role
    let role = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (!role) {
      role = await interaction.guild.roles.create({
        name: roleName,
        reason: 'Verification stage role'
      });
    }

    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role);
    }

    // send a confirmation message
    if (roleName == "verified") {
      await interaction.editReply({ content: `✅ You are now verified!`});
    }else if (roleName == "double verified" || roleName == "triple verified") {
      await interaction.editReply({ content: `You are now verified!...... more?`});
    }else {
      await interaction.editReply({ content: `YOU GOT ULTIMATELY VERIFIED!`});
    }
  }
});

// ====== Accept Command ======
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'accept') return;

  // 서버 제한
  if (interaction.guildId !== process.env.GUILD_ID) {
    await interaction.reply({ content: '❌ This command can only be used in the allowed server.', ephemeral: true });
    return;
  }

  const member = interaction.member as GuildMember;
  const managerRoleName = process.env.MANAGER || '';
  if (!member.roles.cache.some(r => r.name === managerRoleName)) {
    await interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const postIdOrTag = interaction.options.getString('postid', true);

  const pendings = loadPending();
  if (pendings.find(p => p.postIdOrTag === postIdOrTag)) {
    await interaction.editReply('This post/tag is already accepted.');
    return;
  }

  // 기본 썸네일
  let thumbnailUrl = 'https://via.placeholder.com/150';

  // 썸네일 자동 추출 시도
  try {
    const channel = await client.channels.fetch(postIdOrTag);
    if (channel?.isThread()) {
      const starterMessage = await channel.fetchStarterMessage();
      if (starterMessage) {
        if (starterMessage.attachments.size > 0) {
          const imgAttachment = starterMessage.attachments.find(att => att.contentType?.startsWith('image/'));
          if (imgAttachment) thumbnailUrl = imgAttachment.url;
        }
        if ((!thumbnailUrl || thumbnailUrl === 'https://via.placeholder.com/150') && starterMessage.embeds.length > 0) {
          const embed = starterMessage.embeds[0];
          thumbnailUrl = embed.thumbnail?.url ?? embed.image?.url ?? thumbnailUrl;
        }
      }
    }
  } catch {
    // 무시하고 기본 썸네일 유지
  }

  // 저장
  pendings.push({
    postIdOrTag,
    levelName: postIdOrTag,
    authorId: interaction.user.id,
    ranks: [],
    votes: { song: [], design: [], vibe: [] },
    thumbnailUrl
  });
  savePending(pendings);

  const channel = interaction.channel as TextChannel | null;
  const forumChannelId = process.env.FORUM_CHANNEL_ID || '';

  // 가상 포스트 링크 생성
  let threadUrl = `https://discord.com/channels/${interaction.guildId}/${forumChannelId}/${postIdOrTag}`;

  // 알림 메시지 (명령어 사용 채널)
  const embed = new EmbedBuilder()
  .setTitle(`${threadUrl} has been accepted!`)
  .setDescription(`by <@${interaction.user.id}>`)
  .setThumbnail(thumbnailUrl)
  .setFooter({ text: 'Use /vote for This COOL Level!' })
  .setColor('#00FF00')
  .setTimestamp();

  
if (channel) {
  await channel.send({ embeds: [embed] });
} else {
  await interaction.followUp({ content: 'Cannot send message in this channel.', ephemeral: true });
}

  await interaction.editReply('Accepted and announced.');
});

// ====== Vote Command Handler ======
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'vote') {
    // Check if the interaction is in the correct guild
    if (interaction.guildId !== process.env.GUILD_ID) {
      await interaction.reply({ content: '❌ This command can only be used in the allowed server.', ephemeral: true });
      return;
    }

    const member = interaction.member as GuildMember;
    if (!member.roles.cache.some(r => r.name === process.env.VOTE_PERM_ROLE)) {
      await interaction.reply({ content: '❌ You do not have permission to vote.', ephemeral: true });
      return;
    }

    if (interaction.channelId !== process.env.VOTING_CHANNEL_ID) {
      await interaction.reply({ content: `❌ You can only vote in <#${process.env.VOTING_CHANNEL_ID}>.`, ephemeral: true });
      return;
    }

    // Pending list load
    const pendings = loadPending();
    if (pendings.length === 0) {
      await interaction.reply({ content: 'No pending levels available for voting.', ephemeral: true });
      return;
    }

    // 레벨 선택용 select 메뉴 생성
    const selectOptions = pendings.map(p => ({
      label: p.levelName,
      description: p.postIdOrTag,
      value: p.postIdOrTag
    }));

    // 최대 25개 제한에 유의
    await interaction.reply({
      content: 'Select a level to vote for:',
      components: [{
        type: 1, // ActionRow
        components: [{
          type: 3, // StringSelectMenu
          custom_id: 'vote_select_level',
          placeholder: 'Choose a level',
          options: selectOptions.slice(0, 25)
        }]
      }],
      ephemeral: true
    });
  }
});


// ====== !say Command ======
client.on('messageCreate', async (message) => {
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
    message.reply(`Base role "${baseRoleName}" not found.`);
    return;
  }
  if (member.roles.highest.position < baseRole.position) {
    message.reply('❌ You do not have permission to use this command.');
    return;
  }

  // remove the prefix from the message content
  const rawArgs = message.content.slice(PREFIX.length).trim();
  const args = parseArgs(rawArgs);

  if (args.length < 2) {
    message.reply('❌ Usage: !say [channelMention/channelID] [content] [title(optional)] [description(optional)]');
    return;
  }

  const channelArg = args[0];
  let targetChannel: TextChannel | null = null;

  const mentionMatch = channelArg.match(/^<#(\d+)>$/);
  const channelId = mentionMatch ? mentionMatch[1] : channelArg;
  const ch = message.guild.channels.cache.get(channelId);
  if (ch && ch.isTextBased()) {
    targetChannel = ch as TextChannel;
  }

  if (!targetChannel) {
    message.reply('❌ Please provide a valid text channel mention or ID.');
    return;
  }

  const content = args[1];
  const title = args[2] || '';
  const description = args[3] || '';

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setDescription(`**${content}**`);

  if (title) {
    embed.setTitle(`📢 ${title}`);
  }
  if (description) {
    embed.setFooter({
      text: description,
      iconURL: message.client.user?.displayAvatarURL() || undefined
    });
  }
  embed.setTimestamp();

  try {
    await targetChannel.send({ embeds: [embed] });
    await message.react('1404415892120539216');
  } catch (err) {
    console.error(err);
    message.reply('❌ Failed to send the message.');
  }
});

// ====== LIST Command Handler ======
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.guildId !== process.env.GUILD_ID) {
    await interaction.reply({ content: '❌ This command can only be used in the allowed server.', ephemeral: true });
    return;
  }

  const member = interaction.member as GuildMember;

  if (interaction.commandName === 'list') {
    // 모든 점수가 없는 레벨 필터링
    const pendings = loadPending().filter(p =>
      p.votes && p.votes.song.length > 0 && p.votes.design.length > 0 && p.votes.vibe.length > 0
    );

    if (pendings.length === 0) {
      await interaction.reply({ content: 'No levels have votes yet.', ephemeral: true });
      return;
    }

    // 평균 점수 계산 헬퍼 함수
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

    // 평균 점수 내림차순 정렬 (song, design, vibe 평균의 평균)
    pendings.sort((a, b) => {
      const aAvg = (avg(a.votes!.song) + avg(a.votes!.design) + avg(a.votes!.vibe)) / 3;
      const bAvg = (avg(b.votes!.song) + avg(b.votes!.design) + avg(b.votes!.vibe)) / 3;
      return bAvg - aAvg;
    });

    // 메시지 생성
    const listString = pendings.map(p => {
      const songAvg = avg(p.votes!.song).toFixed(2);
      const designAvg = avg(p.votes!.design).toFixed(2);
      const vibeAvg = avg(p.votes!.vibe).toFixed(2);
      const overallAvg = ((parseFloat(songAvg) + parseFloat(designAvg) + parseFloat(vibeAvg)) / 3).toFixed(2);
      return `**${p.levelName}** (Tag: ${p.postIdOrTag}) - Avg Score: ${overallAvg} (Song: ${songAvg}, Design: ${designAvg}, Vibe: ${vibeAvg})`;
    }).join('\n');

    await interaction.reply({ content: `**Levels with votes:**\n${listString}`, ephemeral: true });
  }

  // vote 명령어 기존 처리 ...
});

client.login(process.env.TOKEN);
