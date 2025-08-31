import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionsBitField,
} from "discord.js";
import { readFileSync } from "fs";

const WIDTH = 16 * 5;
const HEIGHT = 9 * 4;

function convertToAscii(frameStr: string): string {
  const asciiMap: Record<string, string> = { "0": " ", "1": "#" };
  let result = "";
  for (let i = 0; i < frameStr.length; i += WIDTH) {
    result += frameStr
      .slice(i, i + WIDTH)
      .split("")
      .map((p) => asciiMap[p] ?? "?")
      .join("") + "\n";
  }
  return "```\n" + result + "```";
}

function loadFrames(filePath: string): string[] {
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export const data = new SlashCommandBuilder()
  .setName("badapple")
  .setDescription("Play Bad Apple!! in ASCII art style");

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "❌ only use in the col server.", ephemeral: true });
  }

  // 🔑 서버 오너 권한 체크
  if (interaction.user.id !== interaction.guild.ownerId) {
    return interaction.reply({
      content: "🚫 The server owner only.",
      ephemeral: true,
    });
  }

  const frames = loadFrames("./video.txt");
  let frameIndex = 0;
  let playing = true;

  const msg = await interaction.reply({
    content: convertToAscii(frames[frameIndex]),
    fetchReply: true,
  });

  await msg.react("⏹️");
  const collector = msg.createReactionCollector({
    filter: (reaction, user) => reaction.emoji.name === "⏹️" && !user.bot,
  });

  collector.on("collect", () => {
    playing = false;
    collector.stop();
  });

  const delay = 1000; // 1fps
  const interval = setInterval(async () => {
    if (!playing) {
      clearInterval(interval);
      return;
    }
    frameIndex++;
    if (frameIndex >= frames.length) {
      clearInterval(interval);
      return;
    }
    await msg.edit(convertToAscii(frames[frameIndex])).catch(() => {});
  }, delay);
}
