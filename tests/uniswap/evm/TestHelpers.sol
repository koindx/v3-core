// SPDX-License-Identifier: GPL-3.0
pragma solidity =0.7.6;

// Test helpers for the Uniswap v3 reference pool (the bytecode published in @uniswap/v3-core) run
// in an EVM: an ERC20 token and a contract that mints, swaps and flashes with the callbacks,
// paying with the tokens of the account that calls it (equivalent of TestUniswapV3Callee)

interface IPool {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function mint(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount,
        bytes calldata data
    ) external returns (uint256 amount0, uint256 amount1);

    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);

    function flash(
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external;
}

contract TestToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(uint256 supply) {
        balanceOf[msg.sender] = supply;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 value
    ) external returns (bool) {
        require(allowance[from][msg.sender] >= value, 'insufficient allowance');
        allowance[from][msg.sender] -= value;
        _transfer(from, to, value);
        return true;
    }

    function _transfer(
        address from,
        address to,
        uint256 value
    ) private {
        require(balanceOf[from] >= value, 'insufficient balance');
        balanceOf[from] -= value;
        require(balanceOf[to] + value >= balanceOf[to], 'balance overflow');
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

contract TestCallee {
    event SwapCallback(int256 amount0Delta, int256 amount1Delta);
    event MintCallback(uint256 amount0Owed, uint256 amount1Owed);
    event FlashCallback(uint256 fee0, uint256 fee1);

    function swap(
        address pool,
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96
    ) external returns (int256 amount0, int256 amount1) {
        return IPool(pool).swap(recipient, zeroForOne, amountSpecified, sqrtPriceLimitX96, abi.encode(msg.sender, 0, 0));
    }

    function mint(
        address pool,
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount
    ) external returns (uint256 amount0, uint256 amount1) {
        return IPool(pool).mint(recipient, tickLower, tickUpper, amount, abi.encode(msg.sender, 0, 0));
    }

    function flash(
        address pool,
        address recipient,
        uint256 amount0,
        uint256 amount1,
        uint256 pay0,
        uint256 pay1
    ) external {
        IPool(pool).flash(recipient, amount0, amount1, abi.encode(msg.sender, pay0, pay1));
    }

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        emit SwapCallback(amount0Delta, amount1Delta);
        (address payer, , ) = abi.decode(data, (address, uint256, uint256));
        if (amount0Delta > 0) _pay(IPool(msg.sender).token0(), payer, uint256(amount0Delta));
        else if (amount1Delta > 0) _pay(IPool(msg.sender).token1(), payer, uint256(amount1Delta));
    }

    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external {
        emit MintCallback(amount0Owed, amount1Owed);
        (address payer, , ) = abi.decode(data, (address, uint256, uint256));
        if (amount0Owed > 0) _pay(IPool(msg.sender).token0(), payer, amount0Owed);
        if (amount1Owed > 0) _pay(IPool(msg.sender).token1(), payer, amount1Owed);
    }

    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external {
        emit FlashCallback(fee0, fee1);
        (address payer, uint256 pay0, uint256 pay1) = abi.decode(data, (address, uint256, uint256));
        if (pay0 > 0) _pay(IPool(msg.sender).token0(), payer, pay0);
        if (pay1 > 0) _pay(IPool(msg.sender).token1(), payer, pay1);
    }

    function _pay(
        address token,
        address payer,
        uint256 value
    ) private {
        require(TestToken(token).transferFrom(payer, msg.sender, value), 'transfer failed');
    }
}
