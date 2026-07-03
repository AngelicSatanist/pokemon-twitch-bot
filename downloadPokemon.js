const fs = require("fs");
const path = require("path");
const axios = require("axios");

const artworkFolder = path.join(__dirname, "images", "artwork");
const dataFolder = path.join(__dirname, "data");

fs.mkdirSync(artworkFolder, { recursive: true });
fs.mkdirSync(dataFolder, { recursive: true });

const TOTAL_POKEMON = 1025;

async function downloadImage(url, filepath) {
    const response = await axios({
        url,
        method: "GET",
        responseType: "stream"
    });

    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(filepath);
        response.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
    });
}

async function main() {
    const pokemonList = [];

    for (let id = 1; id <= TOTAL_POKEMON; id++) {
        const paddedId = String(id).padStart(4, "0");

        const apiUrl = `https://pokeapi.co/api/v2/pokemon/${id}`;
        const imageUrl = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/home/${id}.png`;

        console.log(`Downloading #${paddedId}...`);

        const response = await axios.get(apiUrl);
        const pokemon = response.data;

        pokemonList.push({
            id,
            number: paddedId,
            name: pokemon.name,
            displayName: pokemon.name.charAt(0).toUpperCase() + pokemon.name.slice(1),
            image: `/artwork/${paddedId}.png`
        });

        const imagePath = path.join(artworkFolder, `${paddedId}.png`);

        if (!fs.existsSync(imagePath)) {
            await downloadImage(imageUrl, imagePath);
        }
    }

    fs.writeFileSync(
        path.join(dataFolder, "pokemon.json"),
        JSON.stringify(pokemonList, null, 2)
    );

    console.log("Done! Pokémon data and artwork downloaded.");
}

main();