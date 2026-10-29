// Разворачивает весь "банк" в сеть (по умолчанию — тестнет Sepolia).
//
//   RPC_URL=https://...  PRIVATE_KEY=0x...  npm run deploy
//
// ВАЖНО: используй ОТДЕЛЬНЫЙ кошелёк только для тестнета, без реальных денег.
// Никогда не вставляй ключ от основного кошелька и не коммить его в git.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const NETWORK = process.env.NETWORK || "sepolia";

if (!RPC_URL || !PRIVATE_KEY) {
  console.error("Нужны переменные RPC_URL и PRIVATE_KEY (см. README, раздел «Деплой в Sepolia»).");
  process.exit(1);
}

const artifact = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "..", "build", `${name}.json`), "utf8"));
const wad = (n) => ethers.parseUnits(String(n), 18);

// Параметры рынков — те же, что в тестах
const MARKETS = [
  {
    symbol: "USDC", name: "MyBank Test USDC", decimals: 6, price: 1,
    ltvBps: 8000, liqThresholdBps: 8500, liqBonusBps: 500, reserveFactorBps: 1000,
    rate: { baseRate: 0n, slope1: wad(0.04), slope2: wad(0.75), kink: wad(0.8) },
  },
  {
    // Ведёт себя как настоящий USDT (переводы без return), параметры строже, чем у USDC:
    // риск эмитента выше, поэтому под USDT можно занять меньше
    symbol: "USDT", name: "MyBank Test Tether", decimals: 6, price: 1, contract: "TetherLikeToken",
    ltvBps: 7500, liqThresholdBps: 8000, liqBonusBps: 500, reserveFactorBps: 1000,
    rate: { baseRate: 0n, slope1: wad(0.04), slope2: wad(0.75), kink: wad(0.8) },
  },
  {
    symbol: "WETH", name: "MyBank Test WETH", decimals: 18, price: 2000,
    ltvBps: 7500, liqThresholdBps: 8000, liqBonusBps: 500, reserveFactorBps: 1000,
    rate: { baseRate: 0n, slope1: wad(0.04), slope2: wad(3), kink: wad(0.8) },
  },
];

// Фиды Chainlink по сетям (как в frontend/chain-engine.js): в Sepolia цена ETH настоящая
const CHAINLINK = {
  11155111: { WETH: { feed: "0x694AA1769357215DE4FAC081bf1f309aDC325306", maxAge: 3 * 3600 } },
};

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const { chainId } = await provider.getNetwork();
  const balance = await provider.getBalance(wallet.address);
  console.log(`Сеть: ${NETWORK} (chainId ${chainId}), деплоер: ${wallet.address}`);
  console.log(`Баланс: ${ethers.formatEther(balance)} ETH`);
  if (chainId === 1n) throw new Error("Это mainnet! Прототип нельзя разворачивать в основной сети.");
  if (balance === 0n) throw new Error("На кошельке 0 ETH — возьми тестовые ETH в Sepolia faucet.");

  // Ручной счётчик nonce: публичные RPC иногда отдают устаревший nonce между транзакциями
  let nonce = await provider.getTransactionCount(wallet.address, "pending");
  const tx = async (p) => (await p).wait();

  const deploy = async (name, ...args) => {
    const { abi, bytecode } = artifact(name);
    const c = await new ethers.ContractFactory(abi, bytecode, wallet).deploy(...args, { nonce: nonce++ });
    await c.waitForDeployment();
    console.log(`  ${name} → ${await c.getAddress()}`);
    return c;
  };

  const deployBlock = await provider.getBlockNumber(); // с этого блока бот-ликвидатор ищет заёмщиков
  console.log("Разворачиваю контракты…");
  const oracle = await deploy("SimpleOracle");
  const pool = await deploy("LendingPool", await oracle.getAddress());

  const assets = [];
  const feeds = CHAINLINK[Number(chainId)] || {};
  for (const m of MARKETS) {
    const token = await deploy(m.contract || "TestToken", m.name, m.symbol, m.decimals);
    const addr = await token.getAddress();
    await tx(oracle.setPrice(addr, wad(m.price), { nonce: nonce++ }));
    await tx(
      pool.listMarket(addr, m.ltvBps, m.liqThresholdBps, m.liqBonusBps, m.reserveFactorBps, m.rate, {
        nonce: nonce++,
      })
    );
    console.log(`  рынок ${m.symbol} открыт, цена $${m.price}`);
    const f = feeds[m.symbol];
    if (f) {
      await tx(oracle.setFeed(addr, f.feed, f.maxAge, { nonce: nonce++ }));
      console.log(`  цена ${m.symbol} теперь от Chainlink: $${ethers.formatUnits(await oracle.getPrice(addr), 18)}`);
    }
    assets.push({ symbol: m.symbol, address: addr, decimals: m.decimals });
  }

  const out = {
    network: NETWORK,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployBlock,
    owner: wallet.address,
    pool: await pool.getAddress(),
    oracle: await oracle.getAddress(),
    assets,
    ...(Object.keys(feeds).length ? { feeds } : {}),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${NETWORK}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Готово. Адреса сохранены в deployments/${NETWORK}.json`);
}

main().catch((e) => {
  console.error("Ошибка деплоя:", e.shortMessage || e.message);
  process.exit(1);
});
