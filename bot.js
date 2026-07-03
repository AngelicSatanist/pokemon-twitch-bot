require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const tmi = require("tmi.js");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const pokemonList = require("./data/pokemon.json");

let currentPokemon = null;
let gameActive = false;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("overlay"));
app.use("/artwork", express.static(path.join(__dirname, "images", "artwork")));

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Overlay running on port ${PORT}`);
});

const channels = (process.env.TWITCH_CHANNELS || process.env.TWITCH_CHANNEL || "")
    .split(",")
    .map(channel => channel.trim().toLowerCase())
    .filter(channel => channel.length > 0);

if (channels.length === 0) {
    console.error("No Twitch channels found. Set TWITCH_CHANNELS in Render Environment.");
    process.exit(1);
}

const client = new tmi.Client({
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

function getRandomPokemon() {
    const randomIndex = Math.floor(Math.random() * pokemonList.length);
    return pokemonList[randomIndex];
}

function startNewRound(replyChannel) {
    currentPokemon = getRandomPokemon();
    io.emit("newPokemon", currentPokemon);
    gameActive = true;

    console.log("New round:", currentPokemon);
}

client.on("message", async (channel, tags, message, self) => {
    if (self) return;

    const msg = message.toLowerCase().trim();
    const username = tags["display-name"];
    const replyChannel = channel.replace("#", "");
        console.log(`Message received in: ${replyChannel}`);

    if (msg === "!wtpstart") {
        if (gameActive) {
            client.say(replyChannel, "A Pokémon round is already active! Guess the Pokémon!");
            return;
        }

        startNewRound(channel);
            client.say(replyChannel,, "Who's That Pokémon? Guess now in chat!");
        return;
    }

    if (msg === "!wtpstop") {
        gameActive = false;
        currentPokemon = null;
        io.emit("clearPokemon");
        client.say(replyChannel, "Who's That Pokémon has been stopped.");
        return;
    }

    if (msg === "!wtpskip") {
        if (!gameActive || !currentPokemon) {
            client.say(replyChannel, "There is no active Pokémon round.");
            return;
        }

        client.say(replyChannel,
        `Pokémon skipped! It was ${currentPokemon.displayName}. The next Pokémon will appear in 5 seconds...`
        );
        io.emit("revealPokemon", {
            ...currentPokemon,
            skipped: true
        });
        gameActive = false;

        setTimeout(() => {
            startNewRound(channel);
        }, 5000);

        return;
    }

    if (gameActive && currentPokemon) {
        if (msg === currentPokemon.name) {
            client.say(replyChannel,
            `${username} guessed correctly! It was ${currentPokemon.displayName}! The next Pokémon will appear in 5 seconds...`
            );
            
            io.emit("revealPokemon", {
                  ...currentPokemon,
                 winner: username
            });

            gameActive = false;

            setTimeout(() => {
                startNewRound(channel);
            }, 5000);

            return;
        }
    }
});