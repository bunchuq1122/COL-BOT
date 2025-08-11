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
      .setDescription('Get verified (and fun titles if you run it multiple times!)')
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

    const member = interaction.member as GuildMember;

    // Check current verification stage
    let currentStage = -1;
    for (let i = VERIFY_STAGES.length - 1; i >= 0; i--) {
      if (member.roles.cache.some(r => r.name.toLowerCase() === VERIFY_STAGES[i].toLowerCase())) {
        currentStage = i;
        break;
      }
    }

    // Next stage
    const nextStage = Math.min(currentStage + 1, VERIFY_STAGES.length - 1);
    const roleName = VERIFY_STAGES[nextStage];

    // Find or create role
    let role = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (!role) {
      role = await interaction.guild.roles.create({
        name: roleName,
        reason: 'Verification stage role'
      });
    }

    // Add role if not already owned
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role);
    }
  }
});

// ====== !say Command ======
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  // Only allowed guild
  if (message.guild.id !== process.env.GUILD_ID) return;

  const PREFIX = '!say';
  if (!message.content.startsWith(PREFIX)) return;

  const member = message.member;
  if (!member) return;

  // Base role check
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

  const args = message.content.trim().split(/\s+/);
  if (args.length < 3) {
    message.reply('❌ Usage: !say [channelMention/channelID] [content] [title(optional)] [description(optional)]');
    return;
  }

  const channelArg = args[1];
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

  const content = args[2];
const title = args[3] || '';
const description = args[4] || '';

const embed = new EmbedBuilder()
  .setColor('#5865F2') // Discord blue
  .setDescription(`**${content}**`); // 본문 강조

if (title) {
  embed.setTitle(`📢 ${title}`); // 상단 제목
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
    message.reply(`✅ Message sent to ${targetChannel.toString()}`);
  } catch (err) {
    console.error(err);
    message.reply('❌ Failed to send the message.');
  }
});

client.login(process.env.TOKEN);
