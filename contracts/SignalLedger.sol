// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OracleGradeEngine} from "./OracleGradeEngine.sol";

interface IAgentRegistry {
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

    function isAuthorized(uint256 agentId, address caller) external view returns (bool);
}

/// @notice Immutable commitment, permissionless reveal, and oracle-backed grade evidence.
/// @dev This contract never transfers a seller, buyer, revealer, or grader reward.
contract SignalLedger is OracleGradeEngine {
    uint8 public constant DISTRIBUTION_NON_EXCLUSIVE = 1;
    uint8 public constant PAYMENT_MODE_X402 = 1;
    bytes32 public constant HBAR_ASSET_ID = bytes32(0);
    bytes32 public constant HEDERA_TESTNET_NETWORK_ID = keccak256("hedera:testnet");
    IAgentRegistry public immutable registry;
    bytes32 public immutable schemaId;
    uint64 public immutable minTargetLead;
    uint64 public immutable maxTargetLead;
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
        uint256 agentId;
        bytes32 schemaId;
        bytes32 signalHash;
        uint64 committedAt;
        uint64 issuedAt;
        uint64 targetTime;
        bytes32 priceFeedId;
        uint8 paymentMode;
        bytes32 paymentRef;
        address payer;
        address payee;
        bytes32 paymentAssetId;
        uint256 amount;
        bytes32 networkId;
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
    mapping(bytes32 => bytes32) private requestByPaymentRef;
    mapping(bytes32 => RevealRecord) private reveals;
    mapping(bytes32 => GradeRecord) private grades;

    error InvalidRequestId();
    error InvalidSignalHash();
    error UnknownCommitment(bytes32 requestId);
    error DuplicateRequest(bytes32 requestId);
    error DuplicatePaymentReference(bytes32 paymentRef);
    error NotAuthorizedCommitter(uint256 agentId, address caller);
    error InactiveAgent(uint256 agentId);
    error UnsupportedSchema(bytes32 supplied);
    error UnsupportedFeed(bytes32 supplied);
    error InvalidPaymentTerms();
    error InvalidPaymentReference();
    error InvalidCommitTiming(uint64 issuedAt, uint64 targetTime, uint64 consensusTime);
    error NotExpired(uint64 targetTime, uint64 consensusTime);
    error AlreadyRevealed(bytes32 requestId);
    error HashMismatch(bytes32 expected, bytes32 actual);
    error PayloadMismatch();
    error InvalidIssuanceTime(uint64 issuedAt, uint64 committedAt);
    error NotRevealed(bytes32 requestId);
    error AlreadyFinalized(bytes32 requestId);

    event SignalCommitted(
        bytes32 indexed requestId,
        uint256 indexed agentId,
        bytes32 indexed signalHash,
        bytes32 schemaId,
        uint64 committedAt,
        uint64 issuedAt,
        uint64 targetTime,
        bytes32 priceFeedId,
        uint8 paymentMode,
        bytes32 paymentRef,
        address payer,
        address payee,
        bytes32 paymentAssetId,
        uint256 amount,
        bytes32 networkId,
        string nativePaymentId
    );
    event SignalRevealed(
        bytes32 indexed requestId,
        uint256 indexed agentId,
        bytes32 signalHash,
        uint64 revealedAt,
        SignalPayload signal,
        bytes32 salt
    );
    event SignalGraded(
        bytes32 indexed requestId,
        uint256 indexed agentId,
        uint64 finalizedAt,
        Observation issue,
        Observation target,
        int256 actualReturnBps,
        uint256 absoluteErrorBps,
        bool directionCorrect
    );
    event SignalOracleExcluded(
        bytes32 indexed requestId,
        uint256 indexed agentId,
        uint64 finalizedAt,
        uint8 reason,
        Observation issue,
        Observation target
    );

    constructor(
        address registry_,
        address pyth_,
        bytes32 schemaId_,
        bytes32 allowedPriceFeedId_,
        uint64 minTargetLead_,
        uint64 maxTargetLead_,
        uint64 issuanceTolerance_,
        uint64 oracleWindow_,
        uint16 maxConfidenceBps_,
        uint16 neutralBandBps_
    ) OracleGradeEngine(pyth_, allowedPriceFeedId_, oracleWindow_, maxConfidenceBps_, neutralBandBps_) {
        if (
            registry_ == address(0) ||
            schemaId_ == bytes32(0) ||
            minTargetLead_ == 0 ||
            maxTargetLead_ < minTargetLead_
        ) revert InvalidConfig();
        registry = IAgentRegistry(registry_);
        schemaId = schemaId_;
        minTargetLead = minTargetLead_;
        maxTargetLead = maxTargetLead_;
        issuanceTolerance = issuanceTolerance_;
    }

    function commit(
        bytes32 requestId,
        uint256 agentId,
        bytes32 signalHash,
        bytes32 signalSchemaId,
        uint64 issuedAt,
        uint64 targetTime,
        bytes32 priceFeedId,
        uint8 paymentMode,
        bytes32 paymentRef,
        address payer,
        address payee,
        bytes32 paymentAssetId,
        uint256 amount,
        bytes32 networkId,
        string calldata nativePaymentId
    ) external {
        if (requestId == bytes32(0)) revert InvalidRequestId();
        if (signalHash == bytes32(0)) revert InvalidSignalHash();
        if (commitments[requestId].exists) revert DuplicateRequest(requestId);
        if (paymentRef == bytes32(0) || requestByPaymentRef[paymentRef] != bytes32(0)) {
            revert DuplicatePaymentReference(paymentRef);
        }
        bytes memory nativePaymentIdBytes = bytes(nativePaymentId);
        if (nativePaymentIdBytes.length == 0 || nativePaymentIdBytes.length > 128) revert InvalidPaymentReference();
        if (paymentRef != keccak256(abi.encodePacked("hedera:testnet/", nativePaymentId))) {
            revert InvalidPaymentReference();
        }
        if (!registry.isAuthorized(agentId, msg.sender)) revert NotAuthorizedCommitter(agentId, msg.sender);
        (, , address expectedPayee, bool active, , , bytes32 supportedSchema, uint8 supportedPaymentModes, ) = registry.getAgent(agentId);
        if (!active) revert InactiveAgent(agentId);
        if (signalSchemaId != schemaId || supportedSchema != signalSchemaId) revert UnsupportedSchema(signalSchemaId);
        if (priceFeedId != allowedPriceFeedId) revert UnsupportedFeed(priceFeedId);
        if (
            paymentMode != PAYMENT_MODE_X402 || (supportedPaymentModes & PAYMENT_MODE_X402) == 0 ||
            payer == address(0) || payee == address(0) || payee != expectedPayee || amount == 0 ||
            paymentAssetId != HBAR_ASSET_ID || networkId != HEDERA_TESTNET_NETWORK_ID
        ) revert InvalidPaymentTerms();

        uint64 consensusTime = uint64(block.timestamp);
        if (!_within(issuedAt, consensusTime, issuanceTolerance) || targetTime <= consensusTime) {
            revert InvalidCommitTiming(issuedAt, targetTime, consensusTime);
        }
        uint256 lead = targetTime - consensusTime;
        if (lead < minTargetLead || lead > maxTargetLead) {
            revert InvalidCommitTiming(issuedAt, targetTime, consensusTime);
        }

        commitments[requestId] = Commitment({
            exists: true,
            agentId: agentId,
            schemaId: signalSchemaId,
            signalHash: signalHash,
            committedAt: consensusTime,
            issuedAt: issuedAt,
            targetTime: targetTime,
            priceFeedId: priceFeedId,
            paymentMode: paymentMode,
            paymentRef: paymentRef,
            payer: payer,
            payee: payee,
            paymentAssetId: paymentAssetId,
            amount: amount,
            networkId: networkId,
            revealed: false
        });
        requestByPaymentRef[paymentRef] = requestId;
        emit SignalCommitted(
            requestId,
            agentId,
            signalHash,
            signalSchemaId,
            consensusTime,
            issuedAt,
            targetTime,
            priceFeedId,
            paymentMode,
            paymentRef,
            payer,
            payee,
            paymentAssetId,
            amount,
            networkId,
            nativePaymentId
        );
    }

    function reveal(bytes32 requestId, SignalPayload calldata signal, bytes32 salt) external {
        Commitment storage commitment = commitments[requestId];
        if (!commitment.exists) revert UnknownCommitment(requestId);
        if (commitment.revealed) revert AlreadyRevealed(requestId);
        uint64 consensusTime = uint64(block.timestamp);
        if (consensusTime < commitment.targetTime) revert NotExpired(commitment.targetTime, consensusTime);
        if (
            signal.requestId != requestId ||
            signal.agentId != commitment.agentId ||
            signal.schemaId != commitment.schemaId ||
            signal.priceFeedId != commitment.priceFeedId ||
            signal.issuedAt != commitment.issuedAt ||
            signal.targetTime != commitment.targetTime ||
            signal.predictedReturnBps < -10_000 ||
            signal.predictedReturnBps > 100_000 ||
            signal.modelVersionHash == bytes32(0) ||
            signal.distributionCode != DISTRIBUTION_NON_EXCLUSIVE
        ) revert PayloadMismatch();
        if (!_within(signal.issuedAt, commitment.committedAt, issuanceTolerance)) {
            revert InvalidIssuanceTime(signal.issuedAt, commitment.committedAt);
        }
        bytes32 actualHash = computeSignalHash(signal, salt);
        if (actualHash != commitment.signalHash) revert HashMismatch(commitment.signalHash, actualHash);

        commitment.revealed = true;
        reveals[requestId] = RevealRecord({revealed: true, signal: signal, salt: salt, revealedAt: consensusTime});
        emit SignalRevealed(requestId, commitment.agentId, commitment.signalHash, consensusTime, signal, salt);
    }

    function grade(bytes32 requestId, bytes[] calldata issueUpdate, bytes[] calldata targetUpdate) external payable {
        Commitment storage commitment = commitments[requestId];
        if (!commitment.exists) revert UnknownCommitment(requestId);
        if (!commitment.revealed) revert NotRevealed(requestId);
        GradeRecord storage gradeRecord = grades[requestId];
        if (gradeRecord.graded || gradeRecord.oracleExcluded) revert AlreadyFinalized(requestId);
        uint64 issueMin = commitment.committedAt;
        uint64 targetMin = commitment.targetTime;
        (Observation memory issue, Observation memory target, uint256 requiredFee) =
            _parseObservations(issueUpdate, targetUpdate, issueMin, targetMin);
        uint8 exclusionReason = _exclusionReason(issue, target);
        if (exclusionReason != 0) {
            _exclude(requestId, commitment, gradeRecord, issue, target, exclusionReason);
        } else {
            (int256 actualReturnBps, uint256 absoluteErrorBps, bool directionCorrect) = _calculateGrade(
                reveals[requestId].signal.predictedReturnBps,
                issue,
                target
            );
            gradeRecord.graded = true;
            gradeRecord.actualReturnBps = actualReturnBps;
            gradeRecord.absoluteErrorBps = absoluteErrorBps;
            gradeRecord.directionCorrect = directionCorrect;
            gradeRecord.issue = issue;
            gradeRecord.target = target;
            gradeRecord.finalizedAt = uint64(block.timestamp);
            emit SignalGraded(
                requestId,
                commitment.agentId,
                gradeRecord.finalizedAt,
                issue,
                target,
                actualReturnBps,
                absoluteErrorBps,
                directionCorrect
            );
        }
        uint256 refund = msg.value - requiredFee;
        if (refund != 0) {
            (bool sent, ) = msg.sender.call{value: refund}("");
            require(sent, "ORACLE_FEE_REFUND_FAILED");
        }
    }

    function computeSignalHash(SignalPayload calldata signal, bytes32 salt) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                signal.schemaId,
                signal.requestId,
                signal.agentId,
                signal.priceFeedId,
                signal.issuedAt,
                signal.targetTime,
                signal.predictedReturnBps,
                signal.modelVersionHash,
                signal.distributionCode,
                salt
            )
        );
    }

    function getCommitment(bytes32 requestId)
        external
        view
        returns (
            bool exists,
            uint256 agentId,
            bytes32 signalSchemaId,
            bytes32 signalHash,
            uint64 committedAt,
            uint64 issuedAt,
            uint64 targetTime,
            bytes32 priceFeedId,
            uint8 paymentMode,
            bytes32 paymentRef,
            address payer,
            address payee,
            bytes32 paymentAssetId,
            uint256 amount,
            bytes32 networkId,
            bool revealed
        )
    {
        Commitment storage c = commitments[requestId];
        return (
            c.exists,
            c.agentId,
            c.schemaId,
            c.signalHash,
            c.committedAt,
            c.issuedAt,
            c.targetTime,
            c.priceFeedId,
            c.paymentMode,
            c.paymentRef,
            c.payer,
            c.payee,
            c.paymentAssetId,
            c.amount,
            c.networkId,
            c.revealed
        );
    }

    function getReveal(bytes32 requestId)
        external
        view
        returns (bool revealed, SignalPayload memory signal, bytes32 salt, uint64 revealedAt)
    {
        RevealRecord storage record = reveals[requestId];
        return (record.revealed, record.signal, record.salt, record.revealedAt);
    }

    function getGrade(bytes32 requestId)
        external
        view
        returns (
            bool graded,
            bool oracleExcluded,
            uint8 exclusionReason,
            int256 actualReturnBps,
            uint256 absoluteErrorBps,
            bool directionCorrect,
            Observation memory issue,
            Observation memory target,
            uint64 finalizedAt
        )
    {
        GradeRecord storage record = grades[requestId];
        return (
            record.graded,
            record.oracleExcluded,
            record.exclusionReason,
            record.actualReturnBps,
            record.absoluteErrorBps,
            record.directionCorrect,
            record.issue,
            record.target,
            record.finalizedAt
        );
    }

    function paymentRequest(bytes32 paymentRef) external view returns (bytes32) {
        return requestByPaymentRef[paymentRef];
    }

    function _exclude(
        bytes32 requestId,
        Commitment storage commitment,
        GradeRecord storage gradeRecord,
        Observation memory issue,
        Observation memory target,
        uint8 reason
    ) private {
        gradeRecord.oracleExcluded = true;
        gradeRecord.exclusionReason = reason;
        gradeRecord.issue = issue;
        gradeRecord.target = target;
        gradeRecord.finalizedAt = uint64(block.timestamp);
        emit SignalOracleExcluded(requestId, commitment.agentId, gradeRecord.finalizedAt, reason, issue, target);
    }

    function _within(uint64 value, uint64 expected, uint64 tolerance) private pure returns (bool) {
        return value >= expected ? value - expected <= tolerance : expected - value <= tolerance;
    }
}
