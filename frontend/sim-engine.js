// Симулятор банка в браузере: та же математика, что в LendingPool.sol,
// только на обычных числах JS. Нужен для демо-режима без кошелька и блокчейна.
(function (root) {
  const YEAR = 365 * 24 * 3600;
  const DAY = 24 * 3600;

  const MARKET_CONFIG = [
    {
      symbol: "USDC", name: "USD Coin", decimals: 6, price: 1,
      ltv: 0.8, lt: 0.85, bonus: 0.05, rf: 0.1,
      rate: { base: 0, s1: 0.04, s2: 0.75, kink: 0.8 },
    },
    {
      symbol: "USDT", name: "Tether", decimals: 6, price: 1,
      ltv: 0.75, lt: 0.8, bonus: 0.05, rf: 0.1,
      rate: { base: 0, s1: 0.04, s2: 0.75, kink: 0.8 },
    },
    {
      symbol: "WETH", name: "Wrapped Ether", decimals: 18, price: 2000,
      ltv: 0.75, lt: 0.8, bonus: 0.05, rf: 0.1,
      rate: { base: 0, s1: 0.04, s2: 3, kink: 0.8 },
    },
  ];

  const CLOSE_FACTOR = 0.5;

  // structuredClone есть не во всех браузерах; данные простые, так что JSON тоже подходит
  const clone = typeof structuredClone === "function" ? structuredClone : (o) => JSON.parse(JSON.stringify(o));

  // Тексты ошибок общие для симулятора и блокчейна
  const ERRORS_RU = {
    InsufficientCollateral: "Не хватает залога: после операции счёт оказался бы под угрозой ликвидации.",
    InsufficientLiquidity: "В пуле сейчас нет столько свободных денег — их заняли другие заёмщики.",
    InsufficientBalance: "Во вкладе нет такой суммы.",
    ZeroAmount: "Введите сумму больше нуля.",
    AccountHealthy: "Счёт в порядке — ликвидировать его нельзя.",
    NotOwner: "Это может сделать только владелец банка.",
    MarketNotListed: "Этот актив не подключён к банку.",
    TransferFailed: "Токены не перевелись — проверьте баланс кошелька.",
    WalletBalance: "На кошельке не хватает средств.",
    NoDebt: "По этому активу нет долга.",
  };

  class BankError extends Error {
    constructor(code, message) {
      super(message || ERRORS_RU[code] || code);
      this.code = code;
    }
  }

  // ---------------------------------------------------------- чистые формулы

  function utilization(m) {
    const total = m.totalDeposits + m.reserves;
    if (total <= 0) return 0;
    return Math.min(m.totalBorrows / total, 1);
  }

  function borrowRateAt(rate, u) {
    if (u <= rate.kink) return rate.base + (rate.s1 * u) / rate.kink;
    return rate.base + rate.s1 + (rate.s2 * (u - rate.kink)) / (1 - rate.kink);
  }

  function supplyRateAt(rate, rf, u) {
    return borrowRateAt(rate, u) * u * (1 - rf);
  }

  /**
   * Сводка по счёту из списка рынков вида { price, ltv, lt, deposited, borrowed }.
   * Используется и симулятором, и интерфейсом (для предпросмотра операции).
   */
  function computeAccount(rows) {
    const a = { collateralValue: 0, borrowLimit: 0, liquidationLimit: 0, debtValue: 0, healthFactor: Infinity };
    for (const r of rows) {
      const dep = Math.max(0, r.deposited) * r.price;
      a.collateralValue += dep;
      a.borrowLimit += dep * r.ltv;
      a.liquidationLimit += dep * r.lt;
      a.debtValue += Math.max(0, r.borrowed) * r.price;
    }
    if (a.debtValue > 1e-9) a.healthFactor = a.liquidationLimit / a.debtValue;
    return a;
  }

  // ---------------------------------------------------------- симулятор

  class SimBank {
    constructor({ seed = true } = {}) {
      this.reset({ seed });
    }

    reset({ seed = true } = {}) {
      this.time = 0;
      this.treasury = {};
      this.log = [];
      this.markets = {};
      for (const c of MARKET_CONFIG) {
        this.markets[c.symbol] = {
          ...c,
          rate: { ...c.rate },
          totalDeposits: 0,
          depositShares: 0,
          totalBorrows: 0,
          borrowShares: 0,
          reserves: 0,
        };
        this.treasury[c.symbol] = 0;
      }
      this.users = {};
      this._addUser("you", "Вы", { USDC: 25_000, USDT: 10_000, WETH: 5 });
      if (!seed) return;

      // Чтобы в банке была жизнь: другие вкладчики и один крупный заёмщик
      this._addUser("savers", "Другие вкладчики", { USDC: 80_000, USDT: 40_000, WETH: 40 });
      this._addUser("borrower", "Другой заёмщик", { WETH: 40 });
      this._addUser("liquidator", "Бот-ликвидатор", { USDC: 1_000_000, USDT: 1_000_000, WETH: 500 });
      this.deposit("savers", "USDC", 80_000, { silent: true });
      this.deposit("savers", "USDT", 40_000, { silent: true });
      this.deposit("savers", "WETH", 40, { silent: true });
      this.deposit("borrower", "WETH", 40, { silent: true });
      this.borrow("borrower", "USDC", 40_000, { silent: true });
      this.borrow("borrower", "USDT", 12_000, { silent: true });
      this._note(
        "Банк открыт: вкладчики принесли 80 000 USDC, 40 000 USDT и 40 WETH, один клиент занял 40 000 USDC и 12 000 USDT.",
        "info"
      );
    }

    _addUser(id, name, wallet) {
      const u = { id, name, wallet: {}, dep: {}, bor: {} };
      for (const c of MARKET_CONFIG) {
        u.wallet[c.symbol] = wallet[c.symbol] || 0;
        u.dep[c.symbol] = 0;
        u.bor[c.symbol] = 0;
      }
      this.users[id] = u;
    }

    _market(sym) {
      const m = this.markets[sym];
      if (!m) throw new BankError("MarketNotListed");
      return m;
    }

    _user(id) {
      const u = this.users[id];
      if (!u) throw new Error("Нет такого клиента: " + id);
      return u;
    }

    _note(text, kind = "op") {
      this.log.unshift({ day: Math.floor(this.time / DAY), text, kind });
      if (this.log.length > 60) this.log.length = 60;
    }

    /** Выполнить операцию атомарно: при ошибке состояние откатывается (как revert). */
    _tx(fn) {
      const snap = clone({ markets: this.markets, users: this.users, treasury: this.treasury });
      try {
        return fn();
      } catch (e) {
        Object.assign(this, snap);
        throw e;
      }
    }

    // ------------------------------------------------------------ формулы рынка

    cash(sym) {
      const m = this._market(sym);
      return m.totalDeposits + m.reserves - m.totalBorrows;
    }

    utilization(sym) {
      return utilization(this._market(sym));
    }

    borrowRate(sym) {
      const m = this._market(sym);
      return borrowRateAt(m.rate, utilization(m));
    }

    supplyRate(sym) {
      const m = this._market(sym);
      return supplyRateAt(m.rate, m.rf, utilization(m));
    }

    depositBalance(sym, id) {
      const m = this._market(sym);
      if (m.depositShares === 0) return 0;
      return (this._user(id).dep[sym] * m.totalDeposits) / m.depositShares;
    }

    borrowBalance(sym, id) {
      const m = this._market(sym);
      if (m.borrowShares === 0) return 0;
      return (this._user(id).bor[sym] * m.totalBorrows) / m.borrowShares;
    }

    accountData(id) {
      return computeAccount(
        Object.values(this.markets).map((m) => ({
          price: m.price, ltv: m.ltv, lt: m.lt,
          deposited: this.depositBalance(m.symbol, id),
          borrowed: this.borrowBalance(m.symbol, id),
        }))
      );
    }

    // ------------------------------------------------------------ время и проценты

    _accrue(m, dt) {
      if (m.totalBorrows <= 0) return;
      const interest = (m.totalBorrows * borrowRateAt(m.rate, utilization(m)) * dt) / YEAR;
      const toReserves = interest * m.rf;
      m.totalBorrows += interest;
      m.reserves += toReserves;
      m.totalDeposits += interest - toReserves;
    }

    /** Перемотать время. steps — на сколько шагов дробить начисление (по умолчанию по дням). */
    timeTravel(seconds, steps = Math.max(1, Math.round(seconds / DAY))) {
      const dt = seconds / steps;
      for (let i = 0; i < steps; i++) {
        for (const m of Object.values(this.markets)) this._accrue(m, dt);
        this.time += dt;
      }
      const days = Math.round(seconds / DAY);
      this._note(`Прошло ${days} дн.: проценты начислены.`, "time");
    }

    // ------------------------------------------------------------ операции клиентов

    deposit(id, sym, amount, { silent = false } = {}) {
      return this._tx(() => {
        amount = Number(amount);
        if (!(amount > 0)) throw new BankError("ZeroAmount");
        const m = this._market(sym);
        const u = this._user(id);
        if (u.wallet[sym] + 1e-12 < amount) throw new BankError("WalletBalance");
        const shares = m.depositShares === 0 ? amount : (amount * m.depositShares) / m.totalDeposits;
        m.totalDeposits += amount;
        m.depositShares += shares;
        u.dep[sym] += shares;
        u.wallet[sym] -= amount;
        if (!silent) this._note(`${u.name}: вклад ${fmt(amount, sym)}.`);
        return amount;
      });
    }

    withdraw(id, sym, amount) {
      return this._tx(() => {
        const m = this._market(sym);
        const u = this._user(id);
        if (u.dep[sym] <= 0) throw new BankError("InsufficientBalance");
        let shares;
        if (amount === "max") {
          shares = u.dep[sym];
          amount = (shares * m.totalDeposits) / m.depositShares;
        } else {
          amount = Number(amount);
          if (!(amount > 0)) throw new BankError("ZeroAmount");
          shares = (amount * m.depositShares) / m.totalDeposits;
        }
        if (shares > u.dep[sym] * (1 + 1e-12)) throw new BankError("InsufficientBalance");
        if (amount > this.cash(sym) + 1e-9) throw new BankError("InsufficientLiquidity");
        shares = Math.min(shares, u.dep[sym]);
        u.dep[sym] -= shares;
        m.depositShares -= shares;
        m.totalDeposits -= amount;
        if (this.accountData(id).healthFactor < 1) throw new BankError("InsufficientCollateral");
        u.wallet[sym] += amount;
        this._note(`${u.name}: снятие ${fmt(amount, sym)}.`);
        return amount;
      });
    }

    borrow(id, sym, amount, { silent = false } = {}) {
      return this._tx(() => {
        amount = Number(amount);
        if (!(amount > 0)) throw new BankError("ZeroAmount");
        const m = this._market(sym);
        const u = this._user(id);
        if (amount > this.cash(sym) + 1e-9) throw new BankError("InsufficientLiquidity");
        const shares = m.borrowShares === 0 ? amount : (amount * m.borrowShares) / m.totalBorrows;
        m.totalBorrows += amount;
        m.borrowShares += shares;
        u.bor[sym] += shares;
        const a = this.accountData(id);
        if (a.debtValue > a.borrowLimit * (1 + 1e-12)) throw new BankError("InsufficientCollateral");
        u.wallet[sym] += amount;
        if (!silent) this._note(`${u.name}: кредит ${fmt(amount, sym)} под ${pct(this.borrowRate(sym))} годовых.`);
        return amount;
      });
    }

    repay(payerId, sym, amount, onBehalfId = payerId) {
      return this._tx(() => {
        const repaid = this._repay(payerId, sym, amount, onBehalfId);
        const p = this._user(payerId);
        this._note(`${p.name}: погашение ${fmt(repaid, sym)}.`);
        return repaid;
      });
    }

    _repay(payerId, sym, amount, onBehalfId) {
      const m = this._market(sym);
      const payer = this._user(payerId);
      const borrower = this._user(onBehalfId);
      const debt = this.borrowBalance(sym, onBehalfId);
      if (debt <= 0) throw new BankError("NoDebt");
      amount = amount === "max" ? debt : Number(amount);
      if (!(amount > 0)) throw new BankError("ZeroAmount");
      if (amount > debt) amount = debt;
      if (payer.wallet[sym] + 1e-9 < amount) throw new BankError("WalletBalance");
      const shares = amount >= debt ? borrower.bor[sym] : (amount * m.borrowShares) / m.totalBorrows;
      borrower.bor[sym] -= shares;
      m.borrowShares -= shares;
      m.totalBorrows = Math.max(0, m.totalBorrows - amount);
      payer.wallet[sym] -= amount;
      return amount;
    }

    liquidate(liquidatorId, borrowerId, debtSym, collSym, repayAmount) {
      return this._tx(() => {
        if (this.accountData(borrowerId).healthFactor >= 1) throw new BankError("AccountHealthy");
        const dm = this._market(debtSym);
        const cm = this._market(collSym);
        const maxRepay = this.borrowBalance(debtSym, borrowerId) * CLOSE_FACTOR;
        repayAmount = Math.min(Number(repayAmount), maxRepay);
        if (!(repayAmount > 0)) throw new BankError("ZeroAmount");

        let seize = ((repayAmount * dm.price) * (1 + cm.bonus)) / cm.price;
        const collBalance = this.depositBalance(collSym, borrowerId);
        if (seize > collBalance) {
          seize = collBalance;
          repayAmount = (collBalance * cm.price) / (1 + cm.bonus) / dm.price;
        }
        this._repay(liquidatorId, debtSym, repayAmount, borrowerId);
        // Как в контракте: свободный залог проверяем до списания
        if (seize > this.cash(collSym) + 1e-9) throw new BankError("InsufficientLiquidity");

        const b = this._user(borrowerId);
        const seizeShares = seize >= collBalance ? b.dep[collSym] : (seize * cm.depositShares) / cm.totalDeposits;
        b.dep[collSym] -= seizeShares;
        cm.depositShares -= seizeShares;
        cm.totalDeposits -= seize;
        this._user(liquidatorId).wallet[collSym] += seize;

        const profit = seize * cm.price - repayAmount * dm.price;
        this._note(
          `Ликвидация: ${this._user(liquidatorId).name} погасил ${fmt(repayAmount, debtSym)} долга клиента «${b.name}» ` +
            `и забрал ${fmt(seize, collSym)} залога (прибыль ${usd(profit)}).`,
          "alert"
        );
        return { repaid: repayAmount, seized: seize, profit };
      });
    }

    /** Бот проходит по всем клиентам и ликвидирует тех, у кого health factor < 1. */
    runLiquidator(liquidatorId = "liquidator") {
      const results = [];
      for (const id of Object.keys(this.users)) {
        if (id === liquidatorId) continue;
        // Пока счёт нездоров, гасим самый крупный долг за счёт самого крупного залога
        for (let round = 0; round < 6 && this.accountData(id).healthFactor < 1; round++) {
          const ms = Object.values(this.markets);
          const debt = ms
            .map((m) => ({ m, v: this.borrowBalance(m.symbol, id) * m.price }))
            .sort((a, b) => b.v - a.v)[0];
          const coll = ms
            .map((m) => ({ m, v: this.depositBalance(m.symbol, id) * m.price }))
            .sort((a, b) => b.v - a.v)[0];
          if (!debt || debt.v <= 0 || !coll || coll.v <= 0) break;
          const r = this.liquidate(liquidatorId, id, debt.m.symbol, coll.m.symbol, Infinity);
          results.push({ user: this.users[id].name, ...r, debtSym: debt.m.symbol, collSym: coll.m.symbol });
        }
        const a = this.accountData(id);
        if (a.debtValue > 0.01 && a.collateralValue < 0.01) {
          this._note(
            `У клиента «${this.users[id].name}» залог закончился, а долг ${usd(a.debtValue)} остался. ` +
              "Это безнадёжный долг (bad debt) — его покрывают вкладчики.",
            "alert"
          );
        }
      }
      if (!results.length) this._note("Бот-ликвидатор проверил счета: все в порядке.", "info");
      return results;
    }

    // ------------------------------------------------------------ админ

    setPrice(sym, price) {
      price = Number(price);
      if (!(price > 0)) throw new BankError("ZeroAmount");
      const m = this._market(sym);
      const old = m.price;
      m.price = price;
      if (Math.abs(old - price) / old > 0.001) this._note(`Цена ${sym}: ${usd(old)} → ${usd(price)}.`, "price");
    }

    withdrawReserves(sym, amount = "max") {
      return this._tx(() => {
        const m = this._market(sym);
        amount = amount === "max" ? Math.min(m.reserves, this.cash(sym)) : Number(amount);
        if (!(amount > 0)) throw new BankError("ZeroAmount");
        if (amount > m.reserves + 1e-12) throw new BankError("InsufficientBalance");
        if (amount > this.cash(sym) + 1e-9) throw new BankError("InsufficientLiquidity");
        m.reserves -= amount;
        this.treasury[sym] += amount;
        this._note(`Банк перевёл ${fmt(amount, sym)} прибыли в казну.`, "bank");
        return amount;
      });
    }

    // ------------------------------------------------------------ снимок для интерфейса

    getState(id = "you") {
      const u = this._user(id);
      const markets = Object.values(this.markets).map((m) => {
        const util = utilization(m);
        return {
          symbol: m.symbol, name: m.name, decimals: m.decimals, price: m.price,
          ltv: m.ltv, lt: m.lt, bonus: m.bonus, rf: m.rf, rate: { ...m.rate },
          utilization: util,
          borrowRate: borrowRateAt(m.rate, util),
          supplyRate: supplyRateAt(m.rate, m.rf, util),
          totalDeposits: m.totalDeposits,
          totalBorrows: m.totalBorrows,
          reserves: m.reserves,
          cash: m.totalDeposits + m.reserves - m.totalBorrows,
          wallet: u.wallet[m.symbol],
          deposited: this.depositBalance(m.symbol, id),
          borrowed: this.borrowBalance(m.symbol, id),
          treasury: this.treasury[m.symbol],
        };
      });
      return {
        mode: "demo",
        userLabel: u.name,
        day: Math.floor(this.time / DAY),
        markets,
        account: this.accountData(id),
        others: Object.values(this.users)
          .filter((x) => x.id !== id && x.id !== "liquidator")
          .map((x) => ({ name: x.name, account: this.accountData(x.id) })),
        log: this.log.slice(),
        isOwner: true,
      };
    }
  }

  // ---------------------------------------------------------- форматирование

  function fmt(n, sym) {
    const digits = sym === "WETH" ? 4 : 2;
    return `${Number(n).toLocaleString("ru-RU", { maximumFractionDigits: digits, minimumFractionDigits: 0 })} ${sym}`;
  }
  function usd(n) {
    return "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  }
  function pct(r) {
    return (r * 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + "%";
  }

  const api = {
    SimBank, BankError, ERRORS_RU, MARKET_CONFIG, CLOSE_FACTOR, YEAR, DAY,
    utilization, borrowRateAt, supplyRateAt, computeAccount, fmt, usd, pct,
  };
  root.MyBankSim = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
