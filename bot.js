require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const tmi = require("tmi.js");
const path = require("path");
const pokemonList = require("./data/pokemon.json");

const games = {};

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
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
    const channel = req.params.channel.toLowerCase();
    const game = getGame(channel);

    res.json({
        active: game.gameActive,
        pokemon: game.currentPokemon
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Overlay running on port ${PORT}`);
});

async function loadChannelsFromSupabase() {
    const supabaseUrl = process.env.SUPABASE_URL.trim();
    const supabaseKey = process.env.SUPABASE_ANON_KEY.trim();

    const url = `${supabaseUrl}/rest/v1/channels?select=channel_name&enabled=eq.true`;

    console.log("Loading channels from:", url);

    const response = await fetch(url, {
        headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error("Supabase REST error:", response.status, errorText);
        return [];
    }

    const data = await response.json();

    return data.map(row => row.channel_name.toLowerCase());
}

let client;
let joinedChannels = new Set();

function getGame(channel) {
    if (!games[channel]) {
        games[channel] = {
            currentPokemon: null,
            gameActive: false,
            hintLettersRevealed: 0
        };
    }

    return games[channel];
}

function getRandomPokemon() {
    const randomIndex = Math.floor(Math.random() * pokemonList.length);
    return pokemonList[randomIndex];
}

function startNewRound(channel) {
    const game = getGame(channel);

    game.currentPokemon = getRandomPokemon();
    game.gameActive = true;
    game.hintLettersRevealed = 0;

    io.to(channel).emit("newPokemon", game.currentPokemon);

    console.log(`New round for ${channel}:`, game.currentPokemon.displayName);
}

io.on("connection", (socket) => {
    const channel = socket.handshake.query.channel;

    if (channel) {
        const cleanChannel = channel.toLowerCase();
        socket.join(cleanChannel);
        console.log(`Overlay connected for ${cleanChannel}`);

        const game = getGame(cleanChannel);

        if (game.gameActive && game.currentPokemon) {
            socket.emit("newPokemon", game.currentPokemon);
        }
    }
});

async function awardPoint(channel, username) {
    const cleanChannel = channel.toLowerCase();
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
        .eq("channel_name", channel.toLowerCase())
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

    client.on("message", async (channel, tags, message, self) => {
        if (self) return;

        const msg = message.toLowerCase().trim();
        const username = tags["display-name"];
        const replyChannel = channel.replace("#", "").toLowerCase();
        const game = getGame(replyChannel);

        console.log(`Message received in: ${replyChannel}`);

        if (msg === "!reloadchannels") {

            // Only you can use it
            if (replyChannel !== "angelicsatanist") {
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
                "There isn't an active Pokémon round."
            );
            return;
        }

            client.say(
                replyChannel,
                `📘 The current Pokémon is from Generation ${game.currentPokemon.generation}.`
            );

            return;
        }

        if (msg === "!wtpstop") {
            game.gameActive = false;
            game.currentPokemon = null;
            game.hintLettersRevealed = 0;
            io.to(replyChannel).emit("clearPokemon");
            client.say(replyChannel, "Who's That Pokémon has been stopped.");
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

            setTimeout(() => {
                startNewRound(replyChannel);
            }, 5000);

            return;
        }

        if (msg === "!wtprefresh") {
            if (game.gameActive && game.currentPokemon) {
                io.to(replyChannel).emit("newPokemon", game.currentPokemon);
                client.say(replyChannel, "Overlay refreshed.");
            } else {
            client.say(replyChannel, "There is no active Pokémon round to refresh.");
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
                await awardPoint(replyChannel, username);

                client.say(
                    replyChannel,
                    `🎉 ${username} guessed correctly! 🎉 • It was ${game.currentPokemon.displayName}! • 📖 Pokédex entry: ${game.currentPokemon.pokedexEntry} • ⌛ Next Pokémon in 5 seconds...`
                );

                io.to(replyChannel).emit("revealPokemon", {
                    ...game.currentPokemon,
                    winner: username
                });

                game.gameActive = false;

                setTimeout(() => {
                    startNewRound(replyChannel);
                }, 5000);

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
                await client.part(channel);
                joinedChannels.delete(channel);
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

startBot();