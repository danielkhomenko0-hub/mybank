// Работа с настоящими контрактами через кошелёк (MetaMask) и ethers v6.
// Отдаёт состояние в том же виде, что и симулятор, чтобы интерфейс был общий.
(function (root) {
  const Sim = root.MyBankSim;
  const ERRORS_RU = Sim.ERRORS_RU;
  const BankError = Sim.BankError;

  const FAUCET = { USDC: "10000", USDT: "10000", WETH: "5" };

  // Какой контракт разворачивать для каждого тестового токена
  const TOKEN_CONTRACT = { USDT: "TetherLikeToken" };
  const NETWORK_NAMES = { 1: "mainnet", 11155111: "sepolia", 1337: "localhost", 31337: "localhost" };

  /**
   * Разворачивает весь банк с кошелька пользователя (каждая транзакция подтверждается в MetaMask).
   * Параметры рынков берутся из симулятора, чтобы демо и сеть совпадали.
   * @param {object} p
   * @param {object} p.ethers
   * @param {object} p.signer
   * @param {object} p.artifacts { LendingPool, SimpleOracle, TestToken, TetherLikeToken } — { abi, bytecode }
   * @param {(step: string, done: number, total: number) => void} [p.onStep]
   * @returns {Promise<object>} то же, что пишет scripts/deploy.js в deployments/<сеть>.json
   */
  async function deployBank({ ethers, signer, artifacts, onStep = () => {} }) {
    const provider = signer.provider;
    const { chainId } = await provider.getNetwork();
    if (chainId === 1n) throw new BankError("Mainnet", "Это основная сеть Ethereum. Прототип можно разворачивать только в тестовой сети.");
    const owner = await signer.getAddress();
    if ((await provider.getBalance(owner)) === 0n) {
      throw new BankError("NoGas", "На кошельке 0 ETH в этой сети. Возьмите тестовые ETH в Sepolia faucet.");
    }
    const markets = Sim.MARKET_CONFIG;
    const total = 2 + markets.length * 3;
    let done = 0;
    const step = (text) => onStep(text, done, total);
    const wad = (n) => ethers.parseUnits(String(n), 18);
    const bps = (x) => Math.round(x * 10_000);
    const deployOne = async (name, args, label) => {
      step(label);
      const { abi, bytecode } = artifacts[name];
      const c = await new ethers.ContractFactory(abi, bytecode, signer).deploy(...args);
      await c.waitForDeployment();
      done++;
      return c;
    };
    const sendTx = async (label, fn) => {
      step(label);
      await (await fn()).wait();
      done++;
    };

    try {
      const deployBlock = await provider.getBlockNumber();
      const oracle = await deployOne("SimpleOracle", [], "Оракул цен");
      const pool = await deployOne("LendingPool", [await oracle.getAddress()], "Кредитный пул");
      const assets = [];
      for (const m of markets) {
        const token = await deployOne(TOKEN_CONTRACT[m.symbol] || "TestToken", [`MyBank Test ${m.symbol}`, m.symbol, m.decimals], `Тестовый токен ${m.symbol}`);
        const addr = await token.getAddress();
        await sendTx(`Цена ${m.symbol}: $${m.price}`, () => oracle.setPrice(addr, wad(m.price)));
        await sendTx(`Открытие рынка ${m.symbol}`, () =>
          pool.listMarket(addr, bps(m.ltv), bps(m.lt), bps(m.bonus), bps(m.rf), {
            baseRate: wad(m.rate.base), slope1: wad(m.rate.s1), slope2: wad(m.rate.s2), kink: wad(m.rate.kink),
          })
        );
        assets.push({ symbol: m.symbol, address: addr, decimals: m.decimals });
      }
      onStep("Готово", total, total);
      return {
        network: NETWORK_NAMES[Number(chainId)] || `chain-${chainId}`,
        chainId: Number(chainId),
        deployedAt: new Date().toISOString(),
        deployBlock,
        owner,
        pool: await pool.getAddress(),
        oracle: await oracle.getAddress(),
        assets,
      };
    } catch (e) {
      if (e && (e.code === "ACTION_REJECTED" || e.code === 4001)) {
        throw new BankError("Rejected", `Вы отклонили транзакцию в кошельке (шаг ${done + 1} из ${total}). Деплой остановлен.`);
      }
      throw e instanceof BankError ? e : new BankError("DeployFailed", "Деплой не прошёл: " + (e?.shortMessage || e?.message || e));
    }
  }

  class ChainBank {
    /**
     * @param {object} p
     * @param {object} p.ethers     библиотека ethers v6
     * @param {object} p.signer     подписант (кошелёк пользователя)
     * @param {object} p.deployment содержимое deployments/<сеть>.json
     * @param {object} p.abis       { LendingPool, SimpleOracle, TestToken }
     */
    constructor({ ethers, signer, deployment, abis }) {
      this.ethers = ethers;
      this.signer = signer;
      this.dep = deployment;
      this.pool = new ethers.Contract(deployment.pool, abis.LendingPool, signer);
      this.oracle = new ethers.Contract(deployment.oracle, abis.SimpleOracle, signer);
      this.tokens = {};
      for (const a of deployment.assets) {
        this.tokens[a.symbol] = { ...a, contract: new ethers.Contract(a.address, abis.TestToken, signer) };
      }
      this.log = [];
    }

    /** Подключение к кошельку в браузере, с переключением на нужную сеть. */
    static async connectBrowser({ ethers, deployment, abis }) {
      const eth = root.ethereum;
      if (!eth) {
        throw new BankError(
          "NoWallet",
          "Кошелёк не найден. Установите MetaMask и откройте страницу в обычном браузере (не во встроенном превью)."
        );
      }
      await eth.request({ method: "eth_requestAccounts" });
      const want = "0x" + Number(deployment.chainId).toString(16);
      const have = await eth.request({ method: "eth_chainId" });
      if (have.toLowerCase() !== want) {
        try {
          await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
        } catch {
          throw new BankError("WrongNetwork", `Переключите кошелёк на сеть ${deployment.network} (chainId ${deployment.chainId}).`);
        }
      }
      const provider = new ethers.BrowserProvider(eth);
      const signer = await provider.getSigner();
      return new ChainBank({ ethers, signer, deployment, abis });
    }

    async address() {
      if (!this._addr) this._addr = await this.signer.getAddress();
      return this._addr;
    }

    _token(sym) {
      const t = this.tokens[sym];
      if (!t) throw new BankError("MarketNotListed");
      return t;
    }

    _num(v, decimals) {
      return Number(this.ethers.formatUnits(v, decimals));
    }

    _parse(amount, decimals) {
      const s = String(amount).trim().replace(",", ".");
      let v;
      try {
        v = this.ethers.parseUnits(s, decimals);
      } catch {
        throw new BankError("ZeroAmount", "Не понял сумму — введите число, например 250 или 0.5.");
      }
      if (v <= 0n) throw new BankError("ZeroAmount");
      return v;
    }

    /** Переводит ошибку контракта в понятный текст. */
    _explain(e) {
      if (e instanceof BankError) return e;
      if (e && (e.code === "ACTION_REJECTED" || e.code === 4001)) {
        return new BankError("Rejected", "Вы отклонили транзакцию в кошельке.");
      }
      let name = e?.revert?.name;
      const data = e?.data || e?.info?.error?.data || e?.error?.data;
      if (!name && typeof data === "string" && data.length >= 10) {
        try {
          name = this.pool.interface.parseError(data)?.name;
        } catch {}
      }
      if (name && ERRORS_RU[name]) return new BankError(name);
      return new BankError("Unknown", "Транзакция не прошла: " + (e?.shortMessage || e?.message || "неизвестная ошибка"));
    }

    async _send(label, fn) {
      try {
        const tx = await fn();
        const receipt = await tx.wait();
        this._note(`${label} — подтверждено в блоке ${receipt.blockNumber}.`, "op", tx.hash);
        return receipt;
      } catch (e) {
        throw this._explain(e);
      }
    }

    _note(text, kind = "op", hash) {
      this.log.unshift({ text, kind, hash, time: new Date().toLocaleTimeString("ru-RU") });
      if (this.log.length > 60) this.log.length = 60;
    }

    async _ensureAllowance(sym, amount) {
      const t = this._token(sym);
      const me = await this.address();
      const allowance = await t.contract.allowance(me, this.dep.pool);
      if (allowance >= amount) return;
      // USDT не даёт сменить ненулевое разрешение на другое — сначала обнуляем
      if (allowance > 0n) {
        await this._send(`Сброс разрешения ${sym}`, () => t.contract.approve(this.dep.pool, 0n));
      }
      await this._send(`Разрешение банку списывать ${sym}`, () =>
        t.contract.approve(this.dep.pool, this.ethers.MaxUint256)
      );
    }

    // ------------------------------------------------------------ операции

    async deposit(sym, amount) {
      const t = this._token(sym);
      const v = this._parse(amount, t.decimals);
      await this._ensureAllowance(sym, v);
      return this._send(`Вклад ${amount} ${sym}`, () => this.pool.deposit(t.address, v));
    }

    async withdraw(sym, amount) {
      const t = this._token(sym);
      const v = amount === "max" ? this.ethers.MaxUint256 : this._parse(amount, t.decimals);
      return this._send(`Снятие ${amount === "max" ? "всего вклада" : amount} ${sym}`, () =>
        this.pool.withdraw(t.address, v)
      );
    }

    async borrow(sym, amount) {
      const t = this._token(sym);
      const v = this._parse(amount, t.decimals);
      return this._send(`Кредит ${amount} ${sym}`, () => this.pool.borrow(t.address, v));
    }

    async repay(sym, amount) {
      const t = this._token(sym);
      const me = await this.address();
      const v = amount === "max" ? this.ethers.MaxUint256 : this._parse(amount, t.decimals);
      // При полном погашении долг растёт каждую секунду, поэтому разрешаем с запасом
      await this._ensureAllowance(sym, amount === "max" ? (await this.pool.borrowBalance(t.address, me)) * 2n : v);
      return this._send(`Погашение ${amount === "max" ? "всего долга" : amount} ${sym}`, () =>
        this.pool.repay(t.address, v, me)
      );
    }

    /** Тестовые токены из крана (mint открыт только в тестовом токене). */
    async faucet(sym) {
      const t = this._token(sym);
      const me = await this.address();
      return this._send(`Получено ${FAUCET[sym]} тестовых ${sym}`, () =>
        t.contract.mint(me, this.ethers.parseUnits(FAUCET[sym], t.decimals))
      );
    }

    async setPrice(sym, price) {
      const t = this._token(sym);
      return this._send(`Цена ${sym} → $${price}`, () =>
        this.oracle.setPrice(t.address, this.ethers.parseUnits(String(price), 18))
      );
    }

    async withdrawReserves(sym) {
      const t = this._token(sym);
      const m = await this.pool.markets(t.address);
      if (m.reserves === 0n) throw new BankError("ZeroAmount", "Резервов пока нет.");
      const me = await this.address();
      return this._send(`Прибыль банка ${sym} → казна`, () => this.pool.withdrawReserves(t.address, m.reserves, me));
    }

    // ------------------------------------------------------------ состояние

    async getState() {
      const me = await this.address();
      const owner = await this.pool.owner();
      const WAD = 18;
      const markets = await Promise.all(
        this.dep.assets.map(async (a) => {
          const t = this.tokens[a.symbol];
          const [m, price, util, br, sr, wallet, dep, bor] = await Promise.all([
            this.pool.markets(a.address),
            this.oracle.getPrice(a.address),
            this.pool.utilization(a.address),
            this.pool.borrowRate(a.address),
            this.pool.supplyRate(a.address),
            t.contract.balanceOf(me),
            this.pool.depositBalance(a.address, me),
            this.pool.borrowBalance(a.address, me),
          ]);
          const d = a.decimals;
          const totalDeposits = this._num(m.totalDeposits, d);
          const totalBorrows = this._num(m.totalBorrows, d);
          const reserves = this._num(m.reserves, d);
          return {
            symbol: a.symbol, name: a.symbol, decimals: d,
            price: this._num(price, WAD),
            ltv: Number(m.ltvBps) / 1e4,
            lt: Number(m.liqThresholdBps) / 1e4,
            bonus: Number(m.liqBonusBps) / 1e4,
            rf: Number(m.reserveFactorBps) / 1e4,
            rate: {
              base: this._num(m.rate.baseRate, WAD),
              s1: this._num(m.rate.slope1, WAD),
              s2: this._num(m.rate.slope2, WAD),
              kink: this._num(m.rate.kink, WAD),
            },
            utilization: this._num(util, WAD),
            borrowRate: this._num(br, WAD),
            supplyRate: this._num(sr, WAD),
            totalDeposits, totalBorrows, reserves,
            cash: totalDeposits + reserves - totalBorrows,
            wallet: this._num(wallet, d),
            deposited: this._num(dep, d),
            borrowed: this._num(bor, d),
            treasury: 0,
          };
        })
      );
      const acc = await this.pool.accountData(me);
      const hf = acc.healthFactor === this.ethers.MaxUint256 ? Infinity : this._num(acc.healthFactor, WAD);
      return {
        mode: "wallet",
        userLabel: me.slice(0, 6) + "…" + me.slice(-4),
        address: me,
        network: this.dep.network,
        markets,
        account: {
          collateralValue: this._num(acc.collateralValue, WAD),
          borrowLimit: this._num(acc.borrowLimit, WAD),
          liquidationLimit: this._num(acc.liquidationLimit, WAD),
          debtValue: this._num(acc.debtValue, WAD),
          healthFactor: hf,
        },
        others: [],
        log: this.log.slice(),
        isOwner: owner.toLowerCase() === me.toLowerCase(),
      };
    }
  }

  const api = { ChainBank, FAUCET, deployBank };
  root.MyBankChain = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
