const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { setup, deploy, send, expectRevert, near, usd, eth, wad, YEAR } = require("./helpers");

test("вклад и снятие: деньги возвращаются полностью", async () => {
  const { alice, usdc, pool } = await setup();
  const U = await usdc.getAddress();

  await send(pool.connect(alice).deposit(U, usd(10_000)));
  assert.equal(await pool.depositBalance(U, alice.address), usd(10_000));

  await send(pool.connect(alice).withdraw(U, ethers.MaxUint256));
  assert.equal(await pool.depositBalance(U, alice.address), 0n);
  assert.equal(await usdc.balanceOf(alice.address), usd(100_000));
});

test("кредит выдаётся только в пределах LTV залога", async () => {
  const { alice, bob, usdc, weth, pool } = await setup();
  const U = await usdc.getAddress();
  const W = await weth.getAddress();

  await send(pool.connect(alice).deposit(U, usd(10_000)));
  await send(pool.connect(bob).deposit(W, eth(1))); // $2000 залога, LTV 75% => лимит $1500

  await expectRevert(pool.connect(bob).borrow(U, usd(1_600)), "InsufficientCollateral");
  await send(pool.connect(bob).borrow(U, usd(1_500)));
  assert.equal(await pool.borrowBalance(U, bob.address), usd(1_500));

  const acc = await pool.accountData(bob.address);
  assert.equal(acc.borrowLimit, wad(1_500));
  assert.equal(acc.debtValue, wad(1_500));
});

test("нельзя занять больше, чем есть свободных денег в пуле", async () => {
  const { alice, bob, usdc, weth, pool } = await setup();
  const U = await usdc.getAddress();
  const W = await weth.getAddress();

  await send(pool.connect(alice).deposit(U, usd(1_000)));
  await send(pool.connect(bob).deposit(W, eth(10)));
  await expectRevert(pool.connect(bob).borrow(U, usd(1_001)), "InsufficientLiquidity");
});

test("проценты: заёмщик платит, вкладчик получает, банк берёт 10%", async () => {
  const { alice, bob, usdc, weth, pool, timeTravel } = await setup();
  const U = await usdc.getAddress();
  const W = await weth.getAddress();

  await send(pool.connect(alice).deposit(U, usd(10_000)));
  await send(pool.connect(bob).deposit(W, eth(5)));
  await send(pool.connect(bob).borrow(U, usd(5_000)));

  // Загрузка 50% => ставка по кредиту 4% * 0.5/0.8 = 2.5%, по вкладу 2.5% * 0.5 * 0.9 = 1.125%
  assert.equal(await pool.utilization(U), wad(0.5));
  assert.equal(await pool.borrowRate(U), wad(0.025));
  assert.equal(await pool.supplyRate(U), wad(0.01125));

  await timeTravel(YEAR);
  await send(pool.accrueInterest(U));

  near(await pool.borrowBalance(U, bob.address), usd(5_125), usd(0.01), "долг Боба");
  near(await pool.depositBalance(U, alice.address), usd(10_112.5), usd(0.01), "вклад Алисы");
  const m = await pool.markets(U);
  near(m.reserves, usd(12.5), usd(0.01), "резервы банка");
});

test("ставка резко растёт, когда загрузка выше 80% (kink)", async () => {
  const { alice, bob, usdc, weth, pool } = await setup();
  const U = await usdc.getAddress();
  const W = await weth.getAddress();

  await send(pool.connect(alice).deposit(U, usd(10_000)));
  await send(pool.connect(bob).deposit(W, eth(10)));
  await send(pool.connect(bob).borrow(U, usd(9_000)));

  // 4% + 75% * (0.9 - 0.8) / 0.2 = 41.5%
  assert.equal(await pool.utilization(U), wad(0.9));
  assert.equal(await pool.borrowRate(U), wad(0.415));
});

test("нельзя вывести залог, если после этого счёт уйдёт под ликвидацию", async () => {
  const { alice, bob, usdc, weth, pool } = await setup();
  const U = await usdc.getAddress();
  const W = await weth.getAddress();

  await send(pool.connect(alice).deposit(U, usd(10_000)));
  await send(pool.connect(bob).deposit(W, eth(1)));
  await send(pool.connect(bob).borrow(U, usd(1_500)));

  await expectRevert(pool.connect(bob).withdraw(W, eth(0.1)), "InsufficientCollateral");
});

test("здоровый счёт ликвидировать нельзя", async () => {
  const { alice, bob, carol, usdc, weth, pool } = await setup();
  const U = await usdc.getAddress();
  const W = await weth.getAddress();

  await send(pool.connect(alice).deposit(U, usd(10_000)));
  await send(pool.connect(bob).deposit(W, eth(1)));
  await send(pool.connect(bob).borrow(U, usd(1_000)));

  await expectRevert(pool.connect(carol).liquidate(bob.address, U, W, usd(500)), "AccountHealthy");
});

test("ликвидация после падения цены: 50% долга, ликвидатор получает бонус 5%", async () => {
  const { alice, bob, carol, usdc, weth, pool, oracle } = await setup();
  const U = await usdc.getAddress();
  const W = await weth.getAddress();

  await send(pool.connect(alice).deposit(U, usd(10_000)));
  await send(pool.connect(bob).deposit(W, eth(1)));
  await send(pool.connect(bob).borrow(U, usd(1_500)));

  // ETH падает до $1800: порог 1800 * 80% = $1440 < долг $1500 => HF = 0.96
  await send(oracle.setPrice(W, wad(1_800)));
  assert.equal((await pool.accountData(bob.address)).healthFactor, wad(0.96));

  const usdcBefore = await usdc.balanceOf(carol.address);
  const wethBefore = await weth.balanceOf(carol.address);

  // Кэрол пытается погасить $1000, но close factor ограничивает до 50% = $750
  await send(pool.connect(carol).liquidate(bob.address, U, W, usd(1_000)));

  assert.equal(usdcBefore - (await usdc.balanceOf(carol.address)), usd(750));
  // $750 * 1.05 / $1800 = 0.4375 ETH (стоит $787.50 — прибыль ликвидатора $37.50)
  assert.equal((await weth.balanceOf(carol.address)) - wethBefore, eth(0.4375));

  assert.equal(await pool.borrowBalance(U, bob.address), usd(750));
  assert.equal(await pool.depositBalance(W, bob.address), eth(0.5625));
  // После ликвидации счёт снова здоров: 0.5625 * 1800 * 0.8 / 750 = 1.08
  assert.equal((await pool.accountData(bob.address)).healthFactor, wad(1.08));
});

test("ликвидация при глубоком падении: залог единственного вкладчика WETH можно забрать больше половины", async () => {
  const { alice, bob, carol, usdc, weth, pool, oracle } = await setup();
  const U = await usdc.getAddress();
  const W = await weth.getAddress();

  await send(pool.connect(alice).deposit(U, usd(10_000)));
  await send(pool.connect(bob).deposit(W, eth(1))); // в рынке WETH только залог Боба
  await send(pool.connect(bob).borrow(U, usd(1_500)));

  // ETH падает до $1400: ликвидатор гасит $750 и забирает 750 * 1.05 / 1400 = 0.5625 ETH — больше половины рынка
  await send(oracle.setPrice(W, wad(1_400)));
  const wethBefore = await weth.balanceOf(carol.address);
  await send(pool.connect(carol).liquidate(bob.address, U, W, usd(750)));

  assert.equal((await weth.balanceOf(carol.address)) - wethBefore, eth(0.5625));
  assert.equal(await pool.depositBalance(W, bob.address), eth(0.4375));
  assert.equal(await pool.borrowBalance(U, bob.address), usd(750));
});

test("полное погашение долга освобождает весь залог", async () => {
  const { alice, bob, usdc, weth, pool, timeTravel } = await setup();
  const U = await usdc.getAddress();
  const W = await weth.getAddress();

  await send(pool.connect(alice).deposit(U, usd(10_000)));
  await send(pool.connect(bob).deposit(W, eth(1)));
  await send(pool.connect(bob).borrow(U, usd(1_000)));
  await timeTravel(YEAR / 2);

  await send(pool.connect(bob).repay(U, ethers.MaxUint256, bob.address));
  assert.equal(await pool.borrowBalance(U, bob.address), 0n);
  assert.ok((await usdc.balanceOf(bob.address)) < usd(100_000), "Боб заплатил проценты");

  await send(pool.connect(bob).withdraw(W, ethers.MaxUint256));
  assert.equal(await weth.balanceOf(bob.address), eth(10));
});

test("прибыль банка: владелец выводит резервы, вкладчик забирает вклад с процентами", async () => {
  const { owner, alice, bob, treasury, usdc, weth, pool, timeTravel } = await setup();
  const U = await usdc.getAddress();
  const W = await weth.getAddress();

  await send(pool.connect(alice).deposit(U, usd(10_000)));
  await send(pool.connect(bob).deposit(W, eth(5)));
  await send(pool.connect(bob).borrow(U, usd(5_000)));
  await timeTravel(YEAR);
  await send(pool.connect(bob).repay(U, ethers.MaxUint256, bob.address));

  const { reserves } = await pool.markets(U);
  await expectRevert(pool.connect(alice).withdrawReserves(U, reserves, alice.address), "NotOwner");
  await send(pool.connect(owner).withdrawReserves(U, reserves, treasury.address));
  near(await usdc.balanceOf(treasury.address), usd(12.5), usd(0.01), "казна банка");

  await send(pool.connect(alice).withdraw(U, ethers.MaxUint256));
  near(await usdc.balanceOf(alice.address), usd(100_112.5), usd(0.01), "Алиса с процентами");
});

test("админ не может выставить опасные параметры риска", async () => {
  const { owner, pool } = await setup();
  const dai = await deploy(owner, "TestToken", "Test DAI", "DAI", 18);
  const D = await dai.getAddress();
  const rate = { baseRate: 0n, slope1: wad(0.04), slope2: wad(0.75), kink: wad(0.8) };

  // LTV выше порога ликвидации
  await expectRevert(pool.listMarket(D, 9000, 8500, 500, 1000, rate), "InvalidParams");
  // порог 95% + бонус 10% => ликвидатору не хватит залога
  await expectRevert(pool.listMarket(D, 9000, 9500, 1000, 1000, rate), "InvalidParams");
  // kink = 100%
  await expectRevert(pool.listMarket(D, 8000, 8500, 500, 1000, { ...rate, kink: wad(1) }), "InvalidParams");
  // нормальные параметры проходят
  await send(pool.listMarket(D, 8000, 8500, 500, 1000, rate));
  assert.equal(await pool.marketCount(), 3n);
});

test("USDT: банк работает с токеном, который не возвращает true при переводе", async () => {
  const { owner, alice, bob, weth, pool, oracle } = await setup();
  const usdt = await deploy(owner, "TetherLikeToken", "Test Tether", "USDT", 6);
  const T = await usdt.getAddress();
  const W = await weth.getAddress();
  const P = await pool.getAddress();
  await send(oracle.setPrice(T, wad(1)));
  await send(
    pool.listMarket(T, 7500, 8000, 500, 1000, { baseRate: 0n, slope1: wad(0.04), slope2: wad(0.75), kink: wad(0.8) })
  );

  await send(usdt.mint(alice.address, usd(10_000)));
  await send(usdt.connect(alice).approve(P, ethers.MaxUint256));
  await send(pool.connect(alice).deposit(T, usd(10_000)));

  await send(pool.connect(bob).deposit(W, eth(1)));
  await send(pool.connect(bob).borrow(T, usd(1_000)));
  assert.equal(await usdt.balanceOf(bob.address), usd(1_000));

  await send(usdt.connect(bob).approve(P, ethers.MaxUint256));
  await send(pool.connect(bob).repay(T, ethers.MaxUint256, bob.address));
  assert.equal(await pool.borrowBalance(T, bob.address), 0n);

  await send(pool.connect(alice).withdraw(T, ethers.MaxUint256));
  assert.ok((await usdt.balanceOf(alice.address)) >= usd(10_000), "Алиса вернула вклад");
});
