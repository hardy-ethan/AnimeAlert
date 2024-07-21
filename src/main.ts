import * as Discord from "discord.js";
import { MongoClient, Collection } from "mongodb";
import * as path from "path";

require("dotenv").config({ path: path.join(__dirname, "../.env") });

const utils = require(path.join(__dirname, "utils"));

const mongoClient = new MongoClient("mongodb://127.0.0.1:27017");

const discordClient = new Discord.Client({
  intents: [
    Discord.IntentsBitField.Flags.GuildMessages,
    Discord.IntentsBitField.Flags.Guilds,
    Discord.IntentsBitField.Flags.GuildMembers,
    Discord.IntentsBitField.Flags.MessageContent,
  ],
});

interface AnimeListEntry {
  id: number;
  title: string;
  subscribers: Discord.Snowflake[];
}
let animeListCollection: Collection<AnimeListEntry> = null;

interface AiringScheduleEntry {
  id: number;
  episode: number;
  airingAt: number;
  announced: boolean;
}
let airingScheduleCollection: Collection<AiringScheduleEntry> = null;

let announceChannel: Discord.BaseGuildTextChannel = null;

async function checkSubscriptions(animeEntries: AnimeListEntry[]) {
  for (const anime of animeEntries) {
    console.log(anime);
    const lastAiring: AiringScheduleEntry =
      await airingScheduleCollection.findOne({ id: anime.id });

    if (!lastAiring.announced && Date.now() / 1000 > lastAiring.airingAt) {
      const subscribersString = anime.subscribers
        .map((subscriber) => `<@${subscriber}>`)
        .join(" ");

      await announceChannel.send(
        `${subscribersString} ${anime.title} ep ${lastAiring.episode} airing`
      );

      await airingScheduleCollection.updateOne(
        { id: anime.id },
        { $set: { announced: true } }
      );
    }

    const { latestAiring, status: airingStatusResponseCode } =
      await utils.latestAiringEpisode(anime.id);

    if (latestAiring.episode === -1 && airingStatusResponseCode !== 404) {
      console.log(`Got status code ${airingStatusResponseCode}`);
      return;
    }

    if (latestAiring.episode != lastAiring.episode) {
      await airingScheduleCollection.updateOne(
        {
          id: anime.id,
        },
        {
          $set: {
            episode: latestAiring.episode,
            airingAt: latestAiring.airingAt,
            announced: latestAiring.episode === -1,
          },
        }
      );
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 60000 / animeEntries.length)
    );
  }
}

async function subscriptionLoop() {
  const startTime = Date.now();

  const animeEntries: AnimeListEntry[] = await animeListCollection
    .find()
    .toArray();

  if (animeEntries.length > 0) {
    await checkSubscriptions(animeEntries);
  }

  let timeElapsed = Date.now() - startTime;
  if (timeElapsed < 60000) {
    await new Promise((resolve) =>
      setTimeout(resolve, timeElapsed / Math.max(animeEntries.length, 1))
    );
  }

  return subscriptionLoop();
}

discordClient.on("ready", async () => {
  console.log("Discord bot connected!");

  // TODO: make this type safe by fetching guild first
  // @ts-ignore
  announceChannel = await discordClient.channels.fetch(
    process.env.ANNOUNCE_CHANNEL
  );

  subscriptionLoop();
});

discordClient.on("messageCreate", async (message: Discord.Message<boolean>) => {
  if (message.author.bot) {
    return;
  }

  const splitMessage = message.content.split(" ");
  const command = splitMessage[0];
  const args = splitMessage.slice(1);

  if (command.toLowerCase() === "!airs") {
    const search = args.join(" ");

    try {
      const {
        title,
        id: animeId,
        status: animeIdResponseCode,
      } = await utils.getAnilistIDFromSearchString(search);

      if (animeId === null) {
        return message.reply(`Got status code ${animeIdResponseCode}`);
      }

      const { latestAiring, status: airingStatusResponseCode } =
        await utils.latestAiringEpisode(animeId);

      if (airingStatusResponseCode === 404) {
        return message.reply("Not airing");
      }

      if (airingStatusResponseCode !== 200) {
        return message.reply(`Got status code ${airingStatusResponseCode}`);
      }

      return message.reply(`${title} airs on <t:${latestAiring["airingAt"]}>`);
    } catch (e) {
      console.error(e);
      return message.reply("error check log");
    }
  }

  if (command.toLowerCase() === "!subscribe") {
    const search = args.join(" ");

    try {
      const {
        title: animeTitle,
        id: animeId,
        status: animeIdRequestStatus,
      } = await utils.getAnilistIDFromSearchString(search);

      if (animeId === null) {
        return message.reply(`Got status code ${animeIdRequestStatus}`);
      }

      const isSubscribed =
        (await animeListCollection.findOne({
          id: animeId,
          subscribers: [message.author.id],
        })) !== null;

      if (isSubscribed) {
        return message.reply("You're already subscribed");
      }

      if ((await airingScheduleCollection.findOne({ id: animeId })) === null) {
        const { latestAiring, status: airingStatusResponseCode } =
          await utils.latestAiringEpisode(animeId);

        if (latestAiring.episode === -1 && airingStatusResponseCode !== 404) {
          return message.reply(`Got status code ${airingStatusResponseCode}`);
        }

        await airingScheduleCollection.insertOne({
          id: animeId,
          episode: latestAiring.episode,
          airingAt: latestAiring.airingAt,
          announced: latestAiring.episode === -1,
        });
      }

      await animeListCollection.updateOne(
        { id: animeId, title: animeTitle },
        { $push: { subscribers: message.author.id } },
        { upsert: true }
      );

      await message.reply(`Subscribed you to \`${animeTitle}\``);
    } catch (e) {
      console.error(e);
      return message.reply("error check log");
    }
  }

  if (command.toLowerCase() === "!unsubscribe") {
    const search = args.join(" ");

    try {
      const {
        title,
        id: animeId,
        status: animeIdRequestStatus,
      } = await utils.getAnilistIDFromSearchString(search);

      if (animeId === null) {
        return message.reply(`Got status code ${animeIdRequestStatus}`);
      }

      const isSubscribed =
        (await animeListCollection.findOne({
          id: animeId,
          subscribers: [message.author.id],
        })) !== null;

      if (!isSubscribed) {
        return message.reply("You're not subscribed");
      }

      await animeListCollection.updateOne(
        { id: animeId },
        { $pull: { subscribers: message.author.id } }
      );
      await message.reply(`Unsubscribed you from ${title}`);
    } catch (e) {
      console.error(e);
      return message.reply("error check log");
    }
  }

  if (command.toLowerCase() === "!subscribed") {
    const subscribed: AnimeListEntry[] = await animeListCollection
      .find({
        subscribers: message.author.id,
      })
      .toArray();

    if (subscribed.length === 0) {
      return message.reply("You aren't subscribed to anything");
    }

    const subscribedStrings = await Promise.all(
      subscribed.map(async (anime): Promise<String> => {
        const { latestAiring, status: airingStatusResponseCode } =
          await utils.latestAiringEpisode(anime.id);

        if (airingStatusResponseCode === 404) {
          return `\`${anime.title}\`: Not airing`;
        }

        if (airingStatusResponseCode !== 200) {
          return `\`${anime.title}\`: Got status code ${airingStatusResponseCode}`;
        }

        return `\`${anime.title}\`: <t:${latestAiring["airingAt"]}>`;
      })
    );

    return message.reply(
      `Your subscriptions:\n${subscribedStrings.join("\n")}`
    );
  }

  if (command.toLowerCase() === "!ok") {
    await message.reply("ok");
  }
});

mongoClient.connect().then(() => {
  console.log("MongoDB client connected!");

  animeListCollection = mongoClient
    .db("animealert")
    .collection<AnimeListEntry>("anime");
  airingScheduleCollection = mongoClient
    .db("animealert")
    .collection<AiringScheduleEntry>("airingSchedule");

  discordClient.login(process.env.DISCORD_TOKEN);
});
