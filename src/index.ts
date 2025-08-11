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

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN!);

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

// Simple HTTP server (for Render uptime pings)
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is running');
}).listen(port, () => {
  console.log(`Server running on port ${port}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel]
});

// Fun verification stages
const VERIFY_STAGES = [
  'verified',
  'double verified',
  'triple verified',
  'ultimately verified'
];

// Register slash commands when bot starts
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);

  const data = [
    new SlashCommandBuilder()
      .setName('verifyme')
      .setDescription('Get verified (and fun titles if you run it multiple times!)')
      .toJSON()
  ];

  const appId = process.env.CLIENT_ID!;
  await client.application?.commands.set(data);
  console.log('✅ Slash command registered');
});

// Handle slash command /verifyme
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'verifyme') {
    if (!interaction.guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }

    const member = interaction.member as GuildMember;

    // Check what stage the member currently has
    let currentStage = -1;
    for (let i = VERIFY_STAGES.length - 1; i >= 0; i--) {
      if (member.roles.cache.some(r => r.name.toLowerCase() === VERIFY_STAGES[i].toLowerCase())) {
        currentStage = i;
        break;
      }
    }

    // Determine the next stage
    const nextStage = Math.min(currentStage + 1, VERIFY_STAGES.length - 1);
    const roleName = VERIFY_STAGES[nextStage];

    // Find or create the role
    let role = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (!role) {
      role = await interaction.guild.roles.create({
        name: roleName,
        reason: 'Verification stage role'
      });
    }

    // Add the role if not already owned
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role);
    }
  }
});

/**
 * !say command
 * Usage: !say [channelMention/channelID] [content] [title(optional)] [description(optional)]
 * Restrictions: Only members with role >= MANAGER can use.
 */
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const PREFIX = '!say';
  if (!message.content.startsWith(PREFIX)) return;

  const member = message.member;
  if (!member) return;

  // Find the base role from environment variable
  const baseRoleName = process.env.MANAGER || '';
  const baseRole = message.guild.roles.cache.find(r => r.name === baseRoleName);
  if (!baseRole) {
    message.reply(`Base role "${baseRoleName}" not found.`);
    return;
  }

  // Permission check
  if (member.roles.highest.position < baseRole.position) {
    message.reply('❌ You do not have permission to use this command.');
    return;
  }

  // Split the arguments
  const args = message.content.trim().split(/\s+/);
  if (args.length < 3) {
    message.reply('❌ Usage: !say [channelMention/channelID] [content] [title(optional)] [description(optional)]');
    return;
  }

  const channelArg = args[1];
  let targetChannel: TextChannel | null = null;

  // Detect channel mention <#id> or raw ID
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

  // Extract content, title, and description
  const content = args[2];
  const title = args[3] || '';
  const description = args[4] || '';

  // Build embed
  const embed = new EmbedBuilder()
    .setColor('#2f3136')
    .setDescription(content);

  if (title) embed.setAuthor({ name: title });
  if (description) embed.setFooter({ text: description });

  try {
    await targetChannel.send({ embeds: [embed] });
    message.reply(`✅ Message sent to ${targetChannel.toString()}`);
  } catch (err) {
    console.error(err);
    message.reply('❌ Failed to send the message.');
  }
});

client.login(process.env.TOKEN);
