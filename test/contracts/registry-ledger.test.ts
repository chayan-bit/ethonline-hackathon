import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, encodeAbiParameters, zeroAddress, zeroHash } from "viem";
import { network } from "hardhat";

const SCHEMA_ID = keccak256(Buffer.from("defi.return_forecast.v1"));
const FEED_ID = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" as `0x${string}`;
const NETWORK_ID = keccak256(Buffer.from("hedera:testnet"));
const PAYMENT_ASSET = zeroHash;
const NATIVE_PAYMENT_ID = "0.0.7162784@10000.000000000";
const paymentRef = (nativePaymentId: string) => keccak256(Buffer.from(`hedera:testnet/${nativePaymentId}`));
const MIN_LEAD = 300n;
const MAX_LEAD = 3_600n;
const ISSUE_TOLERANCE = 30n;
const ORACLE_WINDOW = 60n;
const MAX_CONFIDENCE_BPS = 100n;
const NEUTRAL_BAND_BPS = 5n;

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

type RevealView = readonly [boolean, unknown, `0x${string}`, bigint];
type GradeView = readonly [boolean, boolean, number, bigint, bigint, boolean, unknown, unknown, bigint];
type CommitmentView = readonly [boolean, bigint, `0x${string}`, `0x${string}`, bigint, bigint, bigint, `0x${string}`, number, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, bigint, `0x${string}`, boolean];

const signal = (requestId: `0x${string}`, issuedAt: bigint, targetTime: bigint): Signal => ({
  schemaId: SCHEMA_ID,
  requestId,
  agentId: 42n,
  priceFeedId: FEED_ID,
  issuedAt,
  targetTime,
  predictedReturnBps: -125,
  modelVersionHash: keccak256(Buffer.from("momentum-v1")),
  distributionCode: 1,
});

const signalHash = (payload: Signal, salt: `0x${string}`): `0x${string}` =>
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
        payload.schemaId,
        payload.requestId,
        payload.agentId,
        payload.priceFeedId,
        payload.issuedAt,
        payload.targetTime,
        payload.predictedReturnBps,
        payload.modelVersionHash,
        payload.distributionCode,
        salt,
      ],
    ),
  );

async function fixture() {
  const connection = await network.create();
  const [owner, gateway, buyer, revealer, stranger] = await connection.viem.getWalletClients();
  const registry = await connection.viem.deployContract("AgentRegistry");
  const pyth = await connection.viem.deployContract("MockPyth", [60n, 1n]);
  const ledger = await connection.viem.deployContract("SignalLedger", [
    registry.address,
    pyth.address,
    SCHEMA_ID,
    FEED_ID,
    MIN_LEAD,
    MAX_LEAD,
    ISSUE_TOLERANCE,
    ORACLE_WINDOW,
    MAX_CONFIDENCE_BPS,
    NEUTRAL_BAND_BPS,
  ]);
  await registry.write.registerAgent([
    42n,
    gateway.account.address,
    owner.account.address,
    "ipfs://metadata",
    keccak256(Buffer.from("metadata")),
    SCHEMA_ID,
    1,
  ]);
  return { connection, owner, gateway, buyer, revealer, stranger, registry, pyth, ledger };
}

async function committedFixture() {
  const f = await fixture();
  const now = BigInt(await f.connection.viem.getPublicClient().then((client) => client.getBlock().then((block) => block.timestamp)));
  const payload = signal("0x0000000000000000000000000000000000000000000000000000000000000001", now + 1n, now + MIN_LEAD + 5n);
  const salt = keccak256(Buffer.from("secret"));
  await f.ledger.write.commit(
    [
      payload.requestId,
      payload.agentId,
      signalHash(payload, salt),
      payload.schemaId,
      payload.issuedAt,
      payload.targetTime,
      payload.priceFeedId,
      1,
      paymentRef(NATIVE_PAYMENT_ID),
      f.buyer.account.address,
      f.owner.account.address,
      PAYMENT_ASSET,
      100n,
      NETWORK_ID,
      NATIVE_PAYMENT_ID,
    ],
    { account: f.gateway.account },
  );
  return { ...f, now, payload, salt };
}

test("registers, delegates, updates, and deactivates only by the owner", async () => {
  const f = await fixture();
  await assert.rejects(
    f.registry.write.setActive([42n, false], { account: f.stranger.account }),
    /NotAgentOwner|revert/i,
  );
  await f.registry.write.setActive([42n, false], { account: f.owner.account });
  assert.equal((await f.registry.read.isActive([42n])), false);
  await f.registry.write.setGateway([42n, zeroAddress], { account: f.owner.account });
  assert.equal(await f.registry.read.isAuthorized([42n, f.gateway.account.address]), false);
  await assert.rejects(
    f.ledger.write.commit(
      [
        "0x0000000000000000000000000000000000000000000000000000000000000002",
        42n,
        zeroHash,
        SCHEMA_ID,
        1n,
        301n,
        FEED_ID,
        1,
        zeroHash,
        f.buyer.account.address,
        f.owner.account.address,
        PAYMENT_ASSET,
        0n,
        NETWORK_ID,
        NATIVE_PAYMENT_ID,
      ],
      { account: f.gateway.account },
    ),
    /InactiveAgent|revert/i,
  );
});

test("exposes the canonical negative-return hash and rejects unauthorized commits", async () => {
  const f = await committedFixture();
  assert.equal(await f.ledger.read.computeSignalHash([f.payload, f.salt]), signalHash(f.payload, f.salt));
  await assert.rejects(
    f.ledger.write.commit(
      [f.payload.requestId, 42n, zeroHash, SCHEMA_ID, f.payload.issuedAt, f.payload.targetTime, FEED_ID, 1, zeroHash, f.buyer.account.address, f.owner.account.address, PAYMENT_ASSET, 100n, NETWORK_ID, NATIVE_PAYMENT_ID],
      { account: f.stranger.account },
    ),
    /NotAuthorizedCommitter|revert/i,
  );
});

test("rejects reveal before target and accepts exactly one permissionless reveal at target", async () => {
  const f = await committedFixture();
  await assert.rejects(
    f.ledger.write.reveal([f.payload.requestId, f.payload, f.salt], { account: f.revealer.account }),
    /NotExpired|revert/i,
  );
  await f.connection.viem.getTestClient().then((client) => client.increaseTime({ seconds: Number(MIN_LEAD + 5n) }));
  await f.ledger.write.reveal([f.payload.requestId, f.payload, f.salt], { account: f.revealer.account });
  const revealed = (await f.ledger.read.getReveal([f.payload.requestId])) as RevealView;
  assert.equal(revealed[0], true);
  await assert.rejects(
    f.ledger.write.reveal([f.payload.requestId, f.payload, f.salt], { account: f.owner.account }),
    /AlreadyRevealed|revert/i,
  );
});

test("wrong salt or payload cannot poison reveal state", async () => {
  const f = await committedFixture();
  await f.connection.viem.getTestClient().then((client) => client.increaseTime({ seconds: Number(MIN_LEAD + 5n) }));
  const wrong = { ...f.payload, predictedReturnBps: -124 };
  await assert.rejects(
    f.ledger.write.reveal([f.payload.requestId, wrong, f.salt], { account: f.revealer.account }),
    /HashMismatch|PayloadMismatch|revert/i,
  );
  const revealed = (await f.ledger.read.getReveal([f.payload.requestId])) as RevealView;
  assert.equal(revealed[0], false);
});

test("reveal has no financial transfer and grade is independent", async () => {
  const f = await committedFixture();
  await f.connection.viem.getTestClient().then((client) => client.increaseTime({ seconds: Number(MIN_LEAD + 5n) }));
  const before = await f.connection.viem.getPublicClient().then((client) => client.getBalance({ address: f.owner.account.address }));
  await f.ledger.write.reveal([f.payload.requestId, f.payload, f.salt], { account: f.revealer.account });
  const after = await f.connection.viem.getPublicClient().then((client) => client.getBalance({ address: f.owner.account.address }));
  assert.equal(after, before);
});

test("grade authenticates both Pyth windows and stores return/error/direction evidence", async () => {
  const f = await committedFixture();
  const testClient = await f.connection.viem.getTestClient();
  await testClient.increaseTime({ seconds: Number(MIN_LEAD + 5n) });
  await f.ledger.write.reveal([f.payload.requestId, f.payload, f.salt], { account: f.revealer.account });
  const issueData = await f.pyth.read.createPriceFeedUpdateData([FEED_ID, 100_000n, 10n, -2, 100_000n, 10n, f.payload.issuedAt, 0n]);
  const targetData = await f.pyth.read.createPriceFeedUpdateData([FEED_ID, 99_000n, 10n, -2, 99_000n, 10n, f.payload.targetTime, 0n]);
  const fee = await f.pyth.read.getUpdateFee([[issueData, targetData]]);
  await f.ledger.write.grade([f.payload.requestId, [issueData], [targetData]], { account: f.revealer.account, value: fee });
  const grade = (await f.ledger.read.getGrade([f.payload.requestId])) as GradeView;
  assert.equal(grade[0], true);
  assert.equal(grade[3], -100n);
  assert.equal(grade[4], 25n);
  assert.equal(grade[5], true);
});

test("a valid reveal survives an invalid oracle proof and can be graded later", async () => {
  const f = await committedFixture();
  const testClient = await f.connection.viem.getTestClient();
  await testClient.increaseTime({ seconds: Number(MIN_LEAD + 5n) });
  await f.ledger.write.reveal([f.payload.requestId, f.payload, f.salt], { account: f.revealer.account });
  await assert.rejects(
    f.ledger.write.grade([f.payload.requestId, [], []], { account: f.revealer.account }),
    /PriceFeedNotFound|revert/i,
  );
  assert.equal(((await f.ledger.read.getReveal([f.payload.requestId])) as RevealView)[0], true);
  assert.equal(((await f.ledger.read.getGrade([f.payload.requestId])) as GradeView)[0], false);
});

test("normalizes differing Pyth exponents with signed, truncated basis-point arithmetic", async () => {
  const f = await committedFixture();
  const testClient = await f.connection.viem.getTestClient();
  await testClient.increaseTime({ seconds: Number(MIN_LEAD + 5n) });
  await f.ledger.write.reveal([f.payload.requestId, f.payload, f.salt], { account: f.revealer.account });
  const issueData = await f.pyth.read.createPriceFeedUpdateData([FEED_ID, 100_000n, 10n, -2, 100_000n, 10n, f.payload.issuedAt, 0n]);
  const targetData = await f.pyth.read.createPriceFeedUpdateData([FEED_ID, 10_050n, 10n, -1, 10_050n, 10n, f.payload.targetTime, 0n]);
  const fee = await f.pyth.read.getUpdateFee([[issueData, targetData]]);
  await f.ledger.write.grade([f.payload.requestId, [issueData], [targetData]], { account: f.revealer.account, value: fee });
  const grade = (await f.ledger.read.getGrade([f.payload.requestId])) as GradeView;
  assert.equal(grade[3], 50n);
  assert.equal(grade[4], 175n);
  assert.equal(grade[5], false);
});

test("rejects oracle returns outside the shared safe arithmetic range", async () => {
  const f = await committedFixture();
  const testClient = await f.connection.viem.getTestClient();
  await testClient.increaseTime({ seconds: Number(MIN_LEAD + 5n) });
  await f.ledger.write.reveal([f.payload.requestId, f.payload, f.salt], { account: f.revealer.account });
  const issueData = await f.pyth.read.createPriceFeedUpdateData([FEED_ID, 1n, 0n, 0, 1n, 0n, f.payload.issuedAt, 0n]);
  const targetData = await f.pyth.read.createPriceFeedUpdateData([FEED_ID, (2n ** 63n) - 1n, 0n, 0, (2n ** 63n) - 1n, 0n, f.payload.targetTime, 0n]);
  const fee = await f.pyth.read.getUpdateFee([[issueData, targetData]]);
  await assert.rejects(
    f.ledger.write.grade([f.payload.requestId, [issueData], [targetData]], { account: f.revealer.account, value: fee }),
    /ArithmeticOutOfRange|revert/i,
  );
  const grade = (await f.ledger.read.getGrade([f.payload.requestId])) as GradeView;
  assert.equal(grade[0], false);
  assert.equal(grade[1], false);
});

test("high-confidence authenticated observations are excluded from quality only", async () => {
  const f = await committedFixture();
  const testClient = await f.connection.viem.getTestClient();
  await testClient.increaseTime({ seconds: Number(MIN_LEAD + 5n) });
  await f.ledger.write.reveal([f.payload.requestId, f.payload, f.salt], { account: f.revealer.account });
  const issueData = await f.pyth.read.createPriceFeedUpdateData([FEED_ID, 100_000n, 2_000n, -2, 100_000n, 2_000n, f.payload.issuedAt, 0n]);
  const targetData = await f.pyth.read.createPriceFeedUpdateData([FEED_ID, 99_000n, 2_000n, -2, 99_000n, 2_000n, f.payload.targetTime, 0n]);
  const fee = await f.pyth.read.getUpdateFee([[issueData, targetData]]);
  await f.ledger.write.grade([f.payload.requestId, [issueData], [targetData]], { account: f.revealer.account, value: fee });
  const grade = (await f.ledger.read.getGrade([f.payload.requestId])) as GradeView;
  assert.equal(grade[0], false);
  assert.equal(grade[1], true);
  assert.equal(((await f.ledger.read.getReveal([f.payload.requestId])) as RevealView)[0], true);
});

test("rejects duplicate request and payment references", async () => {
  const f = await committedFixture();
  await assert.rejects(
    f.ledger.write.commit([f.payload.requestId, f.payload.agentId, signalHash(f.payload, f.salt), f.payload.schemaId, f.payload.issuedAt, f.payload.targetTime, f.payload.priceFeedId, 1, paymentRef("0.0.7162784@10000.000000001"), f.buyer.account.address, f.owner.account.address, PAYMENT_ASSET, 100n, NETWORK_ID, "0.0.7162784@10000.000000001"], { account: f.gateway.account }),
    /DuplicateRequest|revert/i,
  );
  const second = { ...f.payload, requestId: "0x0000000000000000000000000000000000000000000000000000000000000003" as `0x${string}` };
  await assert.rejects(
    f.ledger.write.commit([second.requestId, second.agentId, signalHash(second, f.salt), second.schemaId, second.issuedAt, second.targetTime, second.priceFeedId, 1, paymentRef(NATIVE_PAYMENT_ID), f.buyer.account.address, f.owner.account.address, PAYMENT_ASSET, 100n, NETWORK_ID, NATIVE_PAYMENT_ID], { account: f.gateway.account }),
    /DuplicatePaymentReference|revert/i,
  );
});

test("commit binds P0 payment mode, HBAR asset, and Hedera testnet", async () => {
  const f = await committedFixture();
  const args = [
    "0x0000000000000000000000000000000000000000000000000000000000000004" as `0x${string}`,
    f.payload.agentId,
    signalHash(f.payload, f.salt),
    f.payload.schemaId,
    f.payload.issuedAt,
    f.payload.targetTime,
    f.payload.priceFeedId,
    2,
    paymentRef(NATIVE_PAYMENT_ID),
    f.buyer.account.address,
    f.owner.account.address,
    PAYMENT_ASSET,
    100n,
    NETWORK_ID,
    NATIVE_PAYMENT_ID,
  ] as const;
  await assert.rejects(f.ledger.write.commit(args, { account: f.gateway.account }), /InvalidPaymentTerms|revert/i);
  await assert.rejects(
    f.ledger.write.commit([...args.slice(0, 7), 1, paymentRef("0.0.7162784@10000.000000002"), ...args.slice(9, 11), keccak256(Buffer.from("other-asset")), 100n, NETWORK_ID, "0.0.7162784@10000.000000002"] as const, { account: f.gateway.account }),
    /InvalidPaymentTerms|revert/i,
  );
  await assert.rejects(
    f.ledger.write.commit([...args.slice(0, 7), 1, paymentRef("0.0.7162784@10000.000000003"), ...args.slice(9, 13), keccak256(Buffer.from("other-network")), "0.0.7162784@10000.000000003"] as const, { account: f.gateway.account }),
    /InvalidPaymentTerms|revert/i,
  );
});

test("commit stores no transferable incentive and immutable payment terms", async () => {
  const f = await committedFixture();
  const record = (await f.ledger.read.getCommitment([f.payload.requestId])) as CommitmentView;
  assert.equal(record[1], f.payload.agentId);
  assert.equal(record[2], f.payload.schemaId);
  assert.equal((record[11] as string).toLowerCase(), f.owner.account.address.toLowerCase());
  assert.equal(record[13], 100n);
  assert.equal(await f.connection.viem.getPublicClient().then((client) => client.getBalance({ address: f.ledger.address })), 0n);
});
