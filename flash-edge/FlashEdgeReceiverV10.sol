// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IAavePool {
    function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external;
}

interface IV2Router {
    function factory() external view returns (address);
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts);
}

interface IPair {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IUniV3Pool is IPair {
    function fee() external view returns (uint24);
}

interface IUniV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IUniV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IAeroPool is IPair {
    function stable() external view returns (bool);
}

interface IAeroRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, Route[] calldata routes, address to, uint256 deadline) external returns (uint256[] memory amounts);
}

interface IAeroCLPool is IPair {
    function tickSpacing() external view returns (int24);
}

interface IAeroCLFactory {
    function getPool(address tokenA, address tokenB, int24 tickSpacing) external view returns (address);
}

interface IAeroCLRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IFactoryRegistry {
    function isPoolFactoryApproved(address) external view returns (bool);
}

contract FlashEdgeReceiverV10 {
    uint8 private constant V2 = 0;
    uint8 private constant UNI_V3 = 1;
    uint8 private constant AERO_CLASSIC = 2;
    uint8 private constant AERO_CL = 3;

    // The contract requires positive realized USDC profit. The Vercel worker
    // sets a stronger per-trade minProfit only after gas/slippage/safety accounting.
    uint256 private constant MIN_POSITIVE_PROFIT_RAW = 1;
    uint256 private constant HARD_MAX_BORROW = 250_000_000_000; // 250,000 USDC

    address public constant authorizedQuote = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant aavePool = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address public constant uniV2Router = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address public constant sushiV2Router = 0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891;
    address public constant uniV3Factory = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address public constant uniV3Router = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address public constant aeroFactoryRegistry = 0x5C3F18F06CC09CA1910767A34a20F771039E37C0;
    address public constant aeroClassicFactory = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    address public constant aeroClassicRouter = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address public constant aeroClFactory = 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;
    address public constant aeroClRouter = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;

    struct Leg {
        uint8 kind;
        uint8 venue;
        address pair;
        address tokenIn;
        address tokenOut;
        uint24 fee;
        int24 tickSpacing;
        bool stable;
        uint256 minOut;
    }

    struct Plan {
        address quoteToken;
        uint256 borrow;
        uint256 minProfit;
        uint64 deadline;
        Leg buy;
        Leg sell;
    }

    address public owner;
    address public pendingOwner;
    uint256 public maxBorrowRaw = 10_000_000_000; // 10,000 USDC default
    bool public paused;

    bool private entered;
    bool private active;
    uint256 private startBalance;

    event ArbitrageExecuted(address indexed owner, address indexed quote, uint256 borrow, uint256 profit);
    event Paused(bool value);
    event MaxBorrowSet(uint256 value);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "OWNER");
        _;
    }

    modifier noReentry() {
        require(!entered, "REENTRANCY");
        entered = true;
        _;
        entered = false;
    }

    constructor(address _owner) {
        require(_owner != address(0), "ZERO");
        owner = _owner;
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit Paused(value);
    }

    function setMaxBorrowRaw(uint256 value) external onlyOwner {
        require(value >= 1_000_000_000 && value <= HARD_MAX_BORROW, "BORROW_POLICY");
        maxBorrowRaw = value;
        emit MaxBorrowSet(value);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "PENDING");
        address oldOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(oldOwner, msg.sender);
    }

    function executeArbitrage(Plan calldata p) external onlyOwner noReentry {
        require(!paused, "PAUSED");
        require(p.quoteToken == authorizedQuote, "QUOTE");
        require(p.borrow > 0 && p.borrow <= maxBorrowRaw && p.borrow <= HARD_MAX_BORROW, "BORROW");
        require(p.minProfit >= MIN_POSITIVE_PROFIT_RAW, "MIN_PROFIT");
        require(p.deadline >= block.timestamp && p.deadline <= block.timestamp + 90, "DEADLINE");
        require(
            p.buy.tokenIn == p.quoteToken &&
            p.sell.tokenOut == p.quoteToken &&
            p.buy.tokenOut == p.sell.tokenIn,
            "PATH"
        );
        require(p.buy.minOut > 0 && p.sell.minOut > 0, "MINOUT");

        _validate(p.buy);
        _validate(p.sell);

        active = true;
        startBalance = IERC20(p.quoteToken).balanceOf(address(this));
        IAavePool(aavePool).flashLoanSimple(address(this), p.quoteToken, p.borrow, abi.encode(p), 0);
        active = false;

        uint256 endBalance = IERC20(p.quoteToken).balanceOf(address(this));
        require(endBalance >= startBalance + p.minProfit, "POST_PROFIT");
        uint256 profit = endBalance - startBalance;
        _safeTransfer(p.quoteToken, owner, profit);
        emit ArbitrageExecuted(owner, p.quoteToken, p.borrow, profit);
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == aavePool && initiator == address(this) && active, "AAVE");

        Plan memory p = abi.decode(params, (Plan));
        require(asset == authorizedQuote && asset == p.quoteToken && amount == p.borrow, "LOAN");

        uint256 mid = _swap(p.buy, amount, p.deadline);
        require(mid >= p.buy.minOut, "BUY_MIN");

        uint256 out = _swap(p.sell, mid, p.deadline);
        require(out >= p.sell.minOut, "SELL_MIN");

        uint256 balance = IERC20(asset).balanceOf(address(this));
        require(balance >= startBalance + amount + premium + p.minProfit, "NET_PROFIT");

        _forceApprove(asset, aavePool, amount + premium);
        return true;
    }

    function _tokens(address pair, address a, address b) internal view returns (bool) {
        address token0 = IPair(pair).token0();
        address token1 = IPair(pair).token1();
        return (a == token0 && b == token1) || (a == token1 && b == token0);
    }

    function _validate(Leg memory leg) internal view {
        require(leg.pair != address(0) && _tokens(leg.pair, leg.tokenIn, leg.tokenOut), "PAIR");

        if (leg.kind == V2) {
            address router = leg.venue == 1 ? sushiV2Router : uniV2Router;
            require(IPair(leg.pair).factory() == IV2Router(router).factory(), "V2_FACTORY");
        } else if (leg.kind == UNI_V3) {
            require(
                IUniV3Pool(leg.pair).factory() == uniV3Factory &&
                IUniV3Pool(leg.pair).fee() == leg.fee &&
                IUniV3Factory(uniV3Factory).getPool(leg.tokenIn, leg.tokenOut, leg.fee) == leg.pair,
                "V3_POOL"
            );
        } else if (leg.kind == AERO_CLASSIC) {
            require(
                IPair(leg.pair).factory() == aeroClassicFactory &&
                IAeroPool(leg.pair).stable() == leg.stable,
                "AERO_POOL"
            );
        } else if (leg.kind == AERO_CL) {
            require(
                IFactoryRegistry(aeroFactoryRegistry).isPoolFactoryApproved(aeroClFactory) &&
                IPair(leg.pair).factory() == aeroClFactory &&
                IAeroCLPool(leg.pair).tickSpacing() == leg.tickSpacing &&
                IAeroCLFactory(aeroClFactory).getPool(leg.tokenIn, leg.tokenOut, leg.tickSpacing) == leg.pair,
                "AERO_CL_POOL"
            );
        } else {
            revert("KIND");
        }
    }

    function _swap(Leg memory leg, uint256 amountIn, uint256 deadline) internal returns (uint256 out) {
        if (leg.kind == V2) {
            address router = leg.venue == 1 ? sushiV2Router : uniV2Router;
            _forceApprove(leg.tokenIn, router, amountIn);
            address[] memory path = new address[](2);
            path[0] = leg.tokenIn;
            path[1] = leg.tokenOut;
            uint256[] memory amounts = IV2Router(router).swapExactTokensForTokens(
                amountIn,
                leg.minOut,
                path,
                address(this),
                deadline
            );
            out = amounts[amounts.length - 1];
            _forceApprove(leg.tokenIn, router, 0);
        } else if (leg.kind == UNI_V3) {
            _forceApprove(leg.tokenIn, uniV3Router, amountIn);
            out = IUniV3Router(uniV3Router).exactInputSingle(
                IUniV3Router.ExactInputSingleParams({
                    tokenIn: leg.tokenIn,
                    tokenOut: leg.tokenOut,
                    fee: leg.fee,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: leg.minOut,
                    sqrtPriceLimitX96: 0
                })
            );
            _forceApprove(leg.tokenIn, uniV3Router, 0);
        } else if (leg.kind == AERO_CLASSIC) {
            _forceApprove(leg.tokenIn, aeroClassicRouter, amountIn);
            IAeroRouter.Route[] memory routes = new IAeroRouter.Route[](1);
            routes[0] = IAeroRouter.Route({
                from: leg.tokenIn,
                to: leg.tokenOut,
                stable: leg.stable,
                factory: aeroClassicFactory
            });
            uint256[] memory amounts = IAeroRouter(aeroClassicRouter).swapExactTokensForTokens(
                amountIn,
                leg.minOut,
                routes,
                address(this),
                deadline
            );
            out = amounts[amounts.length - 1];
            _forceApprove(leg.tokenIn, aeroClassicRouter, 0);
        } else if (leg.kind == AERO_CL) {
            _forceApprove(leg.tokenIn, aeroClRouter, amountIn);
            out = IAeroCLRouter(aeroClRouter).exactInputSingle(
                IAeroCLRouter.ExactInputSingleParams({
                    tokenIn: leg.tokenIn,
                    tokenOut: leg.tokenOut,
                    tickSpacing: leg.tickSpacing,
                    recipient: address(this),
                    deadline: deadline,
                    amountIn: amountIn,
                    amountOutMinimum: leg.minOut,
                    sqrtPriceLimitX96: 0
                })
            );
            _forceApprove(leg.tokenIn, aeroClRouter, 0);
        } else {
            revert("KIND");
        }
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "ZERO");
        _safeTransfer(token, to, amount);
    }

    function _forceApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, 0));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "APPROVE0");
        if (amount > 0) {
            (ok, data) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
            require(ok && (data.length == 0 || abi.decode(data, (bool))), "APPROVE");
        }
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TRANSFER");
    }
}
