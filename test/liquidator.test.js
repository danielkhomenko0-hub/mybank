// Бот-ликвидатор на настоящем контракте
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { setup, send, near, usd, eth, wad } = require("./helpers");
const { createBot } = require("../scripts/liquidator.js");

test("бот находит заёмщика, ждёт и ликвидирует его только после падения цены", async () => {
  const { alice, bob, carol, usdc, weth, pool, oracle } = await setup();
  const U = await usdc.getAddress();
  const W = await weth.getAddress();
  await send(pool.connect(alice).deposit(U, usd(10_000)));
  await send(pool.connect(bob).deposit(W, eth(1)));
  await send(pool.connect(bob).borrow(U, usd(1_500)));

  const abis = Object.fromEntries(
    ["LendingPool", "TestToken"].map((n) => [n, require(path.join(__dirname, "..", "build", `${n}.json`)).abi])
  );
  const deployment = {
    pool: await pool.getAddress(),
    oracle: await oracle.getAddress(),
    deployBlock: 0,
    assets: [
      { symbol: "USDC", address: U, decimals: 6 },
      { symbol: "WETH", address: W, decimals: 18 },
    ],
  };
  const logs = [];
  const bot = createBot({ signer: carol, deployment, abis, log: (m) => logs.push(m), chunk: 3 });

  assert.deepEqual(await bot.tick(), []); // все здоровы
  assert.ok(bot.borrowers.has(bob.address), "бот нашёл Боба по событию Borrow");

  await send(oracle.setPrice(W, wad(1_800)));
  const done = await bot.tick();
  assert.equal(done.length, 1);
  // Между блоками могут пройти секунды, и на долг набегают копеечные проценты — сравниваем с допуском
  near(done[0].repaid, usd(750), usd(0.01), "погашено");
  near(done[0].seized, eth(0.4375), eth(0.00001), "изъято");
  near((await pool.accountData(bob.address)).healthFactor, wad(1.08), wad(0.00001), "HF после");
  assert.deepEqual(await bot.tick(), []); // счёт снова здоров
  assert.ok(logs.some((l) => l.includes("✓")));
});
