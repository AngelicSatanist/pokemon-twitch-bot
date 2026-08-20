require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const tmi = require("tmi.js");
const path = require("path");
const pokemonList = require("./data/pokemon.json");

const games = {};

// =====================================================
// FUN COMMAND RESULTS
// =====================================================

const funCommandResults = {
    inches: new Map(),
    girth: new Map()
};

// =====================================================
// BOT CONFIGURATION
// =====================================================

const CONFIG = {
    botAdmin: (process.env.BOT_ADMIN_USERNAME || "angelicsatanist")
        .trim()
        .toLowerCase(),

    personalChannel: (process.env.PERSONAL_CHANNEL || "angelicsatanist")
        .trim()
        .toLowerCase(),

    discordUrl:
        process.env.DISCORD_URL || "https://discord.gg/HtW7nnDZub",

    nextRoundDelay: 5000
};

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);    
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY
);

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "overlay", "index.html"));
});

app.use(express.static("overlay"));
app.use("/artwork", express.static(path.join(__dirname, "images", "artwork")));

app.get("/theme/:channel", async (req, res) => {
    const channel = req.params.channel.toLowerCase();

    const response = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/channels?select=overlay_theme&channel_name=eq.${channel}`,
        {
            headers: {
                apikey: process.env.SUPABASE_ANON_KEY,
                Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`
            }
        }
    );

    const data = await response.json();

    res.json({
        theme: data[0]?.overlay_theme || "default"
    });
});

app.use(express.json());

app.post("/add-channel", async (req, res) => {
    const channelName = req.body.channelName?.toLowerCase().trim();

    if (!channelName) {
        return res.status(400).json({ error: "Channel name is required." });
    }

    const cleanChannel = channelName.replace("@", "");

    const response = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/channels`,
        {
            method: "POST",
            headers: {
                apikey: process.env.SUPABASE_ANON_KEY,
                Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
                "Content-Type": "application/json",
                Prefer: "resolution=merge-duplicates"
            },
            body: JSON.stringify({
                channel_name: cleanChannel,
                enabled: true,
                overlay_theme: "default",
                points_enabled: false
            })
        }
    );

    if (!response.ok) {
        const errorText = await response.text();
        return res.status(500).json({ error: errorText });
    }

    res.json({
        success: true,
        channelName: cleanChannel,
        overlayUrl: `https://pokemon-twitch-bot.onrender.com/?channel=${cleanChannel}`
    });
});

app.get("/game/:channel", (req, res) => {
    const channel = normalizeChannel(req.params.channel);
    const game = getGame(channel);

    res.json({
        active: game.gameActive
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Overlay running on port ${PORT}`);
});

async function loadChannelsFromSupabase() {
    const { data, error } = await supabase
        .from("channels")
        .select("channel_name")
        .eq("enabled", true);

    if (error) {
        console.error(
            "Couldn't load channels from Supabase:",
            error
        );

        return [];
    }

    return data
        .map(row => normalizeChannel(row.channel_name))
        .filter(Boolean);
}

let client;
let joinedChannels = new Set();

function getGame(channel) {
    if (!games[channel]) {
        games[channel] = {
            currentPokemon: null,
            gameActive: false,
            hintLettersRevealed: 0,
            nextRoundTimer: null
        };
    }

    return games[channel];
}

function clearNextRoundTimer(channel) {
    const game = getGame(channel);

    if (game.nextRoundTimer) {
        clearTimeout(game.nextRoundTimer);
        game.nextRoundTimer = null;
    }
}


function scheduleNextRound(channel) {
    const game = getGame(channel);

    clearNextRoundTimer(channel);

    game.nextRoundTimer = setTimeout(() => {
        game.nextRoundTimer = null;
        startNewRound(channel);
    }, CONFIG.nextRoundDelay);
}


function stopGame(channel) {
    const game = getGame(channel);

    clearNextRoundTimer(channel);

    game.gameActive = false;
    game.currentPokemon = null;
    game.hintLettersRevealed = 0;

    io.to(channel).emit("clearPokemon");
}

function getRandomPokemon() {
    const randomIndex = Math.floor(Math.random() * pokemonList.length);
    return pokemonList[randomIndex];
}

function startNewRound(channel) {
    const cleanChannel = normalizeChannel(channel);
    const game = getGame(cleanChannel);

    clearNextRoundTimer(cleanChannel);

    game.currentPokemon = getRandomPokemon();
    game.gameActive = true;
    game.hintLettersRevealed = 0;

    io.to(cleanChannel).emit(
        "newPokemon",
        game.currentPokemon
    );

    console.log(
        `New round for ${cleanChannel}:`,
        game.currentPokemon.displayName
    );
}

io.on("connection", (socket) => {
    const channel = socket.handshake.query.channel;

    if (channel) {
        const cleanChannel = normalizeChannel(channel);
        socket.join(cleanChannel);
        console.log(`Overlay connected for ${cleanChannel}`);

        const game = getGame(cleanChannel);

        if (game.gameActive && game.currentPokemon) {
            socket.emit("newPokemon", game.currentPokemon);
        }
    }
});

async function awardPoint(channel, username) {
    const cleanChannel = normalizeChannel(channel);
    const cleanUsername = username.toLowerCase();

    const { data: existingPlayer, error: findError } = await supabase
        .from("leaderboard")
        .select("id, points, correct_guesses")
        .eq("channel_name", cleanChannel)
        .eq("username", cleanUsername)
        .maybeSingle();

    if (findError) {
        console.error("Leaderboard lookup error:", findError);
        return false;
    }

    if (existingPlayer) {
        const { error: updateError } = await supabase
            .from("leaderboard")
            .update({
                points: existingPlayer.points + 1,
                correct_guesses: existingPlayer.correct_guesses + 1
            })
            .eq("id", existingPlayer.id);

        if (updateError) {
            console.error("Leaderboard update error:", updateError);
            return false;
        }
    } else {
        const { error: insertError } = await supabase
            .from("leaderboard")
            .insert({
                channel_name: cleanChannel,
                username: cleanUsername,
                points: 1,
                correct_guesses: 1
            });

        if (insertError) {
            console.error("Leaderboard insert error:", insertError);
            return false;
        }
    }

    return true;
}

async function getTopFive(channel) {
    const { data, error } = await supabase
        .from("leaderboard")
        .select("username, points")
        .eq("channel_name", normalizeChannel(channel))
        .order("points", { ascending: false })
        .order("correct_guesses", { ascending: false })
        .limit(5);

    if (error) {
        console.error("Leaderboard read error:", error);
        return null;
    }

    return data;
}


async function startBot() {
    const channels = await loadChannelsFromSupabase();

    if (channels.length === 0) {
        console.error("No enabled channels found in Supabase.");
        process.exit(1);
    }

    client = new tmi.Client({
        identity: {
            username: process.env.TWITCH_USERNAME,
            password: process.env.TWITCH_OAUTH
        },
        channels: channels
    });

    client.connect();

    client.on("connected", () => {
        channels.forEach(channel => joinedChannels.add(channel));
        console.log("Bot connected to:", [...joinedChannels]);
    });

    async function handlePersonalCommand(channel, tags, message) {

        // Remove the # from the Twitch channel name
        const cleanChannel = normalizeChannel(channel);

        // Basic commands should ONLY work in AngelicSatanist's channel
        if (cleanChannel !== CONFIG.personalChannel) {
            return false;
        }

        // Ignore anything that isn't a command
        if (!message.startsWith("!")) {
            return false;
        }

        // Turn "!hello everyone" into:
        // command = "hello"
        // args = ["everyone"]
        const args = message.slice(1).trim().split(/\s+/);
        const command = args.shift().toLowerCase();

        const username = getDisplayName(tags);
        const accountName = getUsername(tags);

        switch (command) {

            case "inches": {

                try {
                    const roll =
                        await getOrCreateFunRoll(
                            cleanChannel,
                            accountName,
                            "inches",
                            () => randomNumber(1, 12)
                        );

                    if (roll.offline) {
                        client.say(
                            channel,
                            `📏 @${username}, you can only discover your inches while the stream is live!`
                        );

                        return true;
                    }

                    client.say(
                        channel,
                        `📏 @${username} is packing ${roll.result} inches! 😳`
                    );

                } catch (error) {
                    console.error(
                        "!inches error:",
                        error
                    );

                    client.say(
                        channel,
                        `The measuring tape broke while measuring @${username} 💀`
                    );
                }

                return true;
            }

            case "girth": {

                try {
                    const roll =
                        await getOrCreateFunRoll(
                            cleanChannel,
                            accountName,
                            "girth",
                            () => randomNumber(1, 10)
                        );

                    if (roll.offline) {
                        client.say(
                            channel,
                            `⭕ @${username}, girth calculations are only available while the stream is live!`
                        );

                        return true;
                    }

                    client.say(
                        channel,
                        `⭕ @${username} has a girth of ${roll.result} inches! 💀`
                    );

                } catch (error) {
                    console.error(
                        "!girth error:",
                        error
                    );

                    client.say(
                        channel,
                        `The girth calculator broke trying to measure @${username} 💀`
                    );
                }

                return true;
            }
            case "cup":
            case "cupsize": {

                try {
                    const cupSizes = [
                        "AA",
                        "A",
                        "B",
                        "C",
                        "D",
                        "DD",
                        "E",
                        "F",
                        "G",
                        "H"
                    ];

                    const roll =
                        await getOrCreateFunRoll(
                            cleanChannel,
                            accountName,
                            "cup",
                            () => randomChoice(cupSizes)
                        );

                    if (roll.offline) {
                        client.say(
                            channel,
                            `🎀 @${username}, cup calculations only happen while the stream is live!`
                        );

                        return true;
                    }

                    client.say(
                        channel,
                        `🎀 @${username}'s cup size this stream is ${roll.result}!`
                    );

                } catch (error) {
                    console.error(
                        "!cup error:",
                        error
                    );

                    client.say(
                        channel,
                        `The cup calculator couldn't handle @${username} 😭`
                    );
                }

                return true;
            }
            case "so":
            case "shoutout": {

                if (!canUseCommand("moderator", channel, tags)) {
                    client.say(
                        channel,
                        `@${username}, that command is only available to moderators.`
                    );

                    return true;
                }

                const target = args[0];

                if (!target) {
                    client.say(
                        channel,
                        `@${username}, please tell me who you want to shout out!`
                    );

                    return true;
                }

                const cleanTarget = target.replace("@", "");

                client.say(
                    channel,
                    `💗 Go check out @${cleanTarget}! https://twitch.tv/${cleanTarget}`
                );

                return true;
            }
            case "inches": {

                const inches = getFunCommandResult(
                    "inches",
                    accountName,
                    1,
                    20
                );

                client.say(
                    channel,
                    `📏 @${username} is ${inches} inches! 😳`
                );

                return true;
            }

            case "girth": {

                const girth = getFunCommandResult(
                    "girth",
                    accountName,
                    1,
                    10
                );

                client.say(
                    channel,
                    `⭕ @${username} has a girth of ${girth} inches! 💀`
                );

                return true;
                
            }

            case "resetfun":
            case "newstream": {

                if (!canUseCommand("owner", channel, tags)) {
                    return true;
                }

                resetFunCommandResults();

                client.say(
                    channel,
                    `🎲 New stream, new questionable measurements! Fun command results have been reset.`
                );

                return true;
            }

            case "hello":
            case "hi":
                client.say(channel, `Hi @${username}! 💗`);
                return true;


            case "lurk":
                client.say(
                    channel,
                    `Thanks for the lurk @${username}! 💕 Enjoy your lurky lurking!`
                );
                return true;


            case "commands":
                client.say(
                    channel,
                    `Commands: !hello | !lurk | !discord | !hug | !inches | !girth | !cup`
                );
                return true;


            case "discord":
                client.say(
                    channel,
                    `💗 Join the Discord: ${CONFIG.discordUrl}`
                );
                return true;


            //case "socials":
            //    client.say(
            //        channel,
            //        `✨ You can find Angel's socials here: YOUR_SOCIALS_LINK`
            //    );
            //    return true;


            case "hug": {
                const target = args.join(" ");

                if (!target) {
                    client.say(
                        channel,
                        `@${username} is sending hugs to everyone! 🩷`
                    );
                } else {
                    client.say(
                        channel,
                        `@${username} gives ${target} a big hug! 🫂💕`
                    );
                }

                return true;
            }
            default:
                return false;
        }
    }

    client.on("message", async (channel, tags, message, self) => {
        if (self) return;

        if (
            await handlePersonalCommand(
                channel,
                tags,
                message
            )
        ) {
            return;
        }

        const msg = message.toLowerCase().trim();
        const username = getUsername(tags);
        const displayName = getDisplayName(tags);
        const replyChannel = normalizeChannel(channel);
        const game = getGame(replyChannel);

        const requiredPermission =
            POKEMON_COMMAND_PERMISSIONS[msg];

        if (
            requiredPermission &&
            !canUseCommand(requiredPermission, channel, tags)
        ) {
            return;
        }

        console.log(`Message received in: ${replyChannel}`);

        if (msg === "!reloadchannels") {

            if (replyChannel !== CONFIG.personalChannel) {
                return;
            }

            if (!canUseCommand("botAdmin", channel, tags)) {
                return;
            }

            await reloadChannels();

            client.say(
                replyChannel,
                `✅ Channel list reloaded! Currently connected to ${joinedChannels.size} channels.`
            );

            return;
        }

        if (msg === "!wtplb") {
        const topPlayers = await getTopFive(replyChannel);

        if (topPlayers === null) {
            client.say(
                replyChannel,
                "I couldn't load the leaderboard right now."
            );
            return;
        }

        if (topPlayers.length === 0) {
            client.say(
                replyChannel,
                "🏆 The leaderboard is empty. Be the first person to guess a Pokémon!"
            );
            return;
        }

        const leaderboardText = topPlayers
            .map((player, index) => {
                return `${index + 1}. ${player.username} — ${player.points} point${player.points === 1 ? "" : "s"}`;
            })
            .join(" | ");

        client.say(
            replyChannel,
            `🏆 Who's That Pokémon Top 5 🏆 | ${leaderboardText}`
        );

        return;
    }

        if (msg === "!wtpstart") {
            if (game.gameActive) {
                client.say(replyChannel, "A Pokémon round is already active! Guess the Pokémon!");
                return;
            }

            startNewRound(replyChannel);
            client.say(replyChannel, "Who's That Pokémon? Guess now in chat!");
            return;
        }

        if (msg === "!wtpgen") {
            if (!game.gameActive || !game.currentPokemon) {
                client.say(
                    replyChannel,
                    "There is no active Pokémon round."
                );
                return;
            }

            const generation = game.currentPokemon.generation;

            if (!generation) {
                client.say(
                    replyChannel,
                    "Generation information is unavailable for this Pokémon."
                );
                return;
            }

            client.say(
                replyChannel,
                `The current Pokémon is from Gen ${generation}.`
            );

            return;
        }

        if (msg === "!wtpstop") {

            stopGame(replyChannel);

            client.say(
                replyChannel,
                "Who's That Pokémon has been stopped."
            );

            return;
        }

        if (msg === "!wtpskip") {
            if (!game.gameActive || !game.currentPokemon) {
                client.say(replyChannel, "There is no active Pokémon round.");
                return;
            }

            client.say(
                replyChannel,
                `⏭️Pokémon skipped!⏭️ • It was ${game.currentPokemon.displayName}. • 📖 Pokédex entry: ${game.currentPokemon.pokedexEntry} • ⌛ Next Pokémon in 5 seconds...`
            );

            io.to(replyChannel).emit("revealPokemon", {
                ...game.currentPokemon,
                skipped: true
            });

            game.gameActive = false;

            scheduleNextRound(replyChannel);

            return;
        }

        if (msg === "!wtprefresh") {
            if (game.gameActive && game.currentPokemon) {
                io.to(replyChannel).emit("newPokemon", game.currentPokemon);
                client.say(replyChannel, "Overlay refreshed.");
            } else {
                client.say(
                    replyChannel, 
                    "There is no active Pokémon round to refresh."
                );
            }

            return;
        }

        if (msg === "!wtphint") {
            if (!game.gameActive || !game.currentPokemon) {
                client.say(
                    replyChannel,
                    "There is no active Pokémon round to give a hint for."
                );
                return;
            }

            const pokemonName = game.currentPokemon.displayName;
            const totalLetters = pokemonName.replace(/[^a-zA-Z0-9]/g, "").length;

            if (game.hintLettersRevealed >= totalLetters) {
                client.say(
                    replyChannel,
                    `The full name has already been revealed: ${pokemonName}`
                );
                return;
            }

            game.hintLettersRevealed++;

            const hint = createPokemonHint(
                pokemonName,
                game.hintLettersRevealed
            );

            client.say(
                replyChannel,
                `🔎 Hint: ${hint}`
            );

            return;
        }

        if (game.gameActive && game.currentPokemon) {

            if (
                normalizePokemonName(msg) ===
                normalizePokemonName(game.currentPokemon.name)
            ) {

                // Lock the round immediately so nobody else can win it
                game.gameActive = false;

                // Save the Pokémon before doing asynchronous work
                const correctPokemon = game.currentPokemon;

                const pointAwarded = await awardPoint(
                    replyChannel,
                    username
                );

                if (!pointAwarded) {
                    console.error(
                        `Failed to award point to ${username} in ${replyChannel}`
                    );
                }

                client.say(
                    replyChannel,
                    `🎉 ${displayName} guessed correctly! 🎉 • It was ${correctPokemon.displayName}! • 📖 Pokédex entry: ${correctPokemon.pokedexEntry} • ⌛ Next Pokémon in 5 seconds...`
                );

                io.to(replyChannel).emit("revealPokemon", {
                    ...correctPokemon,
                    winner: displayName
                });

                scheduleNextRound(replyChannel);

                return;
            }
        }
    });
}
async function reloadChannels() {
    const latestChannels = await loadChannelsFromSupabase();

    // Join new channels
    for (const channel of latestChannels) {
        if (!joinedChannels.has(channel)) {
            try {
                await client.join(channel);
                joinedChannels.add(channel);
                console.log(`Joined ${channel}`);
            } catch (err) {
                console.error(`Couldn't join ${channel}:`, err);
            }
        }
    }

    // Leave disabled channels
    for (const channel of [...joinedChannels]) {
        if (!latestChannels.includes(channel)) {
            try {
                // Stop any active game and cancel pending timers
                stopGame(channel);

                await client.part(channel);

                joinedChannels.delete(channel);

                // Remove the channel's saved game state
                delete games[channel];

                console.log(`Left ${channel}`);
            } catch (err) {
                console.error(`Couldn't leave ${channel}:`, err);
            }
        }
    }

    return {
        joined: [...joinedChannels]
    };
}

// =====================================================
// COMMAND PERMISSIONS
// =====================================================

function canUseCommand(requiredPermission, channel, tags) {
    const cleanChannel = normalizeChannel(channel);
    const username = getUsername(tags);

    const isOwner = username === cleanChannel;

    const isModerator =
        isOwner ||
        tags?.mod === true ||
        tags?.badges?.moderator === "1";

    const isBotAdmin =
        username === CONFIG.botAdmin;

    switch (requiredPermission) {

        case "viewer":
            return true;

        case "moderator":
            return isModerator;

        case "owner":
            return isOwner;

        case "botAdmin":
            return isBotAdmin;

        default:
            return false;
    }
}

function normalizePokemonName(name) {
    return name
        .toLowerCase()

        // Special symbols
        .replace(/♀/g, " female")
        .replace(/♂/g, " male")

        // Remove punctuation
        .replace(/[.'’`´\-:,!?]/g, "")

        // Remove brackets
        .replace(/[()]/g, "")

        // Remove extra spaces
        .replace(/\s+/g, " ")

        .trim();
}

function createPokemonHint(name, lettersToReveal) {
    let lettersSeen = 0;

    return name
        .split("")
        .map(character => {
            // Show spaces and punctuation automatically
            if (!/[a-zA-Z0-9]/.test(character)) {
                return character;
            }

            lettersSeen++;

            if (lettersSeen <= lettersToReveal) {
                return character.toUpperCase();
            }

            return "_";
        })
        .join(" ");
}

// =====================================================
// TWITCH STREAM SESSION
// =====================================================

let twitchAppToken = null;
let twitchAppTokenExpiresAt = 0;

const streamIdCache = new Map();


async function getTwitchAppToken() {

    // Keep using the current token while it is valid
    if (
        twitchAppToken &&
        Date.now() < twitchAppTokenExpiresAt
    ) {
        return twitchAppToken;
    }

    const params = new URLSearchParams({
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: "client_credentials"
    });

    const response = await fetch(
        "https://id.twitch.tv/oauth2/token",
        {
            method: "POST",
            headers: {
                "Content-Type":
                    "application/x-www-form-urlencoded"
            },
            body: params
        }
    );

    if (!response.ok) {
        const errorText = await response.text();

        throw new Error(
            `Couldn't get Twitch app token: ${errorText}`
        );
    }

    const data = await response.json();

    twitchAppToken = data.access_token;

    twitchAppTokenExpiresAt =
        Date.now() +
        (Math.max(data.expires_in - 60, 0) * 1000);

    return twitchAppToken;
}

async function getCurrentStreamId(channel) {

    const cleanChannel = normalizeChannel(channel);

    // Cache Twitch's answer for 30 seconds
    const cached = streamIdCache.get(cleanChannel);

    if (
        cached &&
        Date.now() - cached.checkedAt < 30000
    ) {
        return cached.streamId;
    }

    const token = await getTwitchAppToken();

    const response = await fetch(
        `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(cleanChannel)}`,
        {
            headers: {
                "Client-Id":
                    process.env.TWITCH_CLIENT_ID,

                Authorization:
                    `Bearer ${token}`
            }
        }
    );

    if (!response.ok) {
        const errorText = await response.text();

        throw new Error(
            `Couldn't check Twitch stream: ${errorText}`
        );
    }

    const data = await response.json();

    const streamId =
        data.data?.[0]?.id || null;

    streamIdCache.set(cleanChannel, {
        streamId,
        checkedAt: Date.now()
    });

    return streamId;
}

// =====================================================
// TWITCH HELPERS
// =====================================================

function normalizeChannel(channel) {
    return String(channel || "")
        .replace(/^#/, "")
        .replace(/^@/, "")
        .trim()
        .toLowerCase();
}


function getUsername(tags) {
    return String(tags?.username || tags?.["display-name"] || "")
        .replace(/^@/, "")
        .trim()
        .toLowerCase();
}


function getDisplayName(tags) {
    return tags?.["display-name"] || tags?.username || "viewer";
}

// =====================================================
// FUN COMMAND HELPERS
// =====================================================

function randomNumber(min, max) {
    return Math.floor(
        Math.random() * (max - min + 1)
    ) + min;
}


function randomChoice(options) {
    return options[
        Math.floor(Math.random() * options.length)
    ];
}

async function getOrCreateFunRoll(
    channel,
    username,
    commandName,
    generateResult
) {

    const cleanChannel =
        normalizeChannel(channel);

    const cleanUsername =
        String(username)
            .trim()
            .toLowerCase();

    // Ask Twitch which stream is currently running
    const streamId =
        await getCurrentStreamId(cleanChannel);

    // Channel isn't currently live
    if (!streamId) {
        return {
            offline: true,
            result: null,
            isNew: false
        };
    }

    // Look for an existing roll
    const {
        data: existingRoll,
        error: findError
    } = await supabaseAdmin
        .from("fun_rolls")
        .select("result")
        .eq("channel_name", cleanChannel)
        .eq("stream_id", streamId)
        .eq("username", cleanUsername)
        .eq("command_name", commandName)
        .maybeSingle();

    if (findError) {
        console.error(
            "Fun roll lookup error:",
            findError
        );

        throw findError;
    }

    // They already used this command this stream
    if (existingRoll) {
        return {
            offline: false,
            result: existingRoll.result,
            isNew: false
        };
    }

    // First use this stream - generate their result
    const result =
        String(generateResult());

    const { error: insertError } =
        await supabaseAdmin
            .from("fun_rolls")
            .insert({
                channel_name: cleanChannel,
                stream_id: streamId,
                username: cleanUsername,
                command_name: commandName,
                result: result
            });

    if (insertError) {

        // If two identical requests arrived at almost
        // exactly the same time, check the database again
        const {
            data: retryRoll
        } = await supabaseAdmin
            .from("fun_rolls")
            .select("result")
            .eq("channel_name", cleanChannel)
            .eq("stream_id", streamId)
            .eq("username", cleanUsername)
            .eq("command_name", commandName)
            .maybeSingle();

        if (retryRoll) {
            return {
                offline: false,
                result: retryRoll.result,
                isNew: false
            };
        }

        console.error(
            "Fun roll insert error:",
            insertError
        );

        throw insertError;
    }

    return {
        offline: false,
        result: result,
        isNew: true
    };
}

// =====================================================
// POKÉMON COMMAND PERMISSIONS
// =====================================================

const POKEMON_COMMAND_PERMISSIONS = {
    "!wtplb": "viewer",
    "!wtpgen": "viewer",
    "!wtphint": "viewer",

    "!wtpstart": "moderator",
    "!wtpstop": "moderator",
    "!wtpskip": "moderator",
    "!wtprefresh": "moderator"
};

// =====================================================
// FUN COMMAND HELPERS
// =====================================================

function getFunCommandResult(commandName, username, min, max) {
    const results = funCommandResults[commandName];

    // If they haven't rolled this stream, generate a number
    if (!results.has(username)) {
        const result =
            Math.floor(Math.random() * (max - min + 1)) + min;

        results.set(username, result);
    }

    // Otherwise return the number they already got
    return results.get(username);
}


function resetFunCommandResults() {
    Object.values(funCommandResults).forEach(results => {
        results.clear();
    });
}
startBot();