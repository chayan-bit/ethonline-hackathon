// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/// @notice Shared authenticated Pyth observation and return-grade calculations.
abstract contract OracleGradeEngine {
    uint256 public constant MAX_SAFE_RETURN_BPS = 9_007_199_254_740_991;
    int32 public constant MAX_SUPPORTED_EXPO = 18;

    IPyth public immutable pyth;
    bytes32 public immutable allowedPriceFeedId;
    uint64 public immutable oracleWindow;
    uint16 public immutable maxConfidenceBps;
    uint16 public immutable neutralBandBps;

    struct Observation {
        int64 price;
        uint64 conf;
        int32 expo;
        uint64 publishTime;
    }

    error InvalidConfig();
    error InsufficientOracleFee(uint256 required, uint256 supplied);
    error OracleDataMissing();
    error ArithmeticOutOfRange();

    constructor(address pyth_, bytes32 allowedPriceFeedId_, uint64 oracleWindow_, uint16 maxConfidenceBps_, uint16 neutralBandBps_) {
        if (
            pyth_ == address(0) || allowedPriceFeedId_ == bytes32(0) || oracleWindow_ == 0
                || maxConfidenceBps_ > 10_000 || neutralBandBps_ > 10_000
        ) revert InvalidConfig();
        pyth = IPyth(pyth_);
        allowedPriceFeedId = allowedPriceFeedId_;
        oracleWindow = oracleWindow_;
        maxConfidenceBps = maxConfidenceBps_;
        neutralBandBps = neutralBandBps_;
    }

    function _parseObservations(
        bytes[] calldata issueUpdate,
        bytes[] calldata targetUpdate,
        uint64 issueMin,
        uint64 targetMin
    ) internal returns (Observation memory issue, Observation memory target, uint256 requiredFee) {
        if (issueUpdate.length == 0 || targetUpdate.length == 0) revert OracleDataMissing();
        uint256 issueFee = pyth.getUpdateFee(issueUpdate);
        uint256 targetFee = pyth.getUpdateFee(targetUpdate);
        requiredFee = issueFee + targetFee;
        if (msg.value < requiredFee) revert InsufficientOracleFee(requiredFee, msg.value);

        bytes32[] memory feedIds = new bytes32[](1);
        feedIds[0] = allowedPriceFeedId;
        PythStructs.PriceFeed[] memory issueFeeds = pyth.parsePriceFeedUpdatesUnique{value: issueFee}(
            issueUpdate, feedIds, issueMin, issueMin + oracleWindow
        );
        PythStructs.PriceFeed[] memory targetFeeds = pyth.parsePriceFeedUpdatesUnique{value: targetFee}(
            targetUpdate, feedIds, targetMin, targetMin + oracleWindow
        );
        if (
            issueFeeds.length != 1 || targetFeeds.length != 1 || issueFeeds[0].id != allowedPriceFeedId
                || targetFeeds[0].id != allowedPriceFeedId
        ) revert OracleDataMissing();
        issue = _observation(issueFeeds[0].price);
        target = _observation(targetFeeds[0].price);
    }

    function _exclusionReason(Observation memory issue, Observation memory target) internal view returns (uint8) {
        if (issue.price <= 0 || target.price <= 0) return 1;
        if (!_withinConfidence(issue) || !_withinConfidence(target)) return 2;
        return 0;
    }

    function _calculateGrade(int32 predictedReturnBps, Observation memory issue, Observation memory target)
        internal
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

    function _observation(PythStructs.Price memory price) private pure returns (Observation memory) {
        if (price.publishTime > type(uint64).max || price.expo < -MAX_SUPPORTED_EXPO || price.expo > MAX_SUPPORTED_EXPO) {
            revert ArithmeticOutOfRange();
        }
        return Observation({price: price.price, conf: price.conf, expo: price.expo, publishTime: uint64(price.publishTime)});
    }

    function _withinConfidence(Observation memory observation) private view returns (bool) {
        return uint256(observation.conf) * 10_000 <= uint256(uint64(observation.price)) * maxConfidenceBps;
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
}
