// Компилирует все контракты из contracts/ в build/<Name>.json (abi + bytecode)
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const dir = path.join(__dirname, "..", "contracts");
const sources = {};
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sol"))) {
  sources[f] = { content: fs.readFileSync(path.join(dir, f), "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
    viaIR: true,
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
for (const e of out.errors || []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);

const buildDir = path.join(__dirname, "..", "build");
fs.mkdirSync(buildDir, { recursive: true });
for (const file of Object.keys(out.contracts)) {
  for (const [name, c] of Object.entries(out.contracts[file])) {
    fs.writeFileSync(
      path.join(buildDir, `${name}.json`),
      JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2)
    );
    console.log("compiled", name);
  }
}
