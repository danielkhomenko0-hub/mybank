// Прогоняет собранную страницу в эмуляторе браузера (jsdom) и нажимает кнопки, как пользователь.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const page = path.join(__dirname, "..", "dist", "index.html");

function load(extra = {}) {
  const html = fs.readFileSync(page, "utf8").replace(/<script src="https:[^"]+"><\/script>/, ""); // без CDN
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      Object.assign(window, extra);
      window.addEventListener("error", (e) => errors.push(e.error || e.message));
    },
  });
  return { dom, w: dom.window, d: dom.window.document, errors };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const text = (d, id) => d.getElementById(id).textContent.replace(/\s+/g, " ").trim();
const click = (w, el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

test("демо: страница открывается в рабочем состоянии", async () => {
  const { w, d, errors } = load();
  await tick();
  assert.deepEqual(errors, []);
  assert.match(text(d, "who"), /Клиент: Вы · день 30/);
  assert.equal(d.querySelectorAll("#markets tr").length, 3); // USDC, USDT, WETH
  assert.match(text(d, "gauge"), /1\.\d\d/); // кредит уже есть, HF чуть ниже 1.6 из-за процентов
  assert.ok(d.querySelector("#curve svg path"));
  assert.ok(d.querySelectorAll("#journal li").length >= 3);
  void w;
});

test("демо: кредит по кнопке «Макс» и проверка лимита", async () => {
  const { w, d } = load();
  await tick();
  click(w, d.getElementById("max"));
  const v = parseFloat(d.getElementById("amount").value);
  assert.ok(v > 900 && v < 1000, "свободный лимит около $990, получено " + v);
  assert.match(text(d, "go"), /^Занять/);
  click(w, d.getElementById("go"));
  await tick();
  assert.match(text(d, "status"), /Готово/);

  // Попытка занять сверх лимита — понятная ошибка
  d.getElementById("amount").value = "5000";
  d.getElementById("amount").dispatchEvent(new w.Event("input", { bubbles: true }));
  click(w, d.getElementById("go"));
  await tick();
  assert.match(text(d, "status"), /Не хватает залога/);
});

test("демо: обвал ETH, ликвидация и прибыль банка", async () => {
  const { w, d } = load();
  await tick();
  const slider = d.getElementById("eth-price");
  slider.value = "1200";
  slider.dispatchEvent(new w.Event("change", { bubbles: true }));
  await tick();
  assert.match(text(d, "gauge"), /Под ликвидацией/);

  click(w, d.getElementById("liquidate"));
  await tick();
  assert.match(text(d, "status"), /Ликвидаций: \d/);
  assert.match(text(d, "journal"), /Ликвидация/);

  click(w, d.querySelector('[data-time="365"]'));
  await tick();
  const btn = d.getElementById("reserves");
  assert.equal(btn.disabled, false);
  click(w, btn);
  await tick();
  assert.match(text(d, "journal"), /прибыли в казну/);
});

// Этот тест нужен запущенный `npm run chain` и деплой на localhost — иначе он пропускается.
test("кошелёк: подключение и вклад через настоящий контракт на локальной цепочке", async (t) => {
  const { ethers } = require("ethers");
  const depFile = path.join(__dirname, "..", "deployments", "localhost.json");
  if (!fs.existsSync(depFile)) return t.skip("нет deployments/localhost.json");
  const rpc = new ethers.JsonRpcProvider("http://127.0.0.1:8545", undefined, { staticNetwork: true });
  try {
    const code = await rpc.getCode(JSON.parse(fs.readFileSync(depFile, "utf8")).pool);
    if (code === "0x") return t.skip("локальная цепочка перезапущена — сделайте деплой заново");
  } catch {
    rpc.destroy();
    return t.skip("локальная цепочка не запущена (npm run chain)");
  }
  const [me] = await rpc.send("eth_accounts", []);
  const listeners = {};
  // Минимальная замена MetaMask: пересылает запросы на локальную цепочку
  const ethereum = {
    request: async ({ method, params = [] }) => {
      if (method === "eth_requestAccounts") return [me];
      if (method === "eth_estimateGas") {
        await rpc.send(method, params);
        return "0x2dc6c0";
      }
      try {
        return await rpc.send(method, params);
      } catch (e) {
        const data = e?.error?.data?.result || e?.info?.error?.data?.result || e?.data;
        const err = new Error(e.shortMessage || e.message);
        err.code = -32000;
        if (typeof data === "string") err.data = data;
        throw err;
      }
    },
    on: (ev, fn) => (listeners[ev] = fn),
  };
  const { w, d } = load({ ethers, ethereum });
  await tick();
  click(w, d.getElementById("mode-wallet"));
  await tick();
  assert.ok(d.getElementById("connect"), "кнопка подключения");
  click(w, d.getElementById("connect"));
  for (let i = 0; i < 100 && !d.querySelector("[data-faucet]"); i++) await tick(50);
  assert.match(text(d, "status"), /Кошелёк подключён/);
  assert.ok(d.querySelector("[data-faucet]"), "кнопки крана");
  assert.match(text(d, "console"), /Вы владелец банка/);

  click(w, d.querySelector('[data-faucet="WETH"]'));
  for (let i = 0; i < 100 && !/Готово/.test(text(d, "status")); i++) await tick(50);
  assert.match(text(d, "status"), /Готово/);

  const collateral = () => Number(text(d, "figures").match(/Залог\$([\d,.]+)/)[1].replace(/,/g, ""));
  const before = collateral();
  click(w, d.querySelector('[data-action="deposit"]'));
  click(w, d.querySelector('tr[data-sym="WETH"]'));
  d.getElementById("amount").value = "1";
  d.getElementById("amount").dispatchEvent(new w.Event("input", { bubbles: true }));
  click(w, d.getElementById("go"));
  for (let i = 0; i < 200 && !/Готово|Не /.test(text(d, "status")); i++) await tick(50);
  assert.match(text(d, "status"), /Готово/);
  await tick(200);
  assert.equal(collateral() - before, 2000); // +1 ETH залога по $2000
  w.close();
});

test("кошелёк: банк разворачивается кнопкой на странице и сразу подключается", async () => {
  const { ethers } = require("ethers");
  const ganache = require("ganache");
  const chain = ganache.provider({ logging: { quiet: true }, chain: { hardfork: "merge", chainId: 11155111 }, wallet: { totalAccounts: 1 } });
  // Ganache занижает оценку газа для вложенных вызовов — даём запас, как в helpers.js
  const ethereum = {
    request: async (args) => {
      if (args.method === "eth_estimateGas") { await chain.request(args); return "0x2dc6c0"; }
      if (args.method === "eth_requestAccounts") return chain.request({ method: "eth_accounts", params: [] });
      return chain.request(args);
    },
    on: () => {},
  };
  // В «Sepolia» страница подключает ETH к Chainlink — кладём поддельный фид по настоящему адресу
  const FEED = "0x694AA1769357215DE4FAC081bf1f309aDC325306";
  const signer = await new ethers.BrowserProvider(ethereum).getSigner();
  const { abi, bytecode } = require("../build/MockPriceFeed.json");
  const mock = await new ethers.ContractFactory(abi, bytecode, signer).deploy(8);
  await mock.waitForDeployment();
  await chain.request({ method: "evm_setAccountCode", params: [FEED, await signer.provider.getCode(await mock.getAddress())] });
  await chain.request({ method: "evm_setAccountStorageAt", params: [FEED, ethers.toBeHex(0, 32), ethers.toBeHex(8, 32)] }); // decimals
  await (await new ethers.Contract(FEED, abi, signer).set(234304000000n)).wait(); // $2343.04

  const { w, d } = load({ ethers, ethereum });
  await tick();
  click(w, d.getElementById("mode-wallet"));
  await tick();
  click(w, d.getElementById("deploy"));
  for (let i = 0; i < 400 && !/развёрнут и подключён|Деплой|не/.test(text(d, "status")); i++) await tick(50);
  assert.match(text(d, "status"), /Банк развёрнут и подключён/);
  for (let i = 0; i < 100 && !d.getElementById("deploy-json"); i++) await tick(50); // ждём, пока подтянется состояние
  const json = JSON.parse(d.getElementById("deploy-json").value);
  assert.equal(json.network, "sepolia");
  assert.equal(json.assets.length, 3);
  assert.equal(json.feeds.WETH.feed, FEED);
  assert.ok(d.querySelector('[data-faucet="USDT"]'), "кран USDT");
  assert.match(text(d, "console"), /Вы владелец банка/);
  assert.match(text(d, "console"), /Цена ETH сейчас от Chainlink/);
  assert.ok(d.getElementById("pause"), "кнопка паузы у владельца");
  w.close();
});
