// Собирает интерфейс банка в один HTML-файл:
//   dist/index.html    — полноценная страница для запуска с MetaMask (npx serve dist)
//   dist/artifact.html — та же страница без обёртки, для публикации как демо
// Адреса берутся из deployments/*.json, ABI — из build/.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

const abis = {};
for (const n of ["LendingPool", "SimpleOracle", "TestToken"]) {
  abis[n] = JSON.parse(read("build", `${n}.json`)).abi;
}

const depDir = path.join(root, "deployments");
const deployments = fs.existsSync(depDir)
  ? fs.readdirSync(depDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(read("deployments", f)))
  : [];

const template = read("frontend", "index.html");
const engines = read("frontend", "sim-engine.js") + "\n" + read("frontend", "chain-engine.js");
const PLACEHOLDER_CONFIG = "/*__CONFIG__*/ { deployments: [], abis: null }";
if (!template.includes(PLACEHOLDER_CONFIG) || !template.includes("/*__ENGINES__*/")) {
  throw new Error("В frontend/index.html нет меток для сборки");
}

function build(deps) {
  return template
    .replace("/*__ENGINES__*/", () => engines)
    .replace(PLACEHOLDER_CONFIG, () => JSON.stringify({ deployments: deps, abis }));
}

fs.mkdirSync(path.join(root, "dist"), { recursive: true });

// Для локального запуска — все развёртывания, включая localhost
const page =
  '<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n' +
  build(deployments) +
  "\n</body>\n</html>\n";
fs.writeFileSync(path.join(root, "dist", "index.html"), page);

// Для публикации — только публичные сети (localhost никому, кроме вас, недоступен)
const publicDeps = deployments.filter((d) => d.network !== "localhost" && d.chainId !== 1337);
fs.writeFileSync(path.join(root, "dist", "artifact.html"), build(publicDeps));

console.log(`Собрано: dist/index.html (${deployments.length} сетей), dist/artifact.html (${publicDeps.length} сетей)`);
