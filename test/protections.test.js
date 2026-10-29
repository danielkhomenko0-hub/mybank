const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { setup, deploy, send, expectRevert, near, usd, eth, wad, YEAR } = require("./helpers");

test("пауза: вклады и кредиты стоят, а погасить, снять и ликвидировать можно", async () => {
  const { alice, bob, carol, usdc, weth, pool, oracle } = await setup();
  const U = await usdc.getAddress();
  const W = await weth.getAddress();
  await send(pool.connect(alice).deposit(U, usd(10_000)));
  await send(pool.connect(bob).deposit(W, eth(1)));
  await send(pool.connect(bob).borrow(U, usd(1_000)));

  await expectRevert(pool.connect(alice).setPaused(true), "NotOwner");
  await send(pool.setPaused(true));
  await expectRevert(pool.connect(alice).deposit(U, usd(1)), "Paused");
  await expectRevert(pool.connect(bob).borrow(U, usd(1)), "Paused");

  await send(pool.connect(bob).repay(U, usd(500), bob.address));
  await send(pool.connect(alice).withdraw(U, usd(1_000)));
  await send(oracle.setPrice(W, wad(1_000))); // HF = 1000 * 0.8 / 500 = 1.6 — пока здоров
  await send(oracle.setPrice(W, wad(600)));   // HF = 0.96 — можно ликвидировать и на паузе
  await send(pool.connect(carol).liquidate(bob.address, U, W, usd(100)));

  await send(pool.setPaused(false));
  await send(pool.connect(alice).deposit(U, usd(1)));
});

test("передача владельца в два шага: пока новый не подтвердил, банком управляет старый", async () => {
  const { owner, alice, bob, usdc, pool, oracle } = await setup();
  const U = await usdc.getAddress();

  await expectRevert(pool.connect(alice).transferOwnership(alice.address), "NotOwner");
  await send(pool.transferOwnership(alice.address));
  assert.equal(await pool.owner(), owner.address);
  assert.equal(await pool.pendingOwner(), alice.address);

  await expectRevert(pool.connect(bob).acceptOwnership(), "NotPendingOwner");
  await send(pool.connect(alice).acceptOwnership());
  assert.equal(await pool.owner(), alice.address);
  assert.equal(await pool.pendingOwner(), ethers.ZeroAddress);
  await expectRevert(pool.withdrawReserves(U, 0n, owner.address), "NotOwner");
  await send(pool.connect(alice).setPaused(true));

  // У оракула то же самое
  await send(oracle.transferOwnership(alice.address));
  await expectRevert(oracle.connect(bob).acceptOwnership(), "NotPendingOwner");
  await send(oracle.connect(alice).acceptOwnership());
  await expectRevert(oracle.setPrice(U, wad(1)), "NotOwner");
  await send(oracle.connect(alice).setPrice(U, wad(1)));
});

test("при HF ниже 0.95 ликвидатор может погасить весь долг, а не половину", async () => {
  const { alice, bob, carol, usdc, weth, pool, oracle } = await setup();
  const U = await usdc.getAddress();
  const W = await weth.getAddress();
  await send(pool.connect(alice).deposit(U, usd(10_000)));
  await send(pool.connect(bob).deposit(W, eth(1)));
  await send(pool.connect(bob).borrow(U, usd(1_500)));

  // ETH $1700: HF = 1700 * 0.8 / 1500 ≈ 0.907 < 0.95
  await send(oracle.setPrice(W, wad(1_700)));
  const wethBefore = await weth.balanceOf(carol.address);
  await send(pool.connect(carol).liquidate(bob.address, U, W, usd(1_500)));

  assert.equal(await pool.borrowBalance(U, bob.address), 0n);
  // 1500 * 1.05 / 1700 = 0.92647… ETH залога ушло ликвидатору, остаток — Бобу
  const seized = (await weth.balanceOf(carol.address)) - wethBefore;
  assert.equal(seized, eth("0.926470588235294117"), "изъято");
  assert.equal(await pool.depositBalance(W, bob.address), eth(1) - seized);
});

test("плохой долг: резервы банка покрывают первыми, остаток делят вкладчики, свободные деньги не теряются", async () => {
  const { alice, bob, carol, usdc, weth, pool, oracle, timeTravel } = await setup();
  const U = await usdc.getAddress();
  const W = await weth.getAddress();
  await send(pool.connect(alice).deposit(U, usd(10_000)));
  await send(pool.connect(bob).deposit(W, eth(1)));
  await send(pool.connect(bob).borrow(U, usd(1_500)));
  await timeTravel(YEAR); // набегают проценты и резервы банка
  await send(pool.accrueInterest(U));

  const cash = (m) => m.totalDeposits + m.reserves - m.totalBorrows;
  const before = await pool.markets(U);
  const aliceBefore = await pool.depositBalance(U, alice.address);
  assert.ok(before.reserves > 0n, "резервы есть");

  // ETH обвалился до $1000: залог $1000 против долга ~$1500 — весь залог не покроет долг
  await send(oracle.setPrice(W, wad(1_000)));
  const receipt = await send(pool.connect(carol).liquidate(bob.address, U, W, ethers.MaxUint256));

  const events = receipt.logs.map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
  const liq = events.find((e) => e.name === "Liquidate");
  const bad = events.find((e) => e.name === "BadDebtWrittenOff");
  assert.equal(liq.args.seized, eth(1), "ликвидатор забрал весь залог");
  assert.ok(bad, "плохой долг списан");

  const after = await pool.markets(U);
  assert.equal(await pool.borrowBalance(U, bob.address), 0n, "долг Боба списан");
  assert.equal(await pool.depositBalance(W, bob.address), 0n);
  // Списание не создаёт и не уничтожает деньги: свободных стало больше ровно на погашенное ликвидатором
  assert.equal(cash(after), cash(before) + liq.args.repaid);
  assert.equal(bad.args.fromReserves, before.reserves, "резервы ушли на покрытие целиком");
  assert.equal(after.reserves, 0n);
  // Остаток лёг на вкладчиков
  const aliceAfter = await pool.depositBalance(U, alice.address);
  near(aliceBefore - aliceAfter, bad.args.amount - bad.args.fromReserves, 1n, "убыток Алисы");
  await send(pool.connect(alice).withdraw(U, ethers.MaxUint256));
});

test("Chainlink: цена из фида, устаревшая цена блокирует операции, ручная цена отключает фид", async () => {
  const { owner, alice, bob, usdc, weth, pool, oracle, timeTravel } = await setup();
  const U = await usdc.getAddress();
  const W = await weth.getAddress();
  const feed = await deploy(owner, "MockPriceFeed", 8);
  await send(feed.set(234304000000n)); // $2343.04, 8 знаков, как ETH/USD в Sepolia

  await expectRevert(oracle.connect(alice).setFeed(W, await feed.getAddress(), 3600), "NotOwner");
  await send(oracle.setFeed(W, await feed.getAddress(), 3600));
  assert.equal(await oracle.usesFeed(W), true);
  assert.equal(await oracle.getPrice(W), wad(2343.04));

  await send(pool.connect(alice).deposit(U, usd(10_000)));
  await send(pool.connect(bob).deposit(W, eth(1)));
  await send(pool.connect(bob).borrow(U, usd(1_000)));

  // Фид не обновлялся больше часа — операции, которым нужна цена, откатываются
  await timeTravel(3601);
  await expectRevert(oracle.getPrice(W), "StalePrice");
  await expectRevert(pool.connect(bob).borrow(U, usd(1)), "StalePrice");
  await send(feed.set(234304000000n));
  // Оценка газа в ganache после перемотки времени видит другое время, чем блок, — газ задаём сами
  await send(pool.connect(bob).borrow(U, usd(1), { gasLimit: 3_000_000 }));

  // Отрицательная цена из фида не принимается
  await send(feed.set(-1n));
  await expectRevert(oracle.getPrice(W), "BadPrice");
  await expectRevert(oracle.setFeed(U, await feed.getAddress(), 3600), "BadPrice");

  // Ручная цена (для демо обвала) отключает фид
  await send(oracle.setPrice(W, wad(1_800)));
  assert.equal(await oracle.usesFeed(W), false);
  assert.equal(await oracle.getPrice(W), wad(1_800));
});
