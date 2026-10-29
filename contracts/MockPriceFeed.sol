// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Поддельный фид Chainlink для тестов: цену задаёт кто угодно.
contract MockPriceFeed {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 _decimals) {
        decimals = _decimals;
    }

    /// @notice Новая цена с временем обновления «сейчас».
    function set(int256 _answer) external {
        answer = _answer;
        updatedAt = block.timestamp;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
