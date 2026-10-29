// Проверка развёрнутого банка: ничего не отправляет в сеть, ключ не нужен.
//
//   npm run check:sepolia                 (RPC_URL и NETWORK можно переопределить)
//
// Часть 1 читает состояние живых контрактов: владельцы, оракул, рынки, адрес на сайте.
// Часть 2 поднимает локальную копию сети (форк ganache) и прогоняет на настоящих контрактах
// полный сценарий: вклад → кредит → проценты → обвал ETH → бот-ликвидатор → прибыль банка.
// Владелец в копии «разблокирован», поэтому его действия проверяются без его ключа.
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { createBot } = require("./liquidator");

const NETWORK = process.env.NETWORK || "sepolia";
const RPC_URL = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const SITE_URL = process.env.SITE_URL || "https://danielkhomenko0-hub.github.io/mybank/";
const root = path.join(__dirname, "..");
const dep = require(path.join(root, "deployments", `${NETWORK}.json`));
const abi = (name) => require(path.join(root, "build", `${name}.json`)).abi;

const WAD = 10n ** 18n;
const sym = Object.fromEntries(dep.assets.map((a) => [a.symbol, a]));
const fmt = (v, d) => Number(ethers.formatUnits(v, d)).toLocaleString("en-US", { maximumFractionDigits: 4 });
const hf = (v) => (v === ethers.MaxUint256 ? "∞" : Number(ethers.formatUnits(v, 18)).toFixed(3));
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
let failures = 0;
const check = (ok, text) => {
  console.log(`${ok ? "  ✅" : "  ❌"} ${text}`);
  if (!ok) failures++;
};

async function readLive() {
  console.log(`Часть 1. Живой банк в сети ${NETWORK} (только чтение)`);
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const pool = new ethers.Contract(dep.pool, abi("LendingPool"), provider);
  const oracle = new ethers.Contract(dep.oracle, abi("SimpleOracle"), provider);
  check(same(await pool.owner(), dep.owner), "владелец пула совпадает с deployments");
  check(same(await oracle.owner(), dep.owner), "владелец оракула совпадает с deployments");
  check(same(await pool.oracle(), dep.oracle), "пул смотрит в правильный оракул");
  check(Number(await pool.marketCount()) === dep.assets.length, `рынков открыто: ${await pool.marketCount()}`);
  if (dep.feeds) {
    check((await pool.paused()) === false, "банк не на паузе");
    for (const [symbol, f] of Object.entries(dep.feeds)) {
      const feed = new ethers.Contract(f.feed, ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"], provider);
      const [[, answer, , updatedAt], dec] = await Promise.all([feed.latestRoundData(), feed.decimals()]);
      const onFeed = await oracle.usesFeed(sym[symbol].address);
      const ageMin = Math.round((Date.now() / 1000 - Number(updatedAt)) / 60);
      check(onFeed, `${symbol}: цена от Chainlink ($${fmt(answer, Number(dec))}, обновлена ${ageMin} мин назад)${onFeed ? "" : " — сейчас стоит ручная цена"}`);
    }
  }
  for (const a of dep.assets) {
    const m = await pool.markets(a.address);
    const price = await oracle.getPrice(a.address);
    check(
      m.listed,
      `${a.symbol}: цена $${fmt(price, 18)}, LTV ${Number(m.ltvBps) / 100}%, порог ${Number(m.liqThresholdBps) / 100}%, ` +
        `бонус ${Number(m.liqBonusBps) / 100}%, доля банка ${Number(m.reserveFactorBps) / 100}%, вкладов ${fmt(m.totalDeposits, a.decimals)}`
    );
  }
  try {
    const html = await (await fetch(SITE_URL)).text();
    check(html.includes(dep.pool), "сайт знает адрес пула");
  } catch (e) {
    check(false, `сайт не открылся: ${e.message}`);
  }
}

async function forkScenario() {
  console.log("\nЧасть 2. Сценарий на локальной копии сети (настоящие контракты, ненастоящие транзакции)");
  const chain = ganache.provider({
    logging: { quiet: true },
    fork: { url: RPC_URL },
    wallet: { totalAccounts: 3, defaultBalance: 100, unlockedAccounts: [dep.owner] },
  });
  // Тот же приём, что в test/helpers.js: запас газа и данные отката в error.data
  const call = async (args) => {
    try {
      return await chain.request(args);
    } catch (e) {
      if (e?.data?.result) {
        const err = new Error(e.message);
        err.code = e.code ?? -32000;
        err.data = e.data.result;
        throw err;
      }
      throw e;
    }
  };
  const provider = new ethers.BrowserProvider({
    request: async (args) => {
      if (args.method === "eth_estimateGas") {
        await call(args);
        return "0x" + (3_000_000).toString(16);
      }
      return call(args);
    },
  });
  await call({ method: "evm_setAccountBalance", params: [dep.owner, "0x" + (10n * WAD).toString(16)] });
  const [alice, bob, carol] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const owner = await provider.getSigner(dep.owner);
  // Публичные RPC не отдают старые события, поэтому бот ищет заёмщиков с начала копии
  const forkBlock = await provider.getBlockNumber();
  const send = async (tx) => (await tx).wait();
  const pool = (s) => new ethers.Contract(dep.pool, abi("LendingPool"), s);
  const token = (s, symbol) =>
    new ethers.Contract(sym[symbol].address, abi(symbol === "USDT" ? "TetherLikeToken" : "TestToken"), s);
  const oracle = new ethers.Contract(dep.oracle, abi("SimpleOracle"), owner);
  const U = (n) => ethers.parseUnits(String(n), 6);
  const E = (n) => ethers.parseUnits(String(n), 18);

  // Алиса — вкладчик
  await send(token(alice, "USDC").mint(alice.address, U(10_000)));
  await send(token(alice, "USDC").approve(dep.pool, U(10_000)));
  await send(pool(alice).deposit(sym.USDC.address, U(10_000)));
  check((await pool(alice).depositBalance(sym.USDC.address, alice.address)) === U(10_000), "Алиса положила 10 000 USDC");

  // Боб — заёмщик: 1 WETH в залог, кредит на 95% лимита
  const ethPrice = await oracle.getPrice(sym.WETH.address);
  await send(token(bob, "WETH").mint(bob.address, E(1)));
  await send(token(bob, "WETH").approve(dep.pool, E(1)));
  await send(pool(bob).deposit(sym.WETH.address, E(1)));
  let acc = await pool(bob).accountData(bob.address);
  const limitUsd = Number(ethers.formatUnits(acc.borrowLimit, 18));
  const loan = Math.floor(limitUsd * 0.95);
  await send(pool(bob).borrow(sym.USDC.address, U(loan)));
  acc = await pool(bob).accountData(bob.address);
  check(acc.healthFactor > WAD, `Боб занял ${loan} USDC под 1 WETH ($${fmt(ethPrice, 18)}), HF ${hf(acc.healthFactor)}`);

  const feed = dep.feeds?.WETH;
  if (feed) {
    // Ручная цена отключает фид, setFeed возвращает его
    await send(oracle.setPrice(sym.WETH.address, ethPrice));
    const manual = !(await oracle.usesFeed(sym.WETH.address));
    await send(oracle.setFeed(sym.WETH.address, feed.feed, feed.maxAge));
    check(manual && (await oracle.usesFeed(sym.WETH.address)), "владелец переключает цену ETH: вручную ↔ Chainlink");
  }

  let refused = false;
  try {
    await send(pool(bob).borrow(sym.USDC.address, U(Math.ceil(limitUsd * 0.1))));
  } catch {
    refused = true;
  }
  check(refused, "занять сверх лимита не даёт");

  await call({ method: "evm_increaseTime", params: [365 * 24 * 3600] });
  await call({ method: "evm_mine", params: [] });
  if (feed) {
    // Через год фид в копии не обновлялся — цена устарела, и банк её не принимает
    let stale = false;
    try { await oracle.getPrice(sym.WETH.address); } catch (e) { stale = /StalePrice|0x19abf40e/.test(e.data || e.message); }
    check(stale, "устаревшая цена Chainlink блокируется (StalePrice)");
    await send(oracle.setPrice(sym.WETH.address, ethPrice)); // выход владельца из такой ситуации — ручная цена
  }
  await send(pool(alice).accrueInterest(sym.USDC.address));
  const aliceNow = await pool(alice).depositBalance(sym.USDC.address, alice.address);
  check(aliceNow > U(10_000), `через год у Алисы ${fmt(aliceNow, 6)} USDC`);

  const bot = createBot({
    signer: new ethers.NonceManager(carol),
    deployment: { ...dep, deployBlock: forkBlock },
    abis: { LendingPool: abi("LendingPool"), TestToken: abi("TestToken") },
    log: () => {},
  });
  check((await bot.tick()).length === 0, "здоровый счёт бот не трогает");

  // Владелец обваливает ETH на 20%: счёт нездоров, но залог ещё больше долга.
  // При 30% долг превысил бы залог — это плохой долг, его съели бы резервы (проверяется в тестах)
  const crashed = (ethPrice * 80n) / 100n;
  await send(oracle.setPrice(sym.WETH.address, crashed));
  acc = await pool(bob).accountData(bob.address);
  check(acc.healthFactor < WAD, `ETH упал до $${fmt(crashed, 18)}, HF Боба ${hf(acc.healthFactor)}`);

  const wethBefore = await token(carol, "WETH").balanceOf(carol.address);
  const done = await bot.tick();
  const got = (await token(carol, "WETH").balanceOf(carol.address)) - wethBefore;
  acc = await pool(bob).accountData(bob.address);
  check(done.length === 1 && got > 0n, `бот ликвидировал Боба и забрал ${fmt(got, 18)} WETH (долг Боба теперь $${fmt(acc.debtValue, 18)})`);

  const m = await pool(owner).markets(sym.USDC.address);
  await send(pool(owner).withdrawReserves(sym.USDC.address, m.reserves, dep.owner));
  check(m.reserves > 0n, `владелец вывел прибыль банка: ${fmt(m.reserves, 6)} USDC`);

  let blocked = 0;
  try { await send(oracle.connect(alice).setPrice(sym.WETH.address, 1n)); } catch { blocked++; }
  try { await send(pool(alice).withdrawReserves(sym.USDC.address, 1n, alice.address)); } catch { blocked++; }
  check(blocked === 2, "посторонний не может менять цену и выводить резервы");

  // USDT: смена разрешения без обнуления запрещена, вклад проходит
  await send(token(alice, "USDT").mint(alice.address, U(1000)));
  await send(token(alice, "USDT").approve(dep.pool, U(500)));
  let usdtRule = false;
  try { await send(token(alice, "USDT").approve(dep.pool, U(1000))); } catch { usdtRule = true; }
  await send(pool(alice).deposit(sym.USDT.address, U(500)));
  check(
    usdtRule && (await pool(alice).depositBalance(sym.USDT.address, alice.address)) === U(500),
    "USDT ведёт себя как настоящий, вклад проходит"
  );

  if (dep.feeds) {
    await send(pool(owner).setPaused(true));
    let stopped = false;
    try { await send(pool(alice).deposit(sym.USDT.address, U(1))); } catch { stopped = true; }
    await send(pool(owner).setPaused(false));
    check(stopped, "пауза останавливает вклады, после снятия всё работает");
  }

  const usdc = await pool(alice).markets(sym.USDC.address);
  const cash = usdc.totalDeposits + usdc.reserves - usdc.totalBorrows;
  const take = aliceNow < cash ? aliceNow : cash;
  await send(pool(alice).withdraw(sym.USDC.address, take));
  check((await token(alice, "USDC").balanceOf(alice.address)) === take, `Алиса забрала ${fmt(take, 6)} USDC`);
}

(async () => {
  await readLive();
  await forkScenario();
  console.log(failures ? `\nПровалено проверок: ${failures}` : "\nВсе проверки прошли.");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  // Называем ошибку контракта по имени, если её можно расшифровать
  let name = "";
  const data = e.data || e.info?.error?.data;
  for (const c of ["LendingPool", "SimpleOracle"]) {
    if (name || typeof data !== "string" || data.length < 10) break;
    try { name = new ethers.Interface(abi(c)).parseError(data)?.name || ""; } catch {}
  }
  console.error("Ошибка проверки:", name || e.shortMessage || e.message);
  if (e.stack) console.error(e.stack.split("\n").find((l) => l.includes("check-sepolia")) || "");
  process.exit(2);
});
