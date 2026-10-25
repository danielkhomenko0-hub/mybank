// Проверяем, что интерфейс считает так же, как контракт.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { ethers } = require("ethers");
const { setup, send, deploy } = require("./helpers");

const Sim = require("../frontend/sim-engine.js");
const { ChainBank, deployBank } = require("../frontend/chain-engine.js");
const { SimBank, YEAR } = Sim;

const close = (a, b, eps, label) => assert.ok(Math.abs(a - b) <= eps, `${label}: ожидалось ≈${b}, получено ${a}`);

function emptySim() {
  const sim = new SimBank({ seed: false });
  sim._addUser("alice", "Алиса", { USDC: 100_000, WETH: 10 });
  sim._addUser("bob", "Боб", { USDC: 100_000, WETH: 10 });
  sim._addUser("carol", "Кэрол", { USDC: 100_000, WETH: 10 });
  return sim;
}

test("симулятор: проценты за год совпадают с контрактом", () => {
  const sim = emptySim();
  sim.deposit("alice", "USDC", 10_000);
  sim.deposit("bob", "WETH", 5);
  sim.borrow("bob", "USDC", 5_000);
  close(sim.borrowRate("USDC"), 0.025, 1e-12, "ставка по кредиту");
  close(sim.supplyRate("USDC"), 0.01125, 1e-12, "ставка по вкладу");

  sim.timeTravel(YEAR, 1); // одно начисление, как в контракте
  close(sim.borrowBalance("USDC", "bob"), 5_125, 1e-6, "долг Боба");
  close(sim.depositBalance("USDC", "alice"), 10_112.5, 1e-6, "вклад Алисы");
  close(sim.markets.USDC.reserves, 12.5, 1e-6, "резервы");
});

test("симулятор: ликвидация совпадает с контрактом", () => {
  const sim = emptySim();
  sim.deposit("alice", "USDC", 10_000);
  sim.deposit("bob", "WETH", 1);
  sim.borrow("bob", "USDC", 1_500);
  sim.setPrice("WETH", 1_800);
  close(sim.accountData("bob").healthFactor, 0.96, 1e-12, "HF до");

  const r = sim.liquidate("carol", "bob", "USDC", "WETH", 1_000);
  close(r.repaid, 750, 1e-9, "погашено");
  close(r.seized, 0.4375, 1e-12, "изъято залога");
  close(r.profit, 37.5, 1e-9, "прибыль ликвидатора");
  close(sim.accountData("bob").healthFactor, 1.08, 1e-12, "HF после");
});

test("симулятор: неудачная операция откатывается целиком", () => {
  const sim = emptySim();
  sim.deposit("alice", "USDC", 10_000);
  sim.deposit("bob", "WETH", 1);
  const before = JSON.stringify(sim.getState("bob"));
  assert.throws(() => sim.borrow("bob", "USDC", 1_600), (e) => e.code === "InsufficientCollateral");
  assert.equal(JSON.stringify(sim.getState("bob")), before);
});

test("симулятор: бот ликвидирует только нездоровые счета", () => {
  const sim = new SimBank(); // с начальными клиентами
  sim.deposit("you", "WETH", 1);
  sim.borrow("you", "USDC", 1_500);
  assert.equal(sim.runLiquidator().length, 0);
  sim.setPrice("WETH", 1_800); // HF 0.96: одна ликвидация возвращает счёт в норму
  const res = sim.runLiquidator();
  assert.ok(res.some((r) => r.user === "Вы"));
  assert.ok(sim.accountData("you").healthFactor >= 1);
});

test("блокчейн-движок: вклад, кредит, ошибки и погашение через настоящий контракт", async () => {
  const { alice, bob, usdc, weth, pool, oracle } = await setup();
  const abis = Object.fromEntries(
    ["LendingPool", "SimpleOracle", "TestToken"].map((n) => [n, require(path.join(__dirname, "..", "build", `${n}.json`)).abi])
  );
  const deployment = {
    network: "local", chainId: 1337,
    pool: await pool.getAddress(), oracle: await oracle.getAddress(),
    assets: [
      { symbol: "USDC", address: await usdc.getAddress(), decimals: 6 },
      { symbol: "WETH", address: await weth.getAddress(), decimals: 18 },
    ],
  };
  const aliceBank = new ChainBank({ ethers, signer: alice, deployment, abis });
  const bobBank = new ChainBank({ ethers, signer: bob, deployment, abis });

  await aliceBank.deposit("USDC", "10000");
  await bobBank.deposit("WETH", "1");
  await bobBank.borrow("USDC", "1000");

  let s = await bobBank.getState();
  const u = s.markets.find((m) => m.symbol === "USDC");
  const w = s.markets.find((m) => m.symbol === "WETH");
  close(w.deposited, 1, 1e-12, "вклад WETH");
  close(u.borrowed, 1000, 1e-6, "кредит USDC");
  close(s.account.healthFactor, 1.6, 1e-9, "health factor");
  close(u.utilization, 0.1, 1e-12, "загрузка");
  assert.equal(u.ltv, 0.8);
  assert.equal(s.isOwner, false);

  await assert.rejects(bobBank.borrow("USDC", "600"), (e) => e.code === "InsufficientCollateral");
  await assert.rejects(bobBank.borrow("USDC", "abc"), (e) => e.code === "ZeroAmount");

  await bobBank.repay("USDC", "max");
  await bobBank.withdraw("WETH", "max");
  s = await bobBank.getState();
  assert.equal(s.markets.find((m) => m.symbol === "USDC").borrowed, 0);
  assert.equal(s.markets.find((m) => m.symbol === "WETH").deposited, 0);
  assert.equal(s.account.healthFactor, Infinity);
  assert.ok(bobBank.log.length >= 4);

  await bobBank.faucet("WETH");
  close((await bobBank.getState()).markets.find((m) => m.symbol === "WETH").wallet, 15, 1e-12, "кран WETH");
});

test("блокчейн-движок: USDT требует обнулить разрешение — движок делает это сам", async () => {
  const { owner, alice, pool, oracle, usdc, weth } = await setup();
  const usdt = await deploy(owner, "TetherLikeToken", "Test Tether", "USDT", 6);
  const T = await usdt.getAddress();
  await send(oracle.setPrice(T, ethers.parseUnits("1", 18)));
  await send(pool.listMarket(T, 7500, 8000, 500, 1000, {
    baseRate: 0n, slope1: ethers.parseUnits("0.04", 18), slope2: ethers.parseUnits("0.75", 18), kink: ethers.parseUnits("0.8", 18),
  }));
  const abis = Object.fromEntries(
    ["LendingPool", "SimpleOracle", "TestToken"].map((n) => [n, require(path.join(__dirname, "..", "build", `${n}.json`)).abi])
  );
  const deployment = {
    network: "local", chainId: 1337, pool: await pool.getAddress(), oracle: await oracle.getAddress(),
    assets: [
      { symbol: "USDC", address: await usdc.getAddress(), decimals: 6 },
      { symbol: "USDT", address: T, decimals: 6 },
      { symbol: "WETH", address: await weth.getAddress(), decimals: 18 },
    ],
  };
  const bank = new ChainBank({ ethers, signer: alice, deployment, abis });
  await bank.faucet("USDT");
  // Остаётся маленькое ненулевое разрешение — у настоящего USDT это ломает повторный approve
  await send(usdt.connect(alice).approve(await pool.getAddress(), 1n));
  await bank.deposit("USDT", "500");
  const s = await bank.getState();
  close(s.markets.find((m) => m.symbol === "USDT").deposited, 500, 1e-9, "вклад USDT");
  assert.ok(bank.log.some((e) => e.text.includes("Сброс разрешения USDT")));
});

test("деплой со страницы: deployBank разворачивает банк, и он сразу работает", async () => {
  const { owner, alice } = await setup();
  const artifacts = Object.fromEntries(
    ["LendingPool", "SimpleOracle", "TestToken", "TetherLikeToken"].map((n) => [n, require(path.join(__dirname, "..", "build", `${n}.json`))])
  );
  const steps = [];
  const dep = await deployBank({ ethers, signer: owner, artifacts, onStep: (t, d, n) => steps.push([t, d, n]) });
  assert.deepEqual(dep.assets.map((a) => a.symbol), ["USDC", "USDT", "WETH"]);
  assert.equal(steps.at(-1)[1], 11);
  assert.equal(dep.owner, await owner.getAddress());

  const abis = Object.fromEntries(Object.entries(artifacts).map(([k, v]) => [k, v.abi]));
  const bank = new ChainBank({ ethers, signer: alice, deployment: dep, abis });
  await bank.faucet("WETH");
  await bank.faucet("USDC");
  await bank.deposit("USDC", "5000");
  await bank.deposit("WETH", "1");
  await bank.borrow("USDC", "1000");
  const s = await bank.getState();
  const u = s.markets.find((m) => m.symbol === "USDC");
  close(u.borrowed, 1000, 1e-6, "кредит");
  assert.equal(s.markets.find((m) => m.symbol === "USDT").ltv, 0.75);
  assert.equal(s.markets.find((m) => m.symbol === "WETH").price, 2000);
});
