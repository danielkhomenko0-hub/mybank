// Локальная тестовая цепочка на http://127.0.0.1:8545 (для проверки деплоя и интерфейса)
const ganache = require("ganache");
const server = ganache.server({
  logging: { quiet: true },
  wallet: { deterministic: true, totalAccounts: 5 },
  chain: { hardfork: "merge", chainId: 1337 },
});
server.listen(8545, async (err) => {
  if (err) throw err;
  const accounts = server.provider.getInitialAccounts();
  const [addr] = Object.keys(accounts);
  console.log("Локальная цепочка: http://127.0.0.1:8545 (chainId 1337)");
  console.log("Тестовый аккаунт:", addr);
  console.log("Его ключ (ТОЛЬКО для локальной цепочки):", accounts[addr].secretKey);
});
