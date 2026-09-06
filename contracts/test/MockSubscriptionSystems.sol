// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockSubscriptionRegistry {
    struct Agent { address owner; address gateway; address payee; bool active; bytes32 schemaId; uint8 paymentModes; }
    mapping(uint256 => Agent) public agents;

    function setAgent(uint256 id, address payee, address owner, bool active, bytes32 schemaId, uint8 paymentModes) external {
        agents[id] = Agent(owner, address(0), payee, active, schemaId, paymentModes);
    }

    function getAgent(uint256 id)
        external
        view
        returns (address, address, address, bool, bytes32, string memory, bytes32, uint8, uint64)
    {
        Agent memory a = agents[id];
        return (a.owner, a.gateway, a.payee, a.active, bytes32(uint256(1)), "mock", a.schemaId, a.paymentModes, 1);
    }
}

contract MockHts {
    int64 public associationCode = 22;
    uint256 public transferCalls;
    uint256 public failingTransfer;
    int64 public transferFailureCode;
    uint256 public transferCreditBps = 10_000;
    mapping(address => mapping(address => uint256)) private balances;
    mapping(address => mapping(address => mapping(address => uint256))) private allowances;

    function setAssociationCode(int64 code) external { associationCode = code; }
    function failTransferAt(uint256 callNumber, int64 code) external { failingTransfer = callNumber; transferFailureCode = code; }
    function setTransferCreditBps(uint256 value) external { transferCreditBps = value; }
    function mint(address token, address account, uint256 amount) external { balances[token][account] += amount; }
    function approve(address token, address owner, address spender, uint256 amount) external { allowances[token][owner][spender] = amount; }
    function balanceOf(address token, address account) external view returns (uint256) { return balances[token][account]; }
    function allowance(address token, address owner, address spender) external view returns (int64, uint256) {
        return (22, allowances[token][owner][spender]);
    }
    function associateToken(address, address) external view returns (int64) { return associationCode; }

    function transferFrom(address token, address from, address to, uint256 amount) external returns (int64) {
        transferCalls++;
        if (transferCalls == failingTransfer) return transferFailureCode;
        uint256 approved = allowances[token][from][msg.sender];
        if (approved < amount || balances[token][from] < amount) return 293;
        allowances[token][from][msg.sender] = approved - amount;
        balances[token][from] -= amount;
        balances[token][to] += amount * transferCreditBps / 10_000;
        return 22;
    }

    function transferToken(address token, address from, address to, int64 signedAmount) external returns (int64) {
        transferCalls++;
        if (transferCalls == failingTransfer) return transferFailureCode;
        if (signedAmount < 0) return 17;
        uint256 amount = uint64(signedAmount);
        if (balances[token][from] < amount) return 17;
        balances[token][from] -= amount;
        balances[token][to] += amount * transferCreditBps / 10_000;
        return 22;
    }
}

contract MockHtsToken {
    MockHts private immutable hts;
    constructor(address hts_) { hts = MockHts(hts_); }
    function balanceOf(address account) external view returns (uint256) { return hts.balanceOf(address(this), account); }
}

contract MockScheduleService {
    int64 public scheduleCode = 22;
    uint256 public nonce;
    address public lastTo;
    uint256 public lastExpirySecond;
    uint256 public lastGasLimit;
    uint64 public lastValue;
    bytes32 public lastCallDataHash;

    receive() external payable {}

    function setScheduleCode(int64 code) external { scheduleCode = code; }
    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes calldata callData) external returns (int64, address) {
        lastTo = to;
        lastExpirySecond = expirySecond;
        lastGasLimit = gasLimit;
        lastValue = value;
        lastCallDataHash = keccak256(callData);
        if (scheduleCode != 22) return (scheduleCode, address(0));
        nonce++;
        return (22, address(uint160(nonce)));
    }
    function deleteSchedule(address) external pure returns (int64) { return 22; }
    function execute(address target, bytes calldata data) external {
        (bool success, bytes memory result) = target.call(data);
        if (!success) assembly { revert(add(result, 32), mload(result)) }
    }
}

interface ISubscriptionBuyerActions {
    function createSubscription(bytes32, uint256, uint64, uint64, uint256, uint256, uint64, uint256) external payable returns (address);
}

interface ISubscriptionEscrowActions {
    function cancelTo(address payable) external;
}

contract MockRejectingBuyer {
    receive() external payable { revert("reject_hbar"); }
    function create(address factory, bytes32 id, uint64 start, uint64 end, uint256 rate, uint256 deposit, uint64 interval, uint256 gasLimit)
        external payable returns (address)
    {
        return ISubscriptionBuyerActions(factory).createSubscription{value: msg.value}(id, 1, start, end, rate, deposit, interval, gasLimit);
    }
    function cancelTo(address escrow, address payable recipient) external { ISubscriptionEscrowActions(escrow).cancelTo(recipient); }
}

contract MockSubscriptionEntitlement {
    bytes32 public configuredId;
    uint256 public agentId;
    address public buyer;
    address public provider;
    bool public entitled;

    function configure(bytes32 id, uint256 agent, address subscriber, address payee, bool value) external {
        configuredId = id;
        agentId = agent;
        buyer = subscriber;
        provider = payee;
        entitled = value;
    }

    function setEntitled(bool value) external { entitled = value; }
    function subscriptionEscrow(bytes32 id) external view returns (address) { return id == configuredId ? address(this) : address(0); }
    function isEntitled(address account) external view returns (bool) { return entitled && account == buyer; }
}

interface ICheckpointEscrow {
    function checkpoint() external returns (uint256);
    function claim() external returns (uint256);
}

contract MockCheckpointCaller {
    function callTwice(address escrow) external returns (uint256 first, uint256 second) {
        first = ICheckpointEscrow(escrow).checkpoint();
        second = ICheckpointEscrow(escrow).claim();
    }
}
