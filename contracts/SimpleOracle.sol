// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Минимальный интерфейс фида Chainlink (AggregatorV3Interface).
interface IChainlinkFeed {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Оракул цен: для каждого актива — либо фид Chainlink, либо ручная цена владельца.
/// @dev Ручная цена нужна в тестнете, чтобы показать обвал и ликвидацию. setPrice отключает фид
///      актива, setFeed включает его обратно. В реальном продукте ручной цены быть не должно,
///      а фидов лучше несколько (медиана) плюс защита от резких скачков.
contract SimpleOracle {
    struct Feed {
        IChainlinkFeed feed;
        uint32 maxAge; // сколько секунд цена считается свежей
    }

    address public owner;
    address public pendingOwner;
    mapping(address => uint256) private prices; // ручная цена: USD за 1 целый токен, 18 знаков
    mapping(address => Feed) public feeds;

    event PriceSet(address indexed asset, uint256 price);
    event FeedSet(address indexed asset, address feed, uint32 maxAge);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotPendingOwner();
    error NoPrice();
    error BadPrice();
    error StalePrice();
    error InvalidFeed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Ручная цена. Если у актива был фид Chainlink, он отключается.
    function setPrice(address asset, uint256 price) external onlyOwner {
        if (price == 0) revert BadPrice();
        prices[asset] = price;
        if (address(feeds[asset].feed) != address(0)) {
            delete feeds[asset];
            emit FeedSet(asset, address(0), 0);
        }
        emit PriceSet(asset, price);
    }

    /// @notice Брать цену актива из фида Chainlink. Фид сразу проверяется: цена должна читаться и быть свежей.
    function setFeed(address asset, IChainlinkFeed feed, uint32 maxAge) external onlyOwner {
        if (address(feed) == address(0) || maxAge == 0 || feed.decimals() > 18) revert InvalidFeed();
        Feed memory f = Feed(feed, maxAge);
        _feedPrice(f);
        feeds[asset] = f;
        emit FeedSet(asset, address(feed), maxAge);
    }

    function getPrice(address asset) external view returns (uint256 p) {
        Feed memory f = feeds[asset];
        if (address(f.feed) != address(0)) return _feedPrice(f);
        p = prices[asset];
        if (p == 0) revert NoPrice();
    }

    /// @notice Откуда берётся цена: true — Chainlink, false — вручную.
    function usesFeed(address asset) external view returns (bool) {
        return address(feeds[asset].feed) != address(0);
    }

    /// @dev Устаревшая или нулевая цена хуже, чем никакой: операции с активом откатываются.
    function _feedPrice(Feed memory f) private view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = f.feed.latestRoundData();
        if (answer <= 0) revert BadPrice();
        if (block.timestamp > updatedAt + f.maxAge) revert StalePrice();
        return uint256(answer) * 10 ** (18 - f.feed.decimals());
    }

    // ---------------------------------------------------------------- владелец

    /// @notice Передача в два шага: новый владелец должен сам подтвердить, что адрес верный.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
