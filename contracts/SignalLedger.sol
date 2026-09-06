// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

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
contract SignalLedger {
    uint8 public constant DISTRIBUTION_NON_EXCLUSIVE = 1;
    uint8 public constant PAYMENT_MODE_X402 = 1;
    bytes32 public constant HBAR_ASSET_ID = bytes32(0);
    bytes32 public constant HEDERA_TESTNET_NETWORK_ID = keccak256("hedera:testnet");
    uint256 public constant MAX_SAFE_RETURN_BPS = 9_007_199_254_740_991;
    int32 public constant MAX_SUPPORTED_EXPO = 18;

    IAgentRegistry public immutable registry;
    IPyth public immutable pyth;
    bytes32 public immutable schemaId;
    bytes32 public immutable allowedPriceFeedId;
    uint64 public immutable minTargetLead;
    uint64 public immutable maxTargetLead;
    uint64 public immutable issuanceTolerance;
    uint64 public immutable oracleWindow;
    uint16 public immutable maxConfidenceBps;
    uint16 public immutable neutralBandBps;

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

    struct Observation {
        int64 price;
        uint64 conf;
        int32 expo;
        uint64 publishTime;
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

    error InvalidConfig();
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
    error InsufficientOracleFee(uint256 required, uint256 supplied);
    error OracleDataMissing();
    error ArithmeticOutOfRange();

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
    ) {
        if (
            registry_ == address(0) ||
            pyth_ == address(0) ||
            schemaId_ == bytes32(0) ||
            allowedPriceFeedId_ == bytes32(0) ||
            minTargetLead_ == 0 ||
            maxTargetLead_ < minTargetLead_ ||
            oracleWindow_ == 0 ||
            maxConfidenceBps_ > 10_000 ||
            neutralBandBps_ > 10_000
        ) revert InvalidConfig();
        registry = IAgentRegistry(registry_);
        pyth = IPyth(pyth_);
        schemaId = schemaId_;
        allowedPriceFeedId = allowedPriceFeedId_;
        minTargetLead = minTargetLead_;
        maxTargetLead = maxTargetLead_;
        issuanceTolerance = issuanceTolerance_;
        oracleWindow = oracleWindow_;
        maxConfidenceBps = maxConfidenceBps_;
        neutralBandBps = neutralBandBps_;
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
        if (issueUpdate.length == 0 || targetUpdate.length == 0) revert OracleDataMissing();

        uint256 issueFee = pyth.getUpdateFee(issueUpdate);
        uint256 targetFee = pyth.getUpdateFee(targetUpdate);
        uint256 requiredFee = issueFee + targetFee;
        if (msg.value < requiredFee) revert InsufficientOracleFee(requiredFee, msg.value);

        uint64 issueMin = commitment.committedAt;
        uint64 issueMax = issueMin + oracleWindow;
        uint64 targetMin = commitment.targetTime;
        uint64 targetMax = targetMin + oracleWindow;
        bytes32[] memory feedIds = new bytes32[](1);
        feedIds[0] = commitment.priceFeedId;

        PythStructs.PriceFeed[] memory issueFeeds = pyth.parsePriceFeedUpdatesUnique{value: issueFee}(
            issueUpdate,
            feedIds,
            issueMin,
            issueMax
        );
        PythStructs.PriceFeed[] memory targetFeeds = pyth.parsePriceFeedUpdatesUnique{value: targetFee}(
            targetUpdate,
            feedIds,
            targetMin,
            targetMax
        );
        if (issueFeeds.length != 1 || targetFeeds.length != 1 || issueFeeds[0].id != commitment.priceFeedId || targetFeeds[0].id != commitment.priceFeedId) {
            revert OracleDataMissing();
        }

        Observation memory issue = _observation(issueFeeds[0].price);
        Observation memory target = _observation(targetFeeds[0].price);
        if (!_validObservation(issue) || !_validObservation(target)) {
            _exclude(requestId, commitment, gradeRecord, issue, target, 1);
        } else if (!_withinConfidence(issue) || !_withinConfidence(target)) {
            _exclude(requestId, commitment, gradeRecord, issue, target, 2);
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

    function _observation(PythStructs.Price memory price) private pure returns (Observation memory) {
        if (price.publishTime > type(uint64).max || price.expo < -MAX_SUPPORTED_EXPO || price.expo > MAX_SUPPORTED_EXPO) {
            revert ArithmeticOutOfRange();
        }
        return Observation({price: price.price, conf: price.conf, expo: price.expo, publishTime: uint64(price.publishTime)});
    }

    function _validObservation(Observation memory observation) private pure returns (bool) {
        return observation.price > 0;
    }

    function _withinConfidence(Observation memory observation) private view returns (bool) {
        return uint256(observation.conf) * 10_000 <= uint256(uint64(observation.price)) * maxConfidenceBps;
    }

    function _calculateGrade(int32 predictedReturnBps, Observation memory issue, Observation memory target)
        private
        view
        returns (int256 actualReturnBps, uint256 absoluteErrorBps, bool directionCorrect)
    {
        (uint256 base, uint256 quote) = _normalize(issue.price, issue.expo, target.price, target.expo);
        int256 delta;
        if (quote >= base) {
            uint256 increase = quote - base;
            if (increase > uint256(type(int256).max) / 10_000) revert ArithmeticOutOfRange();
            delta = int256(increase * 10_000 / base);
        } else {
            uint256 decrease = base - quote;
            if (decrease > uint256(type(int256).max) / 10_000) revert ArithmeticOutOfRange();
            delta = -int256(decrease * 10_000 / base);
        }
        if (delta > int256(MAX_SAFE_RETURN_BPS) || delta < -int256(MAX_SAFE_RETURN_BPS)) revert ArithmeticOutOfRange();
        actualReturnBps = delta;
        int256 difference = actualReturnBps - int256(predictedReturnBps);
        absoluteErrorBps = uint256(difference < 0 ? -difference : difference);
        if (absoluteErrorBps > MAX_SAFE_RETURN_BPS) revert ArithmeticOutOfRange();
        directionCorrect = _direction(actualReturnBps) == _direction(int256(predictedReturnBps));
    }

    function _normalize(int64 p0, int32 e0, int64 p1, int32 e1) private pure returns (uint256 base, uint256 quote) {
        uint256 first = uint256(uint64(p0));
        uint256 second = uint256(uint64(p1));
        if (e0 == e1) return (first, second);
        int256 exponentDelta = int256(e1) - int256(e0);
        uint256 magnitude = uint256(exponentDelta < 0 ? -exponentDelta : exponentDelta);
        if (magnitude > 77) revert ArithmeticOutOfRange();
        uint256 scale = 10 ** magnitude;
        if (exponentDelta > 0) {
            if (second > type(uint256).max / scale) revert ArithmeticOutOfRange();
            return (first, second * scale);
        }
        if (first > type(uint256).max / scale) revert ArithmeticOutOfRange();
        return (first * scale, second);
    }

    function _direction(int256 value) private view returns (int8) {
        int256 neutralBand = int256(uint256(neutralBandBps));
        if (value < -neutralBand) return -1;
        if (value > neutralBand) return 1;
        return 0;
    }

    function _within(uint64 value, uint64 expected, uint64 tolerance) private pure returns (bool) {
        return value >= expected ? value - expected <= tolerance : expected - value <= tolerance;
    }
}
