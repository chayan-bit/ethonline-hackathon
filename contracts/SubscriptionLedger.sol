// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OracleGradeEngine} from "./OracleGradeEngine.sol";

interface ISubscriptionAgentRegistry {
    function getAgent(uint256 agentId)
        external view returns (address, address, address, bool, bytes32, string memory, bytes32, uint8, uint64);
    function isAuthorized(uint256 agentId, address caller) external view returns (bool);
}

interface ISubscriptionVaultLookup {
    function subscriptionEscrow(bytes32 subscriptionId) external view returns (address);
}

interface ISubscriptionEntitlement {
    function agentId() external view returns (uint256);
    function buyer() external view returns (address);
    function isEntitled(address account) external view returns (bool);
}

/// @notice Subscription-scoped commitment, reveal, and authenticated Pyth grade evidence.
/// @dev This contract has no payment reference, balance, withdrawal, reward, or settlement path.
contract SubscriptionLedger is OracleGradeEngine {
    uint8 public constant DISTRIBUTION_NON_EXCLUSIVE = 1;
    uint8 public constant PAYMENT_MODE_SUBSCRIPTION = 2;

    ISubscriptionAgentRegistry public immutable registry;
    ISubscriptionVaultLookup public immutable subscriptionVault;
    bytes32 public immutable schemaId;
    uint64 public immutable horizon;
    uint64 public immutable issuanceTolerance;

    struct SignalPayload {
        bytes32 schemaId;
        bytes32 requestId;
        uint256 agentId;
        bytes32 priceFeedId;
        uint64 issuedAt;
        uint64 targetTime;
        int32 predictedReturnBps;
        bytes32 modelVersionHash;
        uint8 distributionCode;
    }

    struct Commitment {
        bool exists;
        bytes32 subscriptionId;
        uint256 agentId;
        bytes32 signalHash;
        uint64 committedAt;
        uint64 issuedAt;
        uint64 targetTime;
        bytes32 priceFeedId;
        address subscriber;
        bool revealed;
    }

    struct RevealRecord {
        bool revealed;
        SignalPayload signal;
        bytes32 salt;
        uint64 revealedAt;
    }

    struct GradeRecord {
        bool graded;
        bool oracleExcluded;
        uint8 exclusionReason;
        int256 actualReturnBps;
        uint256 absoluteErrorBps;
        bool directionCorrect;
        Observation issue;
        Observation target;
        uint64 finalizedAt;
    }

    mapping(bytes32 => Commitment) private commitments;
    mapping(bytes32 => RevealRecord) private reveals;
    mapping(bytes32 => GradeRecord) private grades;

    error InvalidSubscriptionId();
    error InvalidRequestId();
    error InvalidSignalHash();
    error DuplicateRequest(bytes32 requestId);
    error UnknownCommitment(bytes32 requestId);
    error NotAuthorizedCommitter(uint256 agentId, address caller);
    error SubscriptionNotEntitled(bytes32 subscriptionId);
    error InactiveAgent(uint256 agentId);
    error UnsupportedSubscriptionAgent(uint256 agentId);
    error UnsupportedSchema(bytes32 supplied);
    error UnsupportedFeed(bytes32 supplied);
    error InvalidCommitTiming(uint64 issuedAt, uint64 targetTime, uint64 consensusTime);
    error NotExpired(uint64 targetTime, uint64 consensusTime);
    error AlreadyRevealed(bytes32 requestId);
    error PayloadMismatch();
    error HashMismatch(bytes32 expected, bytes32 actual);
    error NotRevealed(bytes32 requestId);
    error AlreadyFinalized(bytes32 requestId);

    event SubscriptionSignalCommitted(
        bytes32 indexed subscriptionId,
        bytes32 indexed requestId,
        uint256 indexed agentId,
        bytes32 signalHash,
        uint64 committedAt,
        uint64 issuedAt,
        uint64 targetTime,
        bytes32 priceFeedId,
        address subscriber
    );
    event SubscriptionSignalRevealed(
        bytes32 indexed subscriptionId,
        bytes32 indexed requestId,
        uint256 indexed agentId,
        bytes32 signalHash,
        uint64 revealedAt,
        SignalPayload signal,
        bytes32 salt
    );
    event SubscriptionSignalGraded(
        bytes32 indexed subscriptionId,
        bytes32 indexed requestId,
        uint256 indexed agentId,
        uint64 finalizedAt,
        Observation issue,
        Observation target,
        int256 actualReturnBps,
        uint256 absoluteErrorBps,
        bool directionCorrect
    );
    event SubscriptionSignalOracleExcluded(
        bytes32 indexed subscriptionId,
        bytes32 indexed requestId,
        uint256 indexed agentId,
        uint64 finalizedAt,
        uint8 reason,
        Observation issue,
        Observation target
    );

    constructor(
        address registry_,
        address subscriptionVault_,
        address pyth_,
        bytes32 schemaId_,
        bytes32 allowedPriceFeedId_,
        uint64 horizon_,
        uint64 issuanceTolerance_,
        uint64 oracleWindow_,
        uint16 maxConfidenceBps_,
        uint16 neutralBandBps_
    ) OracleGradeEngine(pyth_, allowedPriceFeedId_, oracleWindow_, maxConfidenceBps_, neutralBandBps_) {
        if (registry_ == address(0) || subscriptionVault_ == address(0) || schemaId_ == bytes32(0) || horizon_ == 0) {
            revert InvalidConfig();
        }
        registry = ISubscriptionAgentRegistry(registry_);
        subscriptionVault = ISubscriptionVaultLookup(subscriptionVault_);
        schemaId = schemaId_;
        horizon = horizon_;
        issuanceTolerance = issuanceTolerance_;
    }

    function commit(
        bytes32 subscriptionId,
        bytes32 requestId,
        uint256 agentId,
        bytes32 signalHash,
        bytes32 signalSchemaId,
        uint64 issuedAt,
        uint64 targetTime,
        bytes32 priceFeedId
    ) external {
        if (subscriptionId == bytes32(0)) revert InvalidSubscriptionId();
        if (requestId == bytes32(0)) revert InvalidRequestId();
        if (signalHash == bytes32(0)) revert InvalidSignalHash();
        if (commitments[requestId].exists) revert DuplicateRequest(requestId);
        if (!registry.isAuthorized(agentId, msg.sender)) revert NotAuthorizedCommitter(agentId, msg.sender);
        (, , , bool active, , , bytes32 supportedSchema, uint8 paymentModes, ) = registry.getAgent(agentId);
        if (!active) revert InactiveAgent(agentId);
        if ((paymentModes & PAYMENT_MODE_SUBSCRIPTION) == 0) revert UnsupportedSubscriptionAgent(agentId);
        if (signalSchemaId != schemaId || supportedSchema != signalSchemaId) revert UnsupportedSchema(signalSchemaId);
        if (priceFeedId != allowedPriceFeedId) revert UnsupportedFeed(priceFeedId);

        address escrowAddress = subscriptionVault.subscriptionEscrow(subscriptionId);
        if (escrowAddress == address(0)) revert SubscriptionNotEntitled(subscriptionId);
        ISubscriptionEntitlement escrow = ISubscriptionEntitlement(escrowAddress);
        address subscriber = escrow.buyer();
        if (escrow.agentId() != agentId || !escrow.isEntitled(subscriber)) {
            revert SubscriptionNotEntitled(subscriptionId);
        }

        uint64 consensusTime = uint64(block.timestamp);
        if (!_within(issuedAt, consensusTime, issuanceTolerance) || targetTime <= consensusTime
            || uint256(targetTime) != uint256(issuedAt) + horizon) {
            revert InvalidCommitTiming(issuedAt, targetTime, consensusTime);
        }
        commitments[requestId] = Commitment(true, subscriptionId, agentId, signalHash, consensusTime, issuedAt,
            targetTime, priceFeedId, subscriber, false);
        emit SubscriptionSignalCommitted(subscriptionId, requestId, agentId, signalHash, consensusTime, issuedAt,
            targetTime, priceFeedId, subscriber);
    }

    function reveal(bytes32 requestId, SignalPayload calldata signal, bytes32 salt) external {
        Commitment storage commitment = commitments[requestId];
        if (!commitment.exists) revert UnknownCommitment(requestId);
        if (commitment.revealed) revert AlreadyRevealed(requestId);
        uint64 consensusTime = uint64(block.timestamp);
        if (consensusTime < commitment.targetTime) revert NotExpired(commitment.targetTime, consensusTime);
        if (signal.requestId != requestId || signal.agentId != commitment.agentId || signal.schemaId != schemaId
            || signal.priceFeedId != commitment.priceFeedId || signal.issuedAt != commitment.issuedAt
            || signal.targetTime != commitment.targetTime || signal.predictedReturnBps < -10_000
            || signal.predictedReturnBps > 100_000 || signal.modelVersionHash == bytes32(0)
            || signal.distributionCode != DISTRIBUTION_NON_EXCLUSIVE) revert PayloadMismatch();
        bytes32 actualHash = computeSignalHash(signal, salt);
        if (actualHash != commitment.signalHash) revert HashMismatch(commitment.signalHash, actualHash);
        commitment.revealed = true;
        reveals[requestId] = RevealRecord(true, signal, salt, consensusTime);
        emit SubscriptionSignalRevealed(commitment.subscriptionId, requestId, commitment.agentId,
            commitment.signalHash, consensusTime, signal, salt);
    }

    function grade(bytes32 requestId, bytes[] calldata issueUpdate, bytes[] calldata targetUpdate) external payable {
        Commitment storage commitment = commitments[requestId];
        if (!commitment.exists) revert UnknownCommitment(requestId);
        if (!commitment.revealed) revert NotRevealed(requestId);
        GradeRecord storage gradeRecord = grades[requestId];
        if (gradeRecord.graded || gradeRecord.oracleExcluded) revert AlreadyFinalized(requestId);
        (Observation memory issue, Observation memory target, uint256 requiredFee) =
            _parseObservations(issueUpdate, targetUpdate, commitment.committedAt, commitment.targetTime);
        uint8 exclusionReason = _exclusionReason(issue, target);
        if (exclusionReason == 0) _recordGrade(requestId, commitment, gradeRecord, issue, target);
        else _recordExclusion(requestId, commitment, gradeRecord, issue, target, exclusionReason);
        uint256 refund = msg.value - requiredFee;
        if (refund != 0) {
            (bool sent, ) = msg.sender.call{value: refund}("");
            require(sent, "ORACLE_FEE_REFUND_FAILED");
        }
    }

    function computeSignalHash(SignalPayload calldata signal, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(signal.schemaId, signal.requestId, signal.agentId, signal.priceFeedId,
            signal.issuedAt, signal.targetTime, signal.predictedReturnBps, signal.modelVersionHash,
            signal.distributionCode, salt));
    }

    function getCommitment(bytes32 requestId) external view returns (
        bool exists, bytes32 subscriptionId, uint256 agentId, bytes32 signalHash, uint64 committedAt,
        uint64 issuedAt, uint64 targetTime, bytes32 priceFeedId, address subscriber, bool revealed
    ) {
        Commitment storage record = commitments[requestId];
        return (record.exists, record.subscriptionId, record.agentId, record.signalHash, record.committedAt,
            record.issuedAt, record.targetTime, record.priceFeedId, record.subscriber, record.revealed);
    }

    function getReveal(bytes32 requestId) external view returns (bool, SignalPayload memory, bytes32, uint64) {
        RevealRecord storage record = reveals[requestId];
        return (record.revealed, record.signal, record.salt, record.revealedAt);
    }

    function getGrade(bytes32 requestId) external view returns (
        bool, bool, uint8, int256, uint256, bool, Observation memory, Observation memory, uint64
    ) {
        GradeRecord storage record = grades[requestId];
        return (record.graded, record.oracleExcluded, record.exclusionReason, record.actualReturnBps,
            record.absoluteErrorBps, record.directionCorrect, record.issue, record.target, record.finalizedAt);
    }

    function _recordGrade(bytes32 requestId, Commitment storage commitment, GradeRecord storage record,
        Observation memory issue, Observation memory target) private {
        (int256 actualReturnBps, uint256 absoluteErrorBps, bool directionCorrect) =
            _calculateGrade(reveals[requestId].signal.predictedReturnBps, issue, target);
        record.graded = true;
        record.actualReturnBps = actualReturnBps;
        record.absoluteErrorBps = absoluteErrorBps;
        record.directionCorrect = directionCorrect;
        record.issue = issue;
        record.target = target;
        record.finalizedAt = uint64(block.timestamp);
        emit SubscriptionSignalGraded(commitment.subscriptionId, requestId, commitment.agentId, record.finalizedAt,
            issue, target, actualReturnBps, absoluteErrorBps, directionCorrect);
    }

    function _recordExclusion(bytes32 requestId, Commitment storage commitment, GradeRecord storage record,
        Observation memory issue, Observation memory target, uint8 reason) private {
        record.oracleExcluded = true;
        record.exclusionReason = reason;
        record.issue = issue;
        record.target = target;
        record.finalizedAt = uint64(block.timestamp);
        emit SubscriptionSignalOracleExcluded(commitment.subscriptionId, requestId, commitment.agentId,
            record.finalizedAt, reason, issue, target);
    }

    function _within(uint64 value, uint64 expected, uint64 tolerance) private pure returns (bool) {
        return value >= expected ? value - expected <= tolerance : expected - value <= tolerance;
    }
}
