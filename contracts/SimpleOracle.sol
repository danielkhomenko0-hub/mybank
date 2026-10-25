// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Оракул цен для тестов и тестнета: цену задаёт владелец вручную.
/// @dev В реальном продукте сюда подключается Chainlink (или несколько источников с медианой).
contract SimpleOracle {
    address public owner;
    mapping(address => uint256) private prices; // USD за 1 целый токен, 18 знаков

    event PriceSet(address indexed asset, uint256 price);

    constructor() {
        owner = msg.sender;
    }

    function setPrice(address asset, uint256 price) external {
        require(msg.sender == owner, "not owner");
        require(price > 0, "zero price");
        prices[asset] = price;
        emit PriceSet(asset, price);
    }

    function getPrice(address asset) external view returns (uint256 p) {
        p = prices[asset];
        require(p > 0, "no price");
    }
}
