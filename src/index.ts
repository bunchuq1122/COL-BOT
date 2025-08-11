import {
  Client,
  GatewayIntentBits,
  Partials,
  TextChannel,
  GuildMember,
  SlashCommandBuilder
} from 'discord.js';
import * as dotenv from 'dotenv';
import http from 'http';
dotenv.config();

// HTTP 서버 (Render ping용)
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

// 재미용 단계별 역할 이름
const VERIFY_STAGES = [
  'verified',
  'double verified',
  'triple verified',
  'ultimately verified'
];

// 명령어 등록
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

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'verifyme') {
    if (!interaction.guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }

    const member = interaction.member as GuildMember;

    // 현재 어떤 단계까지 가지고 있는지 체크
    let currentStage = -1;
    for (let i = VERIFY_STAGES.length - 1; i >= 0; i--) {
      if (member.roles.cache.some(r => r.name.toLowerCase() === VERIFY_STAGES[i].toLowerCase())) {
        currentStage = i;
        break;
      }
    }

    // 다음 단계 계산
    const nextStage = Math.min(currentStage + 1, VERIFY_STAGES.length - 1);
    const roleName = VERIFY_STAGES[nextStage];

    // 역할 찾기 또는 생성
    let role = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (!role) {
      role = await interaction.guild.roles.create({
        name: roleName,
        reason: 'Verification stage role'
      });
    }

    // 역할 부여
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role);
    }
  }
});

client.login(process.env.TOKEN);
