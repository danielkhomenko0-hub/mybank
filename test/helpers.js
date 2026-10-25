const ganache = require("ganache");
const { ethers } = require("ethers");
const path = require("path");

const artifact = (name) => require(path.join(__dirname, "..", "build", `${name}.json`));
const usd = (n) => ethers.parseUnits(String(n), 6);   // USDC — 6 знаков
const eth = (n) => ethers.parseUnits(String(n), 18);  // WETH — 18 знаков
const wad = (n) => ethers.parseUnits(String(n), 18);  // ставки и цены
const YEAR = 365 * 24 * 60 * 60;

async function send(txPromise) {
  return (await txPromise).wait();
}

async function deploy(signer, name, ...args) {
  const { abi, bytecode } = artifact(name);
  const c = await new ethers.ContractFactory(abi, bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}

/** Поднимает чистую локальную цепочку и разворачивает весь "банк". */
async function setup() {
  const chain = ganache.provider({
    logging: { quiet: true },
    wallet: { totalAccounts: 5, defaultBalance: 1000 },
    chain: { hardfork: "merge" },
  });
  // Ganache занижает оценку газа для вложенных вызовов, поэтому после успешной
  // оценки (она же проверяет, что транзакция не откатится) даём запас газа.
  // Ganache кладёт данные отката в error.data.result — переносим в error.data,
  // чтобы ethers мог расшифровать кастомные ошибки контракта.
  const call = async (args) => {
    try {
      return await chain.request(args);
    } catch (e) {
      if (e && e.data && typeof e.data === "object" && e.data.result) {
        const err = new Error(e.message);
        err.code = e.code ?? -32000;
        err.data = e.data.result;
        throw err;
      }
      throw e;
    }
  };
  const raw = {
    request: async (args) => {
      if (args.method === "eth_estimateGas") {
        await call(args);
        return "0x" + (3_000_000).toString(16);
      }
      return call(args);
    },
  };
  const provider = new ethers.BrowserProvider(raw);
  const [owner, alice, bob, carol, treasury] = await Promise.all(
    [0, 1, 2, 3, 4].map((i) => provider.getSigner(i))
  );

  const oracle = await deploy(owner, "SimpleOracle");
  const usdc = await deploy(owner, "TestToken", "Test USD Coin", "USDC", 6);
  const weth = await deploy(owner, "TestToken", "Test Wrapped Ether", "WETH", 18);
  const pool = await deploy(owner, "LendingPool", await oracle.getAddress());

  await send(oracle.setPrice(await usdc.getAddress(), wad(1)));
  await send(oracle.setPrice(await weth.getAddress(), wad(2000)));

  // USDC: можно занять 80%, ликвидация с 85%, бонус 5%, банку 10% процентов
  await send(
    pool.listMarket(await usdc.getAddress(), 8000, 8500, 500, 1000, {
      baseRate: 0n,
      slope1: wad(0.04),
      slope2: wad(0.75),
      kink: wad(0.8),
    })
  );
  // WETH: волатильнее, поэтому строже — 75% / 80%
  await send(
    pool.listMarket(await weth.getAddress(), 7500, 8000, 500, 1000, {
      baseRate: 0n,
      slope1: wad(0.04),
      slope2: wad(3),
      kink: wad(0.8),
    })
  );

  const poolAddr = await pool.getAddress();
  for (const s of [alice, bob, carol]) {
    await send(usdc.mint(s.address, usd(100_000)));
    await send(weth.mint(s.address, eth(10)));
    await send(usdc.connect(s).approve(poolAddr, ethers.MaxUint256));
    await send(weth.connect(s).approve(poolAddr, ethers.MaxUint256));
  }

  const timeTravel = async (seconds) => {
    await chain.request({ method: "evm_increaseTime", params: [seconds] });
    await chain.request({ method: "evm_mine", params: [] });
  };

  return { provider, owner, alice, bob, carol, treasury, oracle, usdc, weth, pool, timeTravel };
}

/** Проверяет, что транзакция откатилась с нужной ошибкой контракта. */
async function expectRevert(promise, errorName) {
  try {
    await (await promise).wait();
  } catch (e) {
    let name = e.revert?.name || "";
    const data = e.data || e.info?.error?.data;
    if (!name && typeof data === "string" && data.length >= 10) {
      const iface = new ethers.Interface(artifact("LendingPool").abi);
      name = iface.parseError(data)?.name || "";
    }
    const text = name + " " + (e.shortMessage || "") + " " + (e.message || "");
    if (text.includes(errorName)) return;
    throw new Error(`Ожидалась ошибка ${errorName}, получено: ${e.shortMessage || e.message}`);
  }
  throw new Error(`Ожидалась ошибка ${errorName}, но транзакция прошла`);
}

/** |a - b| <= tolerance */
function near(actual, expected, tolerance, label = "") {
  const diff = actual > expected ? actual - expected : expected - actual;
  if (diff > tolerance) {
    throw new Error(`${label} ожидалось ≈${expected}, получено ${actual} (разница ${diff})`);
  }
}

module.exports = { setup, deploy, send, expectRevert, near, usd, eth, wad, YEAR };
