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

dotenv.config();

// Create REST client for Discord API
const rest = new REST({ version: '10' }).setToken(process.env.TOKEN!);

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

  await guild.commands.set(data);
  console.log(`✅ Slash command registered in guild: ${guild.name}`);
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

    // 응답 대기 상태(비공개)
    await interaction.deferReply({ ephemeral: true });

    const member = interaction.member as GuildMember;

    // 기존 역할 찾기
    let currentStage = -1;
    for (let i = VERIFY_STAGES.length - 1; i >= 0; i--) {
      if (member.roles.cache.some(r => r.name.toLowerCase() === VERIFY_STAGES[i].toLowerCase())) {
        currentStage = i;
        break;
      }
    }

    const nextStage = Math.min(currentStage + 1, VERIFY_STAGES.length - 1);
    const roleName = VERIFY_STAGES[nextStage];

    // 역할 찾거나 생성
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

    // 비공개 응답 보내기
    if (roleName == "verified ") {
      await interaction.editReply({ content: `✅ You are now verified!`});
    }else {
      await interaction.editReply({ content: `You are now verified!...... more?`});
    }
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

  // PREFIX 제거 후 args 파싱
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

client.login(process.env.TOKEN);
