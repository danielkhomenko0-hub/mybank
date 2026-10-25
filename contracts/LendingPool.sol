// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title LendingPool — ядро прототипа децентрализованного банка
/// @notice Депозиты под процент, займы под залог, процентная ставка от загрузки пула,
///         ликвидации и резервы протокола (доход "банка").
/// @dev УЧЕБНЫЙ ПРОТОТИП. Не проходил аудит. Не деплоить в mainnet с реальными деньгами.

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IPriceOracle {
    /// @return цена 1 целого токена в USD, 18 знаков (WAD)
    function getPrice(address asset) external view returns (uint256);
}

contract LendingPool {
    // ---------------------------------------------------------------- константы
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;
    uint256 private constant YEAR = 365 days;
    uint256 public constant CLOSE_FACTOR_BPS = 5_000; // за одну ликвидацию можно погасить до 50% долга
    uint256 public constant MAX_MARKETS = 10;

    // ---------------------------------------------------------------- типы
    /// @notice Модель ставки "с изломом": дёшево, пока в пуле много свободных денег,
    ///         резко дороже, когда загрузка выше kink (стимул вернуть ликвидность).
    struct RateModel {
        uint64 baseRate; // годовая ставка при нулевой загрузке, WAD
        uint64 slope1;   // прирост ставки от 0 до kink, WAD
        uint64 slope2;   // прирост ставки от kink до 100%, WAD
        uint64 kink;     // оптимальная загрузка, WAD (например 0.8e18)
    }

    struct Market {
        bool listed;
        uint8 decimals;
        uint16 ltvBps;           // сколько можно занять под этот залог (7500 = 75%)
        uint16 liqThresholdBps;  // порог ликвидации (8000 = 80%)
        uint16 liqBonusBps;      // бонус ликвидатору (500 = 5%)
        uint16 reserveFactorBps; // доля процентов, которая идёт банку (1000 = 10%)
        uint40 lastAccrual;
        uint256 totalDeposits;      // сколько должны вкладчикам (растёт с процентами)
        uint256 totalDepositShares;
        uint256 totalBorrows;       // сколько должны заёмщики (растёт с процентами)
        uint256 totalBorrowShares;
        uint256 reserves;           // заработок протокола
        RateModel rate;
    }

    struct AccountData {
        uint256 collateralValue;     // USD, WAD
        uint256 borrowLimit;         // USD, WAD (по LTV)
        uint256 liquidationLimit;    // USD, WAD (по порогу ликвидации)
        uint256 debtValue;           // USD, WAD
        uint256 healthFactor;        // WAD; < 1e18 => можно ликвидировать
    }

    // ---------------------------------------------------------------- состояние
    address public owner;
    IPriceOracle public oracle;
    address[] public marketList;
    mapping(address => Market) public markets;
    mapping(address => mapping(address => uint256)) public depositShares; // asset => user => shares
    mapping(address => mapping(address => uint256)) public borrowShares;  // asset => user => shares
    uint256 private _locked = 1;

    // ---------------------------------------------------------------- события
    event MarketListed(address indexed asset);
    event Deposit(address indexed asset, address indexed user, uint256 amount, uint256 shares);
    event Withdraw(address indexed asset, address indexed user, uint256 amount, uint256 shares);
    event Borrow(address indexed asset, address indexed user, uint256 amount, uint256 shares);
    event Repay(address indexed asset, address indexed payer, address indexed onBehalfOf, uint256 amount);
    event Liquidate(
        address indexed liquidator,
        address indexed borrower,
        address debtAsset,
        address collateralAsset,
        uint256 repaid,
        uint256 seized
    );
    event ReservesWithdrawn(address indexed asset, address indexed to, uint256 amount);

    // ---------------------------------------------------------------- ошибки
    error NotOwner();
    error Reentrancy();
    error MarketNotListed();
    error InvalidParams();
    error ZeroAmount();
    error InsufficientLiquidity();
    error InsufficientBalance();
    error InsufficientCollateral();
    error AccountHealthy();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    modifier listed(address asset) {
        if (!markets[asset].listed) revert MarketNotListed();
        _;
    }

    constructor(IPriceOracle _oracle) {
        owner = msg.sender;
        oracle = _oracle;
    }

    // ================================================================ админ

    function listMarket(
        address asset,
        uint16 ltvBps,
        uint16 liqThresholdBps,
        uint16 liqBonusBps,
        uint16 reserveFactorBps,
        RateModel calldata rate
    ) external onlyOwner {
        if (markets[asset].listed || marketList.length >= MAX_MARKETS) revert InvalidParams();
        _checkRiskParams(ltvBps, liqThresholdBps, liqBonusBps, reserveFactorBps, rate);

        Market storage m = markets[asset];
        m.listed = true;
        m.decimals = IERC20(asset).decimals();
        m.ltvBps = ltvBps;
        m.liqThresholdBps = liqThresholdBps;
        m.liqBonusBps = liqBonusBps;
        m.reserveFactorBps = reserveFactorBps;
        m.lastAccrual = uint40(block.timestamp);
        m.rate = rate;
        marketList.push(asset);
        emit MarketListed(asset);
    }

    /// @notice Банк забирает свою прибыль (резервы) в казну.
    function withdrawReserves(address asset, uint256 amount, address to)
        external
        onlyOwner
        nonReentrant
        listed(asset)
    {
        _accrue(asset);
        Market storage m = markets[asset];
        if (amount > m.reserves) revert InsufficientBalance();
        if (amount > _cash(m)) revert InsufficientLiquidity();
        m.reserves -= amount;
        _safeTransfer(asset, to, amount);
        emit ReservesWithdrawn(asset, to, amount);
    }

    function _checkRiskParams(
        uint16 ltvBps,
        uint16 liqThresholdBps,
        uint16 liqBonusBps,
        uint16 reserveFactorBps,
        RateModel calldata rate
    ) private pure {
        // LTV < порог ликвидации, а порог * (1 + бонус) <= 100%,
        // иначе ликвидатору не хватит залога на бонус.
        if (ltvBps == 0 || ltvBps >= liqThresholdBps) revert InvalidParams();
        if (uint256(liqThresholdBps) * (BPS + liqBonusBps) / BPS > BPS) revert InvalidParams();
        if (reserveFactorBps > 5_000) revert InvalidParams();
        if (rate.kink == 0 || rate.kink >= WAD) revert InvalidParams();
    }

    // ================================================================ пользователи

    /// @notice Положить деньги в банк и получать процент.
    function deposit(address asset, uint256 amount) external nonReentrant listed(asset) {
        if (amount == 0) revert ZeroAmount();
        _accrue(asset);
        Market storage m = markets[asset];

        uint256 shares = m.totalDepositShares == 0
            ? amount
            : amount * m.totalDepositShares / m.totalDeposits; // округляем в пользу пула
        if (shares == 0) revert ZeroAmount();

        m.totalDeposits += amount;
        m.totalDepositShares += shares;
        depositShares[asset][msg.sender] += shares;

        _safeTransferFrom(asset, msg.sender, address(this), amount);
        emit Deposit(asset, msg.sender, amount, shares);
    }

    /// @notice Снять депозит. amount = type(uint256).max — снять всё.
    function withdraw(address asset, uint256 amount) external nonReentrant listed(asset) {
        _accrueAll();
        Market storage m = markets[asset];
        uint256 userShares = depositShares[asset][msg.sender];
        if (userShares == 0) revert InsufficientBalance();

        uint256 shares;
        if (amount == type(uint256).max) {
            shares = userShares;
            amount = _toAmountDown(shares, m.totalDeposits, m.totalDepositShares);
        } else {
            shares = _mulDivUp(amount, m.totalDepositShares, m.totalDeposits);
        }
        if (amount == 0 || shares == 0) revert ZeroAmount();
        if (shares > userShares) revert InsufficientBalance();
        if (amount > _cash(m)) revert InsufficientLiquidity();

        depositShares[asset][msg.sender] = userShares - shares;
        m.totalDepositShares -= shares;
        m.totalDeposits -= amount;

        // После снятия залога счёт не должен попасть под ликвидацию.
        if (_accountData(msg.sender).healthFactor < WAD) revert InsufficientCollateral();

        _safeTransfer(asset, msg.sender, amount);
        emit Withdraw(asset, msg.sender, amount, shares);
    }

    /// @notice Взять кредит под залог своих депозитов.
    function borrow(address asset, uint256 amount) external nonReentrant listed(asset) {
        if (amount == 0) revert ZeroAmount();
        _accrueAll();
        Market storage m = markets[asset];
        if (amount > _cash(m)) revert InsufficientLiquidity();

        uint256 shares = m.totalBorrowShares == 0
            ? amount
            : _mulDivUp(amount, m.totalBorrowShares, m.totalBorrows); // долг округляем вверх

        m.totalBorrows += amount;
        m.totalBorrowShares += shares;
        borrowShares[asset][msg.sender] += shares;

        AccountData memory a = _accountData(msg.sender);
        if (a.debtValue > a.borrowLimit) revert InsufficientCollateral();

        _safeTransfer(asset, msg.sender, amount);
        emit Borrow(asset, msg.sender, amount, shares);
    }

    /// @notice Погасить кредит (свой или чужой). amount = type(uint256).max — погасить всё.
    function repay(address asset, uint256 amount, address onBehalfOf)
        external
        nonReentrant
        listed(asset)
        returns (uint256 repaid)
    {
        _accrue(asset);
        repaid = _repay(asset, amount, msg.sender, onBehalfOf);
    }

    /// @notice Ликвидация: если health factor < 1, любой может погасить часть долга
    ///         и забрать залог со скидкой (бонусом).
    function liquidate(address borrower, address debtAsset, address collateralAsset, uint256 repayAmount)
        external
        nonReentrant
        listed(debtAsset)
        listed(collateralAsset)
    {
        _accrueAll();
        if (_accountData(borrower).healthFactor >= WAD) revert AccountHealthy();

        uint256 maxRepay = borrowBalance(debtAsset, borrower) * CLOSE_FACTOR_BPS / BPS;
        if (repayAmount > maxRepay) repayAmount = maxRepay;
        if (repayAmount == 0) revert ZeroAmount();

        Market storage dm = markets[debtAsset];
        Market storage cm = markets[collateralAsset];
        uint256 debtPrice = oracle.getPrice(debtAsset);
        uint256 collPrice = oracle.getPrice(collateralAsset);

        // Сколько залога отдать: стоимость погашенного долга + бонус
        uint256 seize = repayAmount * debtPrice / (10 ** dm.decimals) // -> USD
            * (BPS + cm.liqBonusBps) / BPS
            * (10 ** cm.decimals) / collPrice;

        uint256 collBalance = depositBalance(collateralAsset, borrower);
        if (seize > collBalance) {
            // Залога не хватает — уменьшаем погашение пропорционально
            seize = collBalance;
            repayAmount = collBalance * collPrice / (10 ** cm.decimals)
                * BPS / (BPS + cm.liqBonusBps)
                * (10 ** dm.decimals) / debtPrice;
            if (repayAmount == 0) revert ZeroAmount();
        }

        _repay(debtAsset, repayAmount, msg.sender, borrower);

        // Списываем залог у заёмщика
        uint256 seizeShares = seize == collBalance
            ? depositShares[collateralAsset][borrower]
            : _mulDivUp(seize, cm.totalDepositShares, cm.totalDeposits);
        depositShares[collateralAsset][borrower] -= seizeShares;
        cm.totalDepositShares -= seizeShares;
        cm.totalDeposits -= seize;
        if (seize > _cash(cm)) revert InsufficientLiquidity();

        _safeTransfer(collateralAsset, msg.sender, seize);
        emit Liquidate(msg.sender, borrower, debtAsset, collateralAsset, repayAmount, seize);
    }

    /// @notice Начислить проценты по рынку (кто угодно может вызвать, чтобы обновить балансы).
    function accrueInterest(address asset) external listed(asset) {
        _accrue(asset);
    }

    // ================================================================ просмотр

    function marketCount() external view returns (uint256) {
        return marketList.length;
    }

    function depositBalance(address asset, address user) public view returns (uint256) {
        Market storage m = markets[asset];
        return _toAmountDown(depositShares[asset][user], m.totalDeposits, m.totalDepositShares);
    }

    function borrowBalance(address asset, address user) public view returns (uint256) {
        Market storage m = markets[asset];
        uint256 s = borrowShares[asset][user];
        if (s == 0) return 0;
        return _mulDivUp(s, m.totalBorrows, m.totalBorrowShares);
    }

    /// @notice Загрузка пула: какая доля денег выдана в кредит. WAD.
    function utilization(address asset) public view returns (uint256) {
        Market storage m = markets[asset];
        uint256 total = m.totalDeposits + m.reserves;
        if (total == 0) return 0;
        uint256 u = m.totalBorrows * WAD / total;
        return u > WAD ? WAD : u;
    }

    /// @notice Годовая ставка по кредитам, WAD.
    function borrowRate(address asset) public view returns (uint256) {
        RateModel memory r = markets[asset].rate;
        uint256 u = utilization(asset);
        if (u <= r.kink) return r.baseRate + uint256(r.slope1) * u / r.kink;
        return r.baseRate + r.slope1 + uint256(r.slope2) * (u - r.kink) / (WAD - r.kink);
    }

    /// @notice Годовая ставка по депозитам, WAD.
    function supplyRate(address asset) external view returns (uint256) {
        Market storage m = markets[asset];
        return borrowRate(asset) * utilization(asset) / WAD * (BPS - m.reserveFactorBps) / BPS;
    }

    function accountData(address user) external view returns (AccountData memory) {
        return _accountData(user);
    }

    // ================================================================ внутреннее

    function _accrueAll() private {
        uint256 n = marketList.length;
        for (uint256 i; i < n; ++i) _accrue(marketList[i]);
    }

    /// @dev Начисляет проценты с прошлого вызова. Часть уходит в резервы банка.
    function _accrue(address asset) private {
        Market storage m = markets[asset];
        uint256 dt = block.timestamp - m.lastAccrual;
        if (dt == 0) return;
        if (m.totalBorrows > 0) {
            uint256 interest = m.totalBorrows * borrowRate(asset) * dt / (YEAR * WAD);
            uint256 toReserves = interest * m.reserveFactorBps / BPS;
            m.totalBorrows += interest;
            m.reserves += toReserves;
            m.totalDeposits += interest - toReserves;
        }
        m.lastAccrual = uint40(block.timestamp);
    }

    function _repay(address asset, uint256 amount, address payer, address onBehalfOf)
        private
        returns (uint256)
    {
        Market storage m = markets[asset];
        uint256 userShares = borrowShares[asset][onBehalfOf];
        uint256 debt = borrowBalance(asset, onBehalfOf);
        if (debt == 0) revert ZeroAmount();
        if (amount > debt) amount = debt;

        uint256 shares = amount == debt ? userShares : amount * m.totalBorrowShares / m.totalBorrows;

        borrowShares[asset][onBehalfOf] = userShares - shares;
        m.totalBorrowShares -= shares;
        m.totalBorrows = m.totalBorrows > amount ? m.totalBorrows - amount : 0;

        _safeTransferFrom(asset, payer, address(this), amount);
        emit Repay(asset, payer, onBehalfOf, amount);
        return amount;
    }

    function _accountData(address user) private view returns (AccountData memory a) {
        uint256 n = marketList.length;
        for (uint256 i; i < n; ++i) {
            address asset = marketList[i];
            uint256 dep = depositBalance(asset, user);
            uint256 debt = borrowBalance(asset, user);
            if (dep == 0 && debt == 0) continue;

            Market storage m = markets[asset];
            uint256 price = oracle.getPrice(asset);
            uint256 unit = 10 ** m.decimals;

            if (dep > 0) {
                uint256 v = dep * price / unit;
                a.collateralValue += v;
                a.borrowLimit += v * m.ltvBps / BPS;
                a.liquidationLimit += v * m.liqThresholdBps / BPS;
            }
            if (debt > 0) a.debtValue += _mulDivUp(debt, price, unit);
        }
        a.healthFactor = a.debtValue == 0 ? type(uint256).max : a.liquidationLimit * WAD / a.debtValue;
    }

    /// @dev Свободные деньги в пуле (без учёта "подаренных" токенов — защита от манипуляций).
    function _cash(Market storage m) private view returns (uint256) {
        return m.totalDeposits + m.reserves - m.totalBorrows;
    }

    function _toAmountDown(uint256 shares, uint256 totalAmount, uint256 totalShares)
        private
        pure
        returns (uint256)
    {
        if (totalShares == 0) return 0;
        return shares * totalAmount / totalShares;
    }

    function _mulDivUp(uint256 x, uint256 y, uint256 d) private pure returns (uint256) {
        return (x * y + d - 1) / d;
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
