import { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  TextChannel, 
  MessageReaction, 
  PartialMessageReaction, 
  User, 
  PartialUser 
} from 'discord.js';
import * as dotenv from 'dotenv';
import http from 'http';
dotenv.config();

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
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const VERIFIED_ROLE_NAME = 'verified'; 
const BASE_ROLE_NAME = process.env.MANAGER || ''; // 환경변수에서 불러옴

let verifyMessageId: string | null = null;
let verifiedRoleId: string | null = null;

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);
});

client.on('messageReactionAdd', async (
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser
) => {
  try {
    if (reaction.partial) await reaction.fetch();
    if (user.partial) await user.fetch();
  } catch {
    return;
  }

  if (user.bot) return;
  if (!verifyMessageId) return;
  if (reaction.message.id !== verifyMessageId) return;

  const guild = reaction.message.guild;
  if (!guild) return;

  try {
    const member = await guild.members.fetch(user.id);
    if (!member) return;

    if (!verifiedRoleId) return;
    if (!member.roles.cache.has(verifiedRoleId)) {
      await member.roles.add(verifiedRoleId);
      console.log(`Added verified role to ${user.tag}`);
    }
  } catch (e) {
    console.error('Error adding verified role:', e);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  // !ping 간단 테스트용
  if (message.content === '!ping') {
    message.reply('🏓 Pong!');
    return;
  }

  // !setup verify [채널멘션 or 채널ID]
  if (message.content.startsWith('!setup verify')) {
    const member = message.member;
    if (!member) return;

    // 기준 역할 가져오기
    const baseRole = message.guild.roles.cache.find(r => r.name === BASE_ROLE_NAME);
    if (!baseRole) {
      message.reply(`Base role "${BASE_ROLE_NAME}" not found.`);
      return;
    }

    // 권한 체크
    if (member.roles.highest.position < baseRole.position) {
      message.reply('You do not have permission to run this command.');
      return;
    }

    // 채널 파싱
    const args = message.content.trim().split(/\s+/);
    const channelArg = args[2];
    if (!channelArg) {
      message.reply('Please specify a text channel.');
      return;
    }

    let channel = null;
    const channelIdMatch = channelArg.match(/^<#(\d+)>$/);
    if (channelIdMatch) {
      channel = message.guild.channels.cache.get(channelIdMatch[1]);
    } else {
      channel = message.guild.channels.cache.get(channelArg);
    }

    if (!channel || channel.type !== 0) { // type 0 = GUILD_TEXT
      message.reply('Please specify a valid text channel.');
      return;
    }
    const textChannel = channel as TextChannel;

    // verified 역할 찾기 또는 생성
    let verifiedRole = message.guild.roles.cache.find(r => r.name.toLowerCase() === VERIFIED_ROLE_NAME.toLowerCase());
    if (!verifiedRole) {
      try {
        verifiedRole = await message.guild.roles.create({
          name: VERIFIED_ROLE_NAME,
          reason: 'Role for verified users',
        });
      } catch (e) {
        console.error('Failed to create verified role:', e);
        message.reply('Failed to create verified role.');
        return;
      }
    }

    try {
      const sentMessage = await textChannel.send('React with any emoji to get verified');
      verifyMessageId = sentMessage.id;
      verifiedRoleId = verifiedRole.id;

      message.reply(`Verification setup completed in ${textChannel.toString()}`);
    } catch (e) {
      console.error('Failed to send verification message:', e);
      message.reply('Failed to send verification message.');
    }
  }
});

client.login(process.env.TOKEN);
