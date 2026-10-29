// Бот-ликвидатор: следит за всеми заёмщиками банка и ликвидирует счета с health factor < 1.
//
//   RPC_URL=https://...  PRIVATE_KEY=0x...  NETWORK=sepolia  npm run liquidator
//
// Переменные: INTERVAL — пауза между проверками в секундах (по умолчанию 30),
//             ONCE=1 — проверить один раз и выйти,
//             AUTO_MINT=0 — не печатать себе тестовые токены, если не хватает на погашение.
// Ключ — только от отдельного тестового кошелька!
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WAD = 10n ** 18n;
const FULL_LIQUIDATION_HF = (95n * WAD) / 100n;
const ORACLE_ABI = ["function getPrice(address) view returns (uint256)"];

/**
 * Создаёт бота. Вынесено в функцию, чтобы его можно было проверить в тестах.
 * @returns {{ tick: () => Promise<object[]>, borrowers: Set<string> }}
 */
function createBot({ signer, deployment, abis, log = console.log, autoMint = true, chunk = 5000 }) {
  const pool = new ethers.Contract(deployment.pool, abis.LendingPool, signer);
  const oracle = new ethers.Contract(deployment.oracle, ORACLE_ABI, signer);
  const assets = deployment.assets.map((a) => ({ ...a, token: new ethers.Contract(a.address, abis.TestToken, signer) }));
  const borrowers = new Set();
  let nextBlock = deployment.deployBlock ?? 0;

  // Собираем всех, кто когда-либо брал кредит (по событиям Borrow)
  async function scan() {
    const latest = await signer.provider.getBlockNumber();
    while (nextBlock <= latest) {
      const to = Math.min(latest, nextBlock + chunk - 1);
      const events = await pool.queryFilter(pool.filters.Borrow(), nextBlock, to);
      for (const e of events) borrowers.add(e.args.user);
      nextBlock = to + 1;
    }
  }

  async function ensureFunds(asset, amount, me) {
    const bal = await asset.token.balanceOf(me);
    if (bal < amount) {
      if (!autoMint) throw new Error(`не хватает ${asset.symbol} для погашения`);
      await (await asset.token.mint(me, amount - bal)).wait();
    }
    const allowance = await asset.token.allowance(me, deployment.pool);
    if (allowance < amount) {
      if (allowance > 0n) await (await asset.token.approve(deployment.pool, 0n)).wait(); // правило USDT
      await (await asset.token.approve(deployment.pool, ethers.MaxUint256)).wait();
    }
  }

  async function tick() {
    await scan();
    const me = await signer.getAddress();
    const results = [];
    for (const borrower of borrowers) {
      const acc = await pool.accountData(borrower);
      if (acc.debtValue === 0n || acc.healthFactor >= WAD) continue;

      // Гасим самый крупный долг и забираем самый крупный залог
      let debt = null;
      let coll = null;
      for (const a of assets) {
        const [price, d, c] = await Promise.all([
          oracle.getPrice(a.address),
          pool.borrowBalance(a.address, borrower),
          pool.depositBalance(a.address, borrower),
        ]);
        const unit = 10n ** BigInt(a.decimals);
        const dv = (d * price) / unit;
        const cv = (c * price) / unit;
        if (d > 0n && (!debt || dv > debt.value)) debt = { a, amount: d, value: dv };
        if (c > 0n && (!coll || cv > coll.value)) coll = { a, value: cv };
      }
      if (!debt || !coll) continue;

      // Как в контракте: 50% долга, а если HF ниже 0.95 — весь долг
      const repay = acc.healthFactor < FULL_LIQUIDATION_HF ? debt.amount : debt.amount / 2n;
      const hf = Number(ethers.formatUnits(acc.healthFactor, 18)).toFixed(3);
      log(`Счёт ${borrower} под угрозой (HF ${hf}): гашу ${ethers.formatUnits(repay, debt.a.decimals)} ${debt.a.symbol}`);
      try {
        await ensureFunds(debt.a, repay, me);
        const receipt = await (await pool.liquidate(borrower, debt.a.address, coll.a.address, repay)).wait();
        const ev = receipt.logs.map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
          .find((e) => e && e.name === "Liquidate");
        const r = {
          borrower,
          debtSymbol: debt.a.symbol,
          collateralSymbol: coll.a.symbol,
          repaid: ev.args.repaid,
          seized: ev.args.seized,
          healthBefore: Number(hf),
        };
        log(`  ✓ погашено ${ethers.formatUnits(r.repaid, debt.a.decimals)} ${debt.a.symbol}, ` +
            `получено ${ethers.formatUnits(r.seized, coll.a.decimals)} ${coll.a.symbol} залога (блок ${receipt.blockNumber})`);
        results.push(r);
      } catch (e) {
        log(`  ✗ не получилось: ${e.shortMessage || e.message}`);
      }
    }
    return results;
  }

  return { tick, borrowers };
}

async function main() {
  const { RPC_URL, PRIVATE_KEY } = process.env;
  const NETWORK = process.env.NETWORK || "sepolia";
  const INTERVAL = Number(process.env.INTERVAL || 30);
  if (!RPC_URL || !PRIVATE_KEY) {
    console.error("Нужны RPC_URL и PRIVATE_KEY (ключ отдельного тестового кошелька).");
    process.exit(1);
  }
  const root = path.join(__dirname, "..");
  const deployment = JSON.parse(fs.readFileSync(path.join(root, "deployments", `${NETWORK}.json`), "utf8"));
  const abis = Object.fromEntries(
    ["LendingPool", "TestToken"].map((n) => [n, JSON.parse(fs.readFileSync(path.join(root, "build", `${n}.json`))).abi])
  );
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  if ((await provider.getNetwork()).chainId === 1n) throw new Error("Это mainnet — бот только для тестовых сетей.");
  const signer = new ethers.NonceManager(new ethers.Wallet(PRIVATE_KEY, provider));
  const bot = createBot({ signer, deployment, abis, autoMint: process.env.AUTO_MINT !== "0" });

  const stamp = () => new Date().toLocaleTimeString("ru-RU");
  console.log(`[${stamp()}] Бот-ликвидатор следит за банком в сети ${NETWORK}, пул ${deployment.pool}`);
  for (;;) {
    try {
      const done = await bot.tick();
      console.log(`[${stamp()}] Заёмщиков: ${bot.borrowers.size}, ликвидаций за проход: ${done.length}`);
    } catch (e) {
      console.error(`[${stamp()}] Ошибка проверки: ${e.shortMessage || e.message}`);
    }
    if (process.env.ONCE === "1") break;
    await new Promise((r) => setTimeout(r, INTERVAL * 1000));
  }
}

module.exports = { createBot };
if (require.main === module) main();
