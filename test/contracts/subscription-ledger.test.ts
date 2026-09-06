import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, keccak256, zeroHash } from "viem";
import { network } from "hardhat";

const SCHEMA_ID = keccak256(Buffer.from("defi.return_forecast.v1"));
const FEED_ID =
  "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" as const;
const SUBSCRIPTION_ID = `0x${"55".repeat(32)}` as const;
const REQUEST_ID = `0x${"11".repeat(32)}` as const;
const HORIZON = 900n;

type Signal = {
  schemaId: `0x${string}`;
  requestId: `0x${string}`;
  agentId: bigint;
  priceFeedId: `0x${string}`;
  issuedAt: bigint;
  targetTime: bigint;
  predictedReturnBps: number;
  modelVersionHash: `0x${string}`;
  distributionCode: number;
};
const signalHash = (signal: Signal, salt: `0x${string}`) =>
  keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "int32" },
        { type: "bytes32" },
        { type: "uint8" },
        { type: "bytes32" },
      ],
      [
        signal.schemaId,
        signal.requestId,
        signal.agentId,
        signal.priceFeedId,
        signal.issuedAt,
        signal.targetTime,
        signal.predictedReturnBps,
        signal.modelVersionHash,
        signal.distributionCode,
        salt,
      ],
    ),
  );

async function fixture() {
  const connection = await network.create();
  const [owner, gateway, buyer, grader, stranger] =
    await connection.viem.getWalletClients();
  const registry = await connection.viem.deployContract("AgentRegistry");
  const entitlement = await connection.viem.deployContract(
    "MockSubscriptionEntitlement",
  );
  const pyth = await connection.viem.deployContract("MockPyth", [60n, 1n]);
  const ledger = await connection.viem.deployContract("SubscriptionLedger", [
    registry.address,
    entitlement.address,
    pyth.address,
    SCHEMA_ID,
    FEED_ID,
    HORIZON,
    30n,
    60n,
    100n,
    5n,
  ]);
  await registry.write.registerAgent([
    2n,
    gateway.account.address,
    owner.account.address,
    "ipfs://subscription-agent",
    keccak256(Buffer.from("subscription-metadata")),
    SCHEMA_ID,
    2,
  ]);
  await entitlement.write.configure([
    SUBSCRIPTION_ID,
    2n,
    buyer.account.address,
    owner.account.address,
    true,
  ]);
  const now = (
    await connection.viem.getPublicClient().then((client) => client.getBlock())
  ).timestamp;
  const payload: Signal = {
    schemaId: SCHEMA_ID,
    requestId: REQUEST_ID,
    agentId: 2n,
    priceFeedId: FEED_ID,
    issuedAt: now + 1n,
    targetTime: now + 1n + HORIZON,
    predictedReturnBps: -125,
    modelVersionHash: keccak256(Buffer.from("momentum60.v1")),
    distributionCode: 1,
  };
  const salt = keccak256(Buffer.from("subscription-secret"));
  return {
    connection,
    owner,
    gateway,
    buyer,
    grader,
    stranger,
    registry,
    entitlement,
    pyth,
    ledger,
    payload,
    salt,
  };
}

async function committedFixture() {
  const f = await fixture();
  await f.ledger.write.commit(
    [
      SUBSCRIPTION_ID,
      REQUEST_ID,
      2n,
      signalHash(f.payload, f.salt),
      SCHEMA_ID,
      f.payload.issuedAt,
      f.payload.targetTime,
      FEED_ID,
    ],
    { account: f.gateway.account },
  );
  return f;
}

test("subscription commitment requires live entitlement and authorized agent 2 gateway", async () => {
  const f = await fixture();
  const args = [
    SUBSCRIPTION_ID,
    REQUEST_ID,
    2n,
    signalHash(f.payload, f.salt),
    SCHEMA_ID,
    f.payload.issuedAt,
    f.payload.targetTime,
    FEED_ID,
  ] as const;
  await assert.rejects(
    f.ledger.write.commit(args, { account: f.stranger.account }),
    /NotAuthorizedCommitter|revert/i,
  );
  await f.entitlement.write.setEntitled([false]);
  await assert.rejects(
    f.ledger.write.commit(args, { account: f.gateway.account }),
    /SubscriptionNotEntitled|revert/i,
  );
});

test("subscription ledger commits, reveals, and grades authenticated Pyth observations without payment evidence", async () => {
  const f = await committedFixture();
  const commitment = (await f.ledger.read.getCommitment([
    REQUEST_ID,
  ])) as readonly unknown[];
  assert.equal(commitment[0], true);
  assert.equal(commitment[1], SUBSCRIPTION_ID);
  const getter = f.ledger.abi.find(
    (item) => item.type === "function" && item.name === "getCommitment",
  );
  assert.ok(getter && getter.type === "function");
  assert.deepEqual(
    getter.outputs
      ?.map((output) => output.name)
      .filter((name) => /payment|amount/i.test(String(name))),
    [],
  );

  await f.connection.viem
    .getTestClient()
    .then((client) => client.increaseTime({ seconds: Number(HORIZON + 5n) }));
  await f.ledger.write.reveal([REQUEST_ID, f.payload, f.salt], {
    account: f.stranger.account,
  });
  const issue = await f.pyth.read.createPriceFeedUpdateData([
    FEED_ID,
    100_000n,
    10n,
    -2,
    100_000n,
    10n,
    f.payload.issuedAt,
    0n,
  ]);
  const target = await f.pyth.read.createPriceFeedUpdateData([
    FEED_ID,
    100_500n,
    10n,
    -2,
    100_500n,
    10n,
    f.payload.targetTime,
    0n,
  ]);
  const fee = await f.pyth.read.getUpdateFee([[issue, target]]);
  await f.ledger.write.grade([REQUEST_ID, [issue], [target]], {
    account: f.grader.account,
    value: fee,
  });
  const grade = (await f.ledger.read.getGrade([
    REQUEST_ID,
  ])) as readonly unknown[];
  assert.equal(grade[0], true);
  assert.equal(grade[3], 50n);
  assert.equal(grade[4], 175n);
  assert.equal(grade[5], false);
});

test("entitlement loss and provider deactivation after commit do not block reveal or oracle exclusion", async () => {
  const f = await committedFixture();
  await f.entitlement.write.setEntitled([false]);
  await f.registry.write.setActive([2n, false], { account: f.owner.account });
  await f.connection.viem
    .getTestClient()
    .then((client) => client.increaseTime({ seconds: Number(HORIZON + 5n) }));
  await f.ledger.write.reveal([REQUEST_ID, f.payload, f.salt], {
    account: f.stranger.account,
  });
  const issue = await f.pyth.read.createPriceFeedUpdateData([
    FEED_ID,
    -1n,
    0n,
    0,
    -1n,
    0n,
    f.payload.issuedAt,
    0n,
  ]);
  const target = await f.pyth.read.createPriceFeedUpdateData([
    FEED_ID,
    100n,
    0n,
    0,
    100n,
    0n,
    f.payload.targetTime,
    0n,
  ]);
  const fee = await f.pyth.read.getUpdateFee([[issue, target]]);
  await f.ledger.write.grade([REQUEST_ID, [issue], [target]], { value: fee });
  const grade = (await f.ledger.read.getGrade([
    REQUEST_ID,
  ])) as readonly unknown[];
  assert.equal(grade[0], false);
  assert.equal(grade[1], true);
  assert.equal(grade[2], 1);
  assert.equal(
    await f.connection.viem
      .getPublicClient()
      .then((client) => client.getBalance({ address: f.ledger.address })),
    0n,
  );
});

test("request identity is globally unique and bound to one explicit subscription", async () => {
  const f = await committedFixture();
  await assert.rejects(
    f.ledger.write.commit(
      [
        SUBSCRIPTION_ID,
        REQUEST_ID,
        2n,
        signalHash(f.payload, f.salt),
        SCHEMA_ID,
        f.payload.issuedAt,
        f.payload.targetTime,
        FEED_ID,
      ],
      { account: f.gateway.account },
    ),
    /DuplicateRequest|revert/i,
  );
  await assert.rejects(
    f.ledger.write.commit(
      [
        zeroHash,
        `0x${"22".repeat(32)}`,
        2n,
        signalHash(f.payload, f.salt),
        SCHEMA_ID,
        f.payload.issuedAt,
        f.payload.targetTime,
        FEED_ID,
      ],
      { account: f.gateway.account },
    ),
    /InvalidSubscriptionId|revert/i,
  );
});
