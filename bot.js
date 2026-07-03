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

const client = new tmi.Client({
    identity: {
        username: process.env.TWITCH_USERNAME,
        password: process.env.TWITCH_OAUTH
    },
    channels: [process.env.TWITCH_CHANNEL]
});

client.connect();

client.on("connected", () => {
    console.log("Bot connected!");
    client.say(process.env.TWITCH_CHANNEL, "Angel's Who's That Pokémon bot is online!");
});

function getRandomPokemon() {
    const randomIndex = Math.floor(Math.random() * pokemonList.length);
    return pokemonList[randomIndex];
}

function startNewRound(channel) {
    currentPokemon = getRandomPokemon();
    io.emit("newPokemon", currentPokemon);
    gameActive = true;

    console.log("New round:", currentPokemon);

    client.say(channel, "Who's That Pokémon? Guess now in chat!");
}

client.on("message", async (channel, tags, message, self) => {
    if (self) return;

    const msg = message.toLowerCase().trim();
    const username = tags["display-name"];

    if (msg === "!pokemon") {
        if (gameActive) {
            client.say(channel, "A Pokémon round is already active! Guess the Pokémon!");
            return;
        }

        startNewRound(channel);
        return;
    }

    if (msg === "!stop") {
        gameActive = false;
        currentPokemon = null;
        io.emit("clearPokemon");
        client.say(channel, "🛑 Who's That Pokémon has been stopped.");
        return;
    }

    if (msg === "!skip") {
        if (!gameActive || !currentPokemon) {
            client.say(channel, "There is no active Pokémon round.");
            return;
        }

        client.say(channel, `⏭️ Skipped! It was ${currentPokemon.displayName}.`);
        io.emit("revealPokemon", currentPokemon);

        gameActive = false;

        setTimeout(() => {
            startNewRound(channel);
        }, 5000);

        return;
    }

    if (gameActive && currentPokemon) {
        if (msg === currentPokemon.name) {
            client.say(channel, `🎉 ${username} got it! It was ${currentPokemon.displayName}!`);
            io.emit("revealPokemon", currentPokemon);

            gameActive = false;

            setTimeout(() => {
                startNewRound(channel);
            }, 5000);

            return;
        }
    }
});