const fs = require("fs");

const pokemon = require("./data/pokemon.json");

function getGeneration(id) {
    if (id <= 151) return 1;
    if (id <= 251) return 2;
    if (id <= 386) return 3;
    if (id <= 493) return 4;
    if (id <= 649) return 5;
    if (id <= 721) return 6;
    if (id <= 809) return 7;
    if (id <= 905) return 8;
    return 9;
}

pokemon.forEach(p => {
    p.generation = getGeneration(p.id);
});

fs.writeFileSync(
    "./data/pokemon.json",
    JSON.stringify(pokemon, null, 4)
);

console.log("Finished!");