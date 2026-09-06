// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ISubscriptionRegistry {
    function getAgent(uint256 agentId)
        external
        view
        returns (
            address owner,
            address gateway,
            address payee,
            bool active,
            bytes32 metadataHash,
            string memory metadataUri,
            bytes32 schemaId,
            uint8 paymentModes,
            uint64 registeredAt
        );
}

interface IHederaTokenServiceSubset {
    function associateToken(address account, address token) external returns (int64 responseCode);
    function allowance(address token, address owner, address spender) external returns (int64 responseCode, uint256 amount);
    function transferFrom(address token, address from, address to, uint256 amount) external returns (int64 responseCode);
    function transferToken(address token, address sender, address receiver, int64 amount) external returns (int64 responseCode);
}

interface IHederaScheduleService1215 {
    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes calldata callData)
        external
        returns (int64 responseCode, address scheduleAddress);
    function deleteSchedule(address scheduleAddress) external returns (int64 responseCode);
}

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
}

contract SubscriptionVault {
    int64 private constant SUCCESS = 22;
    uint8 private constant PAYMENT_MODE_SUBSCRIPTION = 2;
    uint256 public constant MAX_DURATION = 30 days;
    uint256 public constant MAX_DEPOSIT = uint256(uint64(type(int64).max));
    uint256 public constant MAX_AUTOMATION_RESERVE = 100_000_000;
    uint256 public constant MAX_SCHEDULE_GAS = 2_000_000;

    ISubscriptionRegistry public immutable registry;
    IHederaTokenServiceSubset public immutable hts;
    IHederaScheduleService1215 public immutable scheduler;
    address public immutable token;
    address public immutable admin;
    bytes32 public immutable schemaId;
    bool public paused;
    mapping(bytes32 => address) public subscriptionEscrow;

    error InvalidConfig();
    error InvalidTerms();
    error InvalidDeposit();
    error InvalidReserve();
    error DuplicateSubscription(bytes32 subscriptionId);
    error AllowanceMismatch(uint256 expected, uint256 actual);
    error HtsFailure(bytes4 operation, int64 responseCode);
    error TokenBalanceMismatch(uint256 expected, uint256 actual);
    error Paused();
    error NotAdmin();
    error UnsupportedSubscriptionAgent(uint256 agentId);

    event PausedSet(bool paused);
    event SubscriptionCreated(
        bytes32 indexed subscriptionId,
        address indexed escrow,
        address indexed buyer,
        uint256 agentId,
        address provider,
        address token,
        uint64 start,
        uint64 end,
        uint256 ratePerSecond,
        uint256 deposit,
        uint256 automationReserve
    );

    constructor(address registry_, address hts_, address scheduler_, address token_, address admin_, bytes32 schemaId_) {
        if (registry_ == address(0) || hts_ == address(0) || scheduler_ == address(0) || token_ == address(0)
            || admin_ == address(0) || schemaId_ == bytes32(0)) {
            revert InvalidConfig();
        }
        registry = ISubscriptionRegistry(registry_);
        hts = IHederaTokenServiceSubset(hts_);
        scheduler = IHederaScheduleService1215(scheduler_);
        token = token_;
        admin = admin_;
        schemaId = schemaId_;
    }

    function setPaused(bool value) external {
        if (msg.sender != admin) revert NotAdmin();
        paused = value;
        emit PausedSet(value);
    }

    function createSubscription(
        bytes32 subscriptionId,
        uint256 agentId,
        uint64 start,
        uint64 end,
        uint256 ratePerSecond,
        uint256 deposit,
        uint64 scheduleInterval,
        uint256 scheduledGasLimit
    ) external payable returns (address escrowAddress) {
        if (paused) revert Paused();
        if (subscriptionId == bytes32(0) || subscriptionEscrow[subscriptionId] != address(0)) {
            if (subscriptionEscrow[subscriptionId] != address(0)) revert DuplicateSubscription(subscriptionId);
            revert InvalidTerms();
        }
        uint256 duration = end > start ? end - start : 0;
        if (start < block.timestamp || duration == 0 || duration > MAX_DURATION || ratePerSecond == 0
            || scheduleInterval == 0 || scheduledGasLimit == 0 || scheduledGasLimit > MAX_SCHEDULE_GAS) revert InvalidTerms();
        if (deposit > MAX_DEPOSIT || ratePerSecond > MAX_DEPOSIT / duration || ratePerSecond * duration != deposit) revert InvalidDeposit();
        if (msg.value > MAX_AUTOMATION_RESERVE) revert InvalidReserve();

        (, , address provider, bool active, , , bytes32 supportedSchema, uint8 paymentModes, ) = registry.getAgent(agentId);
        if (!active || provider == address(0)) revert InvalidTerms();
        if (supportedSchema != schemaId || (paymentModes & PAYMENT_MODE_SUBSCRIPTION) == 0) {
            revert UnsupportedSubscriptionAgent(agentId);
        }
        SubscriptionEscrow escrow = new SubscriptionEscrow{value: msg.value}(
            address(this), address(hts), address(scheduler), token, subscriptionId, agentId, msg.sender, provider,
            start, end, ratePerSecond, deposit, scheduleInterval, scheduledGasLimit
        );
        escrowAddress = address(escrow);

        (int64 allowanceCode, uint256 approved) = hts.allowance(token, msg.sender, address(this));
        if (allowanceCode != SUCCESS) revert HtsFailure(IHederaTokenServiceSubset.allowance.selector, allowanceCode);
        if (approved != deposit) revert AllowanceMismatch(deposit, approved);
        uint256 escrowBalanceBefore = IERC20Balance(token).balanceOf(escrowAddress);
        uint256 buyerBalanceBefore = IERC20Balance(token).balanceOf(msg.sender);
        int64 transferCode = hts.transferFrom(token, msg.sender, escrowAddress, deposit);
        if (transferCode != SUCCESS) revert HtsFailure(IHederaTokenServiceSubset.transferFrom.selector, transferCode);
        uint256 escrowBalanceAfter = IERC20Balance(token).balanceOf(escrowAddress);
        uint256 buyerBalanceAfter = IERC20Balance(token).balanceOf(msg.sender);
        if (escrowBalanceAfter < escrowBalanceBefore || escrowBalanceAfter - escrowBalanceBefore != deposit) {
            revert TokenBalanceMismatch(deposit, escrowBalanceAfter < escrowBalanceBefore ? 0 : escrowBalanceAfter - escrowBalanceBefore);
        }
        if (buyerBalanceAfter > buyerBalanceBefore || buyerBalanceBefore - buyerBalanceAfter != deposit) {
            revert TokenBalanceMismatch(deposit, buyerBalanceAfter > buyerBalanceBefore ? 0 : buyerBalanceBefore - buyerBalanceAfter);
        }

        subscriptionEscrow[subscriptionId] = escrowAddress;
        escrow.initializeSchedule();
        emit SubscriptionCreated(subscriptionId, escrowAddress, msg.sender, agentId, provider, token, start, end, ratePerSecond, deposit, msg.value);
    }
}

contract SubscriptionEscrow {
    int64 private constant SUCCESS = 22;
    int64 private constant TOKEN_ALREADY_ASSOCIATED = 194;
    uint64 public constant MAX_SCHEDULE_EARLY_SKEW = 5;

    address public immutable factory;
    IHederaTokenServiceSubset public immutable hts;
    IHederaScheduleService1215 public immutable scheduler;
    address public immutable token;
    bytes32 public immutable subscriptionId;
    uint256 public immutable agentId;
    address public immutable buyer;
    address public immutable provider;
    uint64 public immutable start;
    uint64 public immutable end;
    uint256 public immutable ratePerSecond;
    uint256 public immutable deposit;
    uint64 public immutable scheduleInterval;
    uint256 public immutable scheduledGasLimit;
    uint256 public immutable automationReserveInitial;

    uint256 public paid;
    uint64 public cancelledAt;
    bool public closed;
    bool private entered;
    uint64 public nextScheduledAt;
    address public scheduleAddress;
    uint256 public automationRefunded;

    error HtsFailure(bytes4 operation, int64 responseCode);
    error TokenBalanceMismatch(uint256 expected, uint256 actual);
    error NotBuyer();
    error NotFactory();
    error NotDue();
    error Closed();
    error ReentrantCall();
    error ReserveRefundFailed();
    error InvalidReserveRecipient();

    event Checkpoint(bytes32 indexed subscriptionId, uint256 newlyPaid, uint256 totalPaid, uint64 at);
    event SubscriptionClosed(bytes32 indexed subscriptionId, uint64 cancelledAt, uint256 totalPaid, uint256 tokenRefund, uint256 reserveRefund, address reserveRecipient);
    event ScheduleAttempt(bytes32 indexed subscriptionId, uint64 scheduledAt, int64 responseCode, address scheduleAddress, uint256 reserveBalance);
    event ScheduleDeleteAttempt(bytes32 indexed subscriptionId, address scheduleAddress, int64 responseCode);

    modifier nonReentrant() {
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
    }

    constructor(
        address factory_,
        address hts_,
        address scheduler_,
        address token_,
        bytes32 subscriptionId_,
        uint256 agentId_,
        address buyer_,
        address provider_,
        uint64 start_,
        uint64 end_,
        uint256 ratePerSecond_,
        uint256 deposit_,
        uint64 scheduleInterval_,
        uint256 scheduledGasLimit_
    ) payable {
        factory = factory_;
        hts = IHederaTokenServiceSubset(hts_);
        scheduler = IHederaScheduleService1215(scheduler_);
        token = token_;
        subscriptionId = subscriptionId_;
        agentId = agentId_;
        buyer = buyer_;
        provider = provider_;
        start = start_;
        end = end_;
        ratePerSecond = ratePerSecond_;
        deposit = deposit_;
        scheduleInterval = scheduleInterval_;
        scheduledGasLimit = scheduledGasLimit_;
        automationReserveInitial = msg.value;
        int64 code = hts.associateToken(address(this), token_);
        if (code != SUCCESS && code != TOKEN_ALREADY_ASSOCIATED) revert HtsFailure(IHederaTokenServiceSubset.associateToken.selector, code);
    }

    function terms()
        external
        view
        returns (address, address, address, uint256, uint64, uint64, uint256, uint256, uint256, uint64, bool, uint64, uint256)
    {
        return (buyer, provider, token, agentId, start, end, ratePerSecond, deposit, paid, cancelledAt, closed, scheduleInterval, scheduledGasLimit);
    }

    function earned() public view returns (uint256) {
        uint256 effective = block.timestamp;
        if (effective > end) effective = end;
        if (cancelledAt != 0 && effective > cancelledAt) effective = cancelledAt;
        if (effective <= start) return 0;
        uint256 value = ratePerSecond * (effective - start);
        return value < deposit ? value : deposit;
    }

    function automationReserve() external view returns (uint256) {
        return address(this).balance;
    }

    function automationSpent() external view returns (uint256) {
        uint256 accounted = address(this).balance + automationRefunded;
        return accounted < automationReserveInitial ? automationReserveInitial - accounted : 0;
    }

    function isEntitled(address account) external view returns (bool) {
        return account == buyer && !closed && block.timestamp >= start && block.timestamp < end;
    }

    function checkpoint() external nonReentrant returns (uint256) {
        if (closed) return 0;
        return _payAccrued();
    }

    function claim() external nonReentrant returns (uint256) {
        if (closed) return 0;
        return _payAccrued();
    }

    function cancel() external nonReentrant {
        if (msg.sender != buyer) revert NotBuyer();
        if (closed) return;
        cancelledAt = uint64(block.timestamp < end ? block.timestamp : end);
        _finish(payable(buyer));
    }

    function cancelTo(address payable reserveRecipient) external nonReentrant {
        if (msg.sender != buyer) revert NotBuyer();
        if (closed) return;
        cancelledAt = uint64(block.timestamp < end ? block.timestamp : end);
        _finish(reserveRecipient);
    }

    function close() external nonReentrant {
        if (closed) return;
        if (block.timestamp < end) revert NotDue();
        _finish(payable(buyer));
    }

    function closeTo(address payable reserveRecipient) external nonReentrant {
        if (msg.sender != buyer) revert NotBuyer();
        if (closed) return;
        if (block.timestamp < end) revert NotDue();
        _finish(reserveRecipient);
    }

    function initializeSchedule() external {
        if (msg.sender != factory) revert NotFactory();
        _trySchedule();
    }

    function requestSchedule() external {
        if (msg.sender != buyer && msg.sender != provider) revert NotBuyer();
        if (nextScheduledAt != 0 && block.timestamp >= nextScheduledAt) _clearSchedule();
        _trySchedule();
    }

    function scheduledCheckpoint(uint64 scheduledFor) external nonReentrant {
        if (closed || scheduledFor == 0 || scheduledFor != nextScheduledAt) return;
        if (
            block.timestamp < scheduledFor
                && (
                    scheduledFor - block.timestamp > MAX_SCHEDULE_EARLY_SKEW
                        || msg.sender != address(this)
                )
        ) return;
        nextScheduledAt = 0;
        scheduleAddress = address(0);
        _payAccrued();
        if (block.timestamp < end) _trySchedule();
    }

    function _payAccrued() private returns (uint256 amount) {
        uint256 totalEarned = earned();
        amount = totalEarned - paid;
        if (amount == 0) return 0;
        paid = totalEarned;
        _transferExact(provider, amount);
        emit Checkpoint(subscriptionId, amount, paid, uint64(block.timestamp));
    }

    function _finish(address payable reserveRecipient) private {
        if (reserveRecipient == address(0)) revert InvalidReserveRecipient();
        closed = true;
        (address pendingSchedule, int64 deleteCode) = _clearSchedule();
        uint256 newlyPaid = _payAccrued();
        uint256 tokenRefund = deposit - paid;
        if (tokenRefund != 0) _transferExact(buyer, tokenRefund);
        uint256 reserveRefund = address(this).balance;
        if (reserveRefund != 0) {
            automationRefunded = reserveRefund;
            (bool sent, ) = reserveRecipient.call{value: reserveRefund}("");
            if (!sent) revert ReserveRefundFailed();
        }
        if (pendingSchedule != address(0)) emit ScheduleDeleteAttempt(subscriptionId, pendingSchedule, deleteCode);
        emit SubscriptionClosed(subscriptionId, cancelledAt, paid, tokenRefund, reserveRefund, reserveRecipient);
        newlyPaid;
    }

    function _transferExact(address recipient, uint256 amount) private {
        uint256 escrowBefore = IERC20Balance(token).balanceOf(address(this));
        uint256 recipientBefore = IERC20Balance(token).balanceOf(recipient);
        int64 code = hts.transferToken(token, address(this), recipient, int64(uint64(amount)));
        if (code != SUCCESS) revert HtsFailure(IHederaTokenServiceSubset.transferToken.selector, code);
        uint256 escrowAfter = IERC20Balance(token).balanceOf(address(this));
        uint256 recipientAfter = IERC20Balance(token).balanceOf(recipient);
        if (escrowAfter > escrowBefore || escrowBefore - escrowAfter != amount) {
            revert TokenBalanceMismatch(amount, escrowAfter > escrowBefore ? 0 : escrowBefore - escrowAfter);
        }
        if (recipientAfter < recipientBefore || recipientAfter - recipientBefore != amount) {
            revert TokenBalanceMismatch(amount, recipientAfter < recipientBefore ? 0 : recipientAfter - recipientBefore);
        }
    }

    function _clearSchedule() private returns (address previous, int64 code) {
        previous = scheduleAddress;
        nextScheduledAt = 0;
        scheduleAddress = address(0);
        if (previous == address(0)) return (previous, 0);
        try scheduler.deleteSchedule(previous) returns (int64 responseCode) { code = responseCode; }
        catch { code = 21; }
    }

    function _trySchedule() private {
        if (closed || nextScheduledAt != 0 || block.timestamp >= end || address(this).balance == 0) return;
        uint256 base = block.timestamp < start ? start : block.timestamp;
        uint256 desired = base + scheduleInterval;
        uint64 scheduledAt = uint64(desired < end ? desired : end);
        bytes memory data = abi.encodeCall(this.scheduledCheckpoint, (scheduledAt));
        int64 code;
        address created;
        try scheduler.scheduleCall(address(this), scheduledAt, scheduledGasLimit, 0, data) returns (int64 responseCode, address result) {
            code = responseCode;
            created = result;
        } catch { code = 21; }
        if (code == SUCCESS && created != address(0)) {
            nextScheduledAt = scheduledAt;
            scheduleAddress = created;
        }
        emit ScheduleAttempt(subscriptionId, scheduledAt, code, created, address(this).balance);
    }
}
