// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Ownership and endpoint anchors for signal providers.
/// @dev Rolling metrics and private signal data intentionally do not live here.
contract AgentRegistry {
    uint256 public constant MAX_METADATA_URI_BYTES = 1024;

    struct Agent {
        address owner;
        address gateway;
        address payee;
        bool active;
        bytes32 metadataHash;
        string metadataUri;
        bytes32 schemaId;
        uint8 paymentModes;
        uint64 registeredAt;
    }

    mapping(uint256 => Agent) private agents;

    error AgentAlreadyRegistered(uint256 agentId);
    error UnknownAgent(uint256 agentId);
    error InvalidAgentId();
    error InvalidAddress();
    error InvalidMetadata();
    error InvalidSchema();
    error InvalidPaymentModes();
    error NotAgentOwner(uint256 agentId, address caller);

    event AgentRegistered(
        uint256 indexed agentId,
        address indexed owner,
        address indexed gateway,
        address payee,
        bytes32 metadataHash,
        bytes32 schemaId,
        uint8 paymentModes,
        string metadataUri
    );
    event AgentGatewayUpdated(uint256 indexed agentId, address indexed gateway);
    event AgentPayeeUpdated(uint256 indexed agentId, address indexed payee);
    event AgentMetadataUpdated(uint256 indexed agentId, string metadataUri, bytes32 metadataHash);
    event AgentCapabilitiesUpdated(uint256 indexed agentId, bytes32 schemaId, uint8 paymentModes);
    event AgentActiveUpdated(uint256 indexed agentId, bool active);

    function registerAgent(
        uint256 agentId,
        address gateway,
        address payee,
        string calldata metadataUri,
        bytes32 metadataHash,
        bytes32 schemaId,
        uint8 paymentModes
    ) external {
        if (agentId == 0) revert InvalidAgentId();
        if (agents[agentId].owner != address(0)) revert AgentAlreadyRegistered(agentId);
        _validateMutableFields(payee, metadataUri, metadataHash, schemaId, paymentModes);

        agents[agentId] = Agent({
            owner: msg.sender,
            gateway: gateway,
            payee: payee,
            active: true,
            metadataHash: metadataHash,
            metadataUri: metadataUri,
            schemaId: schemaId,
            paymentModes: paymentModes,
            registeredAt: uint64(block.timestamp)
        });
        emit AgentRegistered(agentId, msg.sender, gateway, payee, metadataHash, schemaId, paymentModes, metadataUri);
    }

    function setGateway(uint256 agentId, address gateway) external onlyOwner(agentId) {
        agents[agentId].gateway = gateway;
        emit AgentGatewayUpdated(agentId, gateway);
    }

    function setPayee(uint256 agentId, address payee) external onlyOwner(agentId) {
        if (payee == address(0)) revert InvalidAddress();
        agents[agentId].payee = payee;
        emit AgentPayeeUpdated(agentId, payee);
    }

    function setMetadata(uint256 agentId, string calldata metadataUri, bytes32 metadataHash) external onlyOwner(agentId) {
        if (bytes(metadataUri).length == 0 || bytes(metadataUri).length > MAX_METADATA_URI_BYTES || metadataHash == bytes32(0)) {
            revert InvalidMetadata();
        }
        agents[agentId].metadataUri = metadataUri;
        agents[agentId].metadataHash = metadataHash;
        emit AgentMetadataUpdated(agentId, metadataUri, metadataHash);
    }

    function setCapabilities(uint256 agentId, bytes32 schemaId, uint8 paymentModes) external onlyOwner(agentId) {
        if (schemaId == bytes32(0)) revert InvalidSchema();
        if (paymentModes == 0) revert InvalidPaymentModes();
        agents[agentId].schemaId = schemaId;
        agents[agentId].paymentModes = paymentModes;
        emit AgentCapabilitiesUpdated(agentId, schemaId, paymentModes);
    }

    function setActive(uint256 agentId, bool active) external onlyOwner(agentId) {
        agents[agentId].active = active;
        emit AgentActiveUpdated(agentId, active);
    }

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
        )
    {
        Agent storage agent = agents[agentId];
        if (agent.owner == address(0)) revert UnknownAgent(agentId);
        return (
            agent.owner,
            agent.gateway,
            agent.payee,
            agent.active,
            agent.metadataHash,
            agent.metadataUri,
            agent.schemaId,
            agent.paymentModes,
            agent.registeredAt
        );
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        if (agents[agentId].owner == address(0)) revert UnknownAgent(agentId);
        return agents[agentId].owner;
    }

    function payeeOf(uint256 agentId) external view returns (address) {
        if (agents[agentId].owner == address(0)) revert UnknownAgent(agentId);
        return agents[agentId].payee;
    }

    function isActive(uint256 agentId) external view returns (bool) {
        if (agents[agentId].owner == address(0)) revert UnknownAgent(agentId);
        return agents[agentId].active;
    }

    function isAuthorized(uint256 agentId, address caller) external view returns (bool) {
        Agent storage agent = agents[agentId];
        return agent.owner != address(0) && (caller == agent.owner || caller == agent.gateway);
    }

    modifier onlyOwner(uint256 agentId) {
        Agent storage agent = agents[agentId];
        if (agent.owner == address(0)) revert UnknownAgent(agentId);
        if (msg.sender != agent.owner) revert NotAgentOwner(agentId, msg.sender);
        _;
    }

    function _validateMutableFields(
        address payee,
        string calldata metadataUri,
        bytes32 metadataHash,
        bytes32 schemaId,
        uint8 paymentModes
    ) private pure {
        if (payee == address(0)) revert InvalidAddress();
        if (bytes(metadataUri).length == 0 || bytes(metadataUri).length > MAX_METADATA_URI_BYTES || metadataHash == bytes32(0)) {
            revert InvalidMetadata();
        }
        if (schemaId == bytes32(0)) revert InvalidSchema();
        if (paymentModes == 0) revert InvalidPaymentModes();
    }
}
