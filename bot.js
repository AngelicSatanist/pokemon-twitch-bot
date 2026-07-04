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

function getGame(channel) {
    if (!games[channel]) {
        games[channel] = {
            currentPokemon: null,
            gameActive: false
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
        console.log("Bot connected to:", channels);
    });

    client.on("message", async (channel, tags, message, self) => {
        if (self) return;

        const msg = message.toLowerCase().trim();
        const username = tags["display-name"];
        const replyChannel = channel.replace("#", "").toLowerCase();
        const game = getGame(replyChannel);

        console.log(`Message received in: ${replyChannel}`);

        if (msg === "!wtpstart") {
            if (game.gameActive) {
                client.say(replyChannel, "A Pokémon round is already active! Guess the Pokémon!");
                return;
            }

            startNewRound(replyChannel);
            client.say(replyChannel, "Who's That Pokémon? Guess now in chat!");
            return;
        }

        if (msg === "!wtpstop") {
            game.gameActive = false;
            game.currentPokemon = null;
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

        if (game.gameActive && game.currentPokemon) {
            if (msg === game.currentPokemon.name) {
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

startBot();