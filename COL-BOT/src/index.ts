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
import { env } from 'process';
dotenv.config();

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

const VERIFIED_ROLE_NAME = 'verified'; // 부여할 역할 이름
const BASE_ROLE_NAME = process.env.MANAGER;    // 기준 역할 이름 (수정 가능)

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  // 간단한 ping 명령어
  if (message.content === '!ping') {
    message.reply('🏓 Pong!');
    return;
  }

  // !setup verify [채널멘션 or 채널ID]
  if (message.content.startsWith('!setup verify')) {
    const member = message.member;
    if (!member) return;

    // 기준 역할 찾기
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

    if (!channel || channel.type !== 0) {
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
      } catch {
        message.reply('Failed to create verified role.');
        return;
      }
    }

    try {
      const verifyMessage = await textChannel.send('React to get verified');

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
        if (reaction.message.id !== verifyMessage.id) return;

        const guildMember = await reaction.message.guild?.members.fetch(user.id);
        if (!guildMember) return;

        if (!guildMember.roles.cache.has(verifiedRole!.id)) {
          await guildMember.roles.add(verifiedRole!);
        }
      });

      message.reply(`Verification setup completed in ${textChannel.toString()}`);
    } catch {
      message.reply('Failed to send verification message.');
    }
  }
});

client.login(process.env.TOKEN);
