import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress } from "viem";
import {
  HSS_SYSTEM_ADDRESS,
  HTS_SYSTEM_ADDRESS,
  P1_BUYER_CAP_TINYBARS,
  P1_BUYER_TOPUP_TINYBARS,
  P1_DEPLOYER_CAP_TINYBARS,
  SMTT_TOKEN,
  completedP1JumboNonce,
  deriveP1JumboHandoff,
  estimateP1BootstrapTinybars,
  requireP1BootstrapBudget,
  requireP1PreTopupBudget,
  requireP1ResumeBudget,
  subscriptionDeploymentArguments,
} from "../../src/protocol/subscription-deployment.ts";
import { ETH_USD, POLICY, SCHEMA_ID } from "../../src/protocol/signal.ts";

const registryAddress = getAddress(
  "0x0000000000000000000000000000000000001000",
);
const tokenAddress = getAddress("0x0000000000000000000000000000000000002000");
const adminAddress = getAddress("0x0000000000000000000000000000000000003000");
const pythAddress = getAddress("0x0000000000000000000000000000000000004000");
const vaultAddress = getAddress("0x0000000000000000000000000000000000005000");

test("subscription deployment binds official Hedera system contracts and the locked cohort", () => {
  const result = subscriptionDeploymentArguments({
    registryAddress,
    tokenAddress,
    adminAddress,
    pythAddress,
    vaultAddress,
  });

  assert.deepEqual(result.vault, [
    registryAddress,
    HTS_SYSTEM_ADDRESS,
    HSS_SYSTEM_ADDRESS,
    tokenAddress,
    adminAddress,
    SCHEMA_ID,
  ]);
  assert.deepEqual(result.ledger, [
    registryAddress,
    vaultAddress,
    pythAddress,
    SCHEMA_ID,
    ETH_USD,
    900n,
    BigInt(POLICY.issueTolerance),
    BigInt(POLICY.oracleWindow),
    100,
    5,
  ]);
});

test("P1 budget includes token provisioning, two deployments, lifecycle gas, and reserve", () => {
  assert.deepEqual(SMTT_TOKEN, {
    name: "SignalMarketTestToken",
    symbol: "SMTT",
    decimals: 6,
    initialSupply: 100_000_000n,
    maxSupply: 100_000_000n,
    buyerFundingTarget: 10_000_000n,
  });
  const estimate = estimateP1BootstrapTinybars(1_100_000_000_000n, {
    cent_equivalent: 241_721n,
    hbar_equivalent: 30_000n,
  });
  assert.deepEqual(estimate, {
    deployerGasTinybars: 880_000_000n,
    buyerGasTinybars: 440_000_000n,
    deployerServiceTinybars: 4_108_041_917n,
    buyerServiceTinybars: 248_220_056n,
    reserveTinybars: 100_000_000n,
    deployerTotalTinybars: 4_988_041_917n,
    buyerTotalTinybars: 788_220_056n,
    totalTinybars: 5_776_261_973n,
  });
  assert.doesNotThrow(() =>
    requireP1BootstrapBudget(
      estimate,
      P1_DEPLOYER_CAP_TINYBARS,
      P1_BUYER_CAP_TINYBARS,
    ),
  );
  assert.throws(
    () =>
      requireP1BootstrapBudget(
        estimate,
        P1_DEPLOYER_CAP_TINYBARS - 1n,
        P1_BUYER_CAP_TINYBARS,
      ),
    /p1_deployer_balance_insufficient/,
  );
  assert.throws(
    () =>
      requireP1BootstrapBudget(
        estimate,
        P1_DEPLOYER_CAP_TINYBARS,
        P1_BUYER_CAP_TINYBARS - 1n,
      ),
    /p1_buyer_balance_insufficient/,
  );
  assert.throws(
    () =>
      requireP1BootstrapBudget(
        { ...estimate, buyerTotalTinybars: P1_BUYER_CAP_TINYBARS + 1n },
        P1_DEPLOYER_CAP_TINYBARS,
        P1_BUYER_CAP_TINYBARS + 1n,
      ),
    /p1_buyer_cap_exceeded/,
  );
  assert.doesNotThrow(() =>
    requireP1ResumeBudget(estimate, 12n, 8n, {
      deployer: P1_DEPLOYER_CAP_TINYBARS - 12n,
      buyer: P1_BUYER_CAP_TINYBARS - 8n,
    }),
  );
  assert.throws(
    () =>
      requireP1ResumeBudget(estimate, 11n, 8n, {
        deployer: P1_DEPLOYER_CAP_TINYBARS - 12n,
        buyer: P1_BUYER_CAP_TINYBARS - 8n,
      }),
    /p1_deployer_balance_insufficient/,
  );
});

test("subscription deployment rejects a missing dependency before a paid create", () => {
  assert.throws(
    () =>
      subscriptionDeploymentArguments({
        registryAddress,
        tokenAddress,
        adminAddress,
        pythAddress,
        vaultAddress: getAddress("0x0000000000000000000000000000000000000000"),
      }),
    /invalid_subscription_deployment_dependency/,
  );
});

test("P1 pre-topup budget reserves the transfer principal and every remaining external fee", () => {
  assert.equal(P1_BUYER_TOPUP_TINYBARS, 500_000_000n);
  assert.doesNotThrow(() =>
    requireP1PreTopupBudget(
      6_000_000_000n,
      499_800_000n,
      { deployer: 100_000_000n, buyer: 0n },
      false,
    ),
  );
  assert.throws(
    () =>
      requireP1PreTopupBudget(
        5_599_999_999n,
        499_800_000n,
        { deployer: 100_000_000n, buyer: 0n },
        false,
      ),
    /p1_deployer_balance_insufficient/,
  );
  assert.throws(
    () =>
      requireP1PreTopupBudget(
        6_000_000_000n,
        299_999_999n,
        { deployer: 100_000_000n, buyer: 0n },
        false,
      ),
    /p1_buyer_balance_insufficient/,
  );
});

test("P1 jumbo handoff derives the next two nonces only from a completed P0 journal", () => {
  const contract = (entityId: string) => ({
    phase: "pyth",
    attempts: [{ status: "consensus", entity_id: entityId }],
  });
  const state = {
    version: 2,
    network: "hedera:testnet",
    source_commit: "859113ec53e59a3abaeeb3333ae71ef1fa09615e",
    manifest_hash:
      "282c5851e4aee85fc071ab0a4a45e4ea5f86766c16c83d68c4f207e3094c3dab",
    deployed_runtime_hashes: Object.fromEntries(
      [
        "ReceiverSetup",
        "ReceiverImplementationHalf",
        "WormholeReceiver",
        "PythUpgradable",
        "ERC1967Proxy",
        "SignalLedger",
      ].map((name) => [name, `0x${"12".repeat(32)}`]),
    ),
    identity: {
      operator_id: "0.0.1001",
      operator_key_sha256: "cd".repeat(32),
      registry_address: registryAddress,
      deployer_public_key: "02" + "11".repeat(32),
      deployer_evm_address: adminAddress,
      deployer_account_id: "0.0.2002",
    },
    addresses: {
      ERC1967Proxy: pythAddress,
      SignalLedger: getAddress("0x0000000000000000000000000000000000006000"),
    },
    steps: {
      "account.deployer": contract("0.0.2002"),
      "contract.ReceiverSetup": contract("0.0.3001"),
      "contract.ReceiverImplementationHalf": contract("0.0.3002"),
      "contract.WormholeReceiver": contract("0.0.3003"),
      "contract.PythUpgradable": contract("0.0.3004"),
      "contract.ERC1967Proxy": contract("0.0.3005"),
      "contract.SignalLedger": contract("0.0.3006"),
      "receiver.rotate": { phase: "pyth", attempts: [{ status: "consensus" }] },
    },
    anchor: { latest_sequence: "1030" },
    finalized_anchor: { latest_sequence: "1030" },
    proof: { authentic: true, corrupted_rejected: true },
  };

  const handoff = deriveP1JumboHandoff(state);
  assert.deepEqual(handoff, {
    accountId: "0.0.2002",
    deployerPublicKey: "02" + "11".repeat(32),
    deployerEvmAddress: adminAddress,
    operatorId: "0.0.1001",
    operatorKeySha256: "cd".repeat(32),
    registryAddress,
    pythAddress,
    p0ManifestHash:
      "282c5851e4aee85fc071ab0a4a45e4ea5f86766c16c83d68c4f207e3094c3dab",
    nextNonce: 6,
    subscriptionVaultNonce: 6,
    subscriptionLedgerNonce: 7,
  });
  const vault = getAddress("0xD61c4C96B2cb64826e237E43ab8fafca03D1299e");
  const ledger = getAddress("0xCd40f484D4Ead7789A360A3BEcbf0E7962E7e78d");
  const successor = {
    version: 1,
    network: "hedera:testnet",
    p0_manifest_hash: handoff.p0ManifestHash,
    identity: {
      operator_id: handoff.operatorId,
      operator_key_sha256: handoff.operatorKeySha256,
      registry_address: handoff.registryAddress,
      deployer_public_key: handoff.deployerPublicKey,
      deployer_evm_address: handoff.deployerEvmAddress,
      deployer_account_id: handoff.accountId,
    },
    nonces: { subscription_vault: 6, subscription_ledger: 7 },
    addresses: { SubscriptionVault: vault, SubscriptionLedger: ledger },
    contract_ids: {
      SubscriptionVault: "0.0.4001",
      SubscriptionLedger: "0.0.4002",
    },
    steps: {
      "contract.SubscriptionVault": contract("0.0.4001"),
      "contract.SubscriptionLedger": contract("0.0.4002"),
    },
  };
  assert.equal(completedP1JumboNonce(successor, handoff), 8);
  assert.throws(
    () =>
      completedP1JumboNonce(
        {
          ...successor,
          steps: {
            ...successor.steps,
            "contract.Future": contract("0.0.4003"),
          },
        },
        handoff,
      ),
    /p1_successor_journal_incomplete/,
  );
  assert.deepEqual(
    deriveP1JumboHandoff({
      ...state,
      steps: {
        ...state.steps,
        "contract.FutureP0Step": contract("0.0.3007"),
      },
    }).subscriptionVaultNonce,
    7,
  );
  assert.throws(
    () =>
      deriveP1JumboHandoff({
        ...state,
        proof: { authentic: true, corrupted_rejected: false },
      }),
    /p0_handoff_incomplete/,
  );
  assert.throws(
    () =>
      deriveP1JumboHandoff({
        ...state,
        steps: {
          ...state.steps,
          "contract.SignalLedger": {
            phase: "full",
            attempts: [{ status: "submitted", entity_id: "0.0.3006" }],
          },
        },
      }),
    /p0_handoff_incomplete/,
  );
  assert.throws(
    () =>
      deriveP1JumboHandoff({
        ...state,
        steps: Object.fromEntries(
          Object.entries(state.steps).filter(
            ([id]) => id !== "receiver.rotate",
          ),
        ),
      }),
    /p0_handoff_incomplete/,
  );
});
