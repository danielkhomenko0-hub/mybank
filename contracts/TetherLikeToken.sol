// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Тестовый токен, который ведёт себя как настоящий USDT в Ethereum:
///         1) transfer / transferFrom / approve НИЧЕГО не возвращают (нарушение стандарта ERC-20);
///         2) нельзя поменять ненулевое разрешение на другое ненулевое — сначала approve(0).
///         Нужен, чтобы проверить, что банк корректно работает с такими токенами.
/// @dev mint() открыт всем — только для тестнета!
contract TetherLikeToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external {
        require(amount == 0 || allowance[msg.sender][spender] == 0, "USDT: reset allowance to 0 first");
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
    }

    function transfer(address to, uint256 amount) external {
        _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amount, "allowance");
            allowance[from][msg.sender] = a - amount;
        }
        _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
