import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  zeroAddress,
  type Address,
} from "viem";
import { network } from "hardhat";

const SUCCESS = 22n;
const ASSOCIATION_FAILED = 15n;
const TRANSFER_FAILED = 17n;
const DAY = 86_400n;
const DEPOSIT = 1_000n;
const RATE = 10n;
const DURATION = DEPOSIT / RATE;
const RESERVE = 10_000_000n;
const id = (value: number) =>
  `0x${value.toString(16).padStart(64, "0")}` as const;
const SUBSCRIPTION_SCHEMA = id(99);

async function fixture(scheduleCode = SUCCESS) {
  const connection = await network.create();
  const [admin, buyer, provider, caller] =
    await connection.viem.getWalletClients();
  const registry = await connection.viem.deployContract(
    "MockSubscriptionRegistry",
  );
  const hts = await connection.viem.deployContract("MockHts");
  const tokenContract = await connection.viem.deployContract("MockHtsToken", [
    hts.address,
  ]);
  const token = getAddress(tokenContract.address);
  const scheduler = await connection.viem.deployContract("MockScheduleService");
  const checkpointCaller = await connection.viem.deployContract(
    "MockCheckpointCaller",
  );
  await scheduler.write.setScheduleCode([scheduleCode]);
  await registry.write.setAgent([
    1n,
    provider.account.address,
    admin.account.address,
    true,
    SUBSCRIPTION_SCHEMA,
    2,
  ]);
  const factory = await connection.viem.deployContract("SubscriptionVault", [
    registry.address,
    hts.address,
    scheduler.address,
    token,
    admin.account.address,
    SUBSCRIPTION_SCHEMA,
  ]);
  await hts.write.mint([token, buyer.account.address, 10_000n]);
  await hts.write.approve([
    token,
    buyer.account.address,
    factory.address,
    DEPOSIT,
  ]);
  const publicClient = await connection.viem.getPublicClient();
  const now = (await publicClient.getBlock()).timestamp;
  return {
    connection,
    publicClient,
    admin,
    buyer,
    provider,
    caller,
    token,
    tokenContract,
    registry,
    hts,
    scheduler,
    checkpointCaller,
    factory,
    now,
  };
}

test("active x402-only agents are rejected before escrow creation or deposit funding", async () => {
  const f = await fixture();
  await f.registry.write.setAgent([
    1n,
    f.provider.account.address,
    f.admin.account.address,
    true,
    SUBSCRIPTION_SCHEMA,
    1,
  ]);

  await assert.rejects(create(f), /UnsupportedSubscriptionAgent|revert/i);
  assert.equal(await f.factory.read.subscriptionEscrow([id(1)]), zeroAddress);
  assert.equal(await f.hts.read.transferCalls(), 0n);
  assert.equal(
    await f.hts.read.balanceOf([f.token, f.buyer.account.address]),
    10_000n,
  );
});

async function create(
  f: Awaited<ReturnType<typeof fixture>>,
  subscriptionId = id(1),
  start = f.now + 10n,
  reserve = RESERVE,
) {
  await f.factory.write.createSubscription(
    [subscriptionId, 1n, start, start + DURATION, RATE, DEPOSIT, 20n, 500_000n],
    {
      account: f.buyer.account,
      value: reserve,
    },
  );
  const escrowAddress = (await f.factory.read.subscriptionEscrow([
    subscriptionId,
  ])) as Address;
  assert.notEqual(escrowAddress, zeroAddress);
  return f.connection.viem.getContractAt("SubscriptionEscrow", escrowAddress);
}

test("AT-23 checkpoint is idempotent and mid-term cancellation conserves deposit and isolated reserve", async () => {
  const f = await fixture();
  const escrow = await create(f);
  assert.equal(await f.hts.read.balanceOf([f.token, escrow.address]), DEPOSIT);
  assert.equal(
    (
      (await f.hts.read.allowance([
        f.token,
        f.buyer.account.address,
        f.factory.address,
      ])) as readonly [bigint, bigint]
    )[1],
    0n,
  );

  await f.connection.viem
    .getTestClient()
    .then((client) => client.setNextBlockTimestamp({ timestamp: f.now + 60n }));
  await f.checkpointCaller.write.callTwice([escrow.address]);
  const paid = await escrow.read.paid();
  assert.equal(paid, 500n);
  assert.equal(
    await f.hts.read.balanceOf([f.token, f.provider.account.address]),
    500n,
  );

  await escrow.write.cancel([], { account: f.buyer.account });
  const finalPaid = await escrow.read.paid();
  const buyerBalance = await f.hts.read.balanceOf([
    f.token,
    f.buyer.account.address,
  ]);
  assert.equal(finalPaid, 510n);
  assert.equal(buyerBalance, 9_490n);
  assert.equal(finalPaid + buyerBalance - 9_000n, DEPOSIT);
  assert.equal(
    await f.publicClient.getBalance({ address: escrow.address }),
    0n,
  );
  assert.equal(await escrow.read.isEntitled([f.buyer.account.address]), false);
  assert.equal(((await escrow.read.terms()) as readonly unknown[])[10], true);
});

test("AT-23 cancel at start and close at natural end settle exact value without overpaying provider", async () => {
  const f = await fixture();
  const first = await create(f, id(1), f.now + 100n);
  await first.write.cancel([], { account: f.buyer.account });
  assert.equal(
    await f.hts.read.balanceOf([f.token, f.provider.account.address]),
    0n,
  );
  assert.equal(
    await f.hts.read.balanceOf([f.token, f.buyer.account.address]),
    10_000n,
  );

  await f.hts.write.approve([
    f.token,
    f.buyer.account.address,
    f.factory.address,
    DEPOSIT,
  ]);
  const secondStart = f.now + 110n;
  const second = await create(f, id(2), secondStart, RESERVE);
  await f.connection.viem
    .getTestClient()
    .then((client) =>
      client.setNextBlockTimestamp({ timestamp: secondStart + DURATION }),
    );
  await second.write.close([], { account: f.caller.account });
  assert.equal(
    await f.hts.read.balanceOf([f.token, f.provider.account.address]),
    DEPOSIT,
  );
  assert.equal(await second.read.paid(), DEPOSIT);
  assert.equal(await second.read.isEntitled([f.buyer.account.address]), false);
});

test("AT-24 HTS association and transfer failures revert creation or settlement without partial accounting", async () => {
  const f = await fixture();
  await f.hts.write.setAssociationCode([ASSOCIATION_FAILED]);
  await assert.rejects(create(f), /HtsFailure|revert/i);
  assert.equal(await f.factory.read.subscriptionEscrow([id(1)]), zeroAddress);
  assert.equal(
    await f.hts.read.balanceOf([f.token, f.buyer.account.address]),
    10_000n,
  );

  await f.hts.write.setAssociationCode([SUCCESS]);
  const escrow = await create(f);
  await f.connection.viem
    .getTestClient()
    .then((client) => client.setNextBlockTimestamp({ timestamp: f.now + 60n }));
  await f.hts.write.failTransferAt([2n, TRANSFER_FAILED]);
  await assert.rejects(
    escrow.write.cancel([], { account: f.buyer.account }),
    /HtsFailure|revert/i,
  );
  assert.equal(await escrow.read.paid(), 0n);
  assert.equal(await f.hts.read.balanceOf([f.token, escrow.address]), DEPOSIT);
});

test("AT-24 scheduler failure and pause never block manual exits or spend another subscription reserve", async () => {
  const f = await fixture(370n);
  const first = await create(f, id(1));
  await f.hts.write.approve([
    f.token,
    f.buyer.account.address,
    f.factory.address,
    DEPOSIT,
  ]);
  const second = await create(f, id(2));
  const secondReserve = await f.publicClient.getBalance({
    address: second.address,
  });

  await first.write.requestSchedule([], { account: f.buyer.account });
  assert.equal(await first.read.nextScheduledAt(), 0n);
  assert.equal(
    await f.publicClient.getBalance({ address: second.address }),
    secondReserve,
  );

  await f.factory.write.setPaused([true], { account: f.admin.account });
  await f.hts.write.approve([
    f.token,
    f.buyer.account.address,
    f.factory.address,
    DEPOSIT,
  ]);
  await assert.rejects(create(f, id(3)), /Paused|revert/i);
  await first.write.cancel([], { account: f.buyer.account });
  await second.write.cancel([], { account: f.buyer.account });
  assert.equal(await f.publicClient.getBalance({ address: first.address }), 0n);
  assert.equal(
    await f.publicClient.getBalance({ address: second.address }),
    0n,
  );
});

test("exact allowance, deposit formula, duration and reserve caps fail before funding", async () => {
  const f = await fixture();
  await f.hts.write.approve([
    f.token,
    f.buyer.account.address,
    f.factory.address,
    DEPOSIT + 1n,
  ]);
  await assert.rejects(create(f), /AllowanceMismatch|revert/i);
  await f.hts.write.approve([
    f.token,
    f.buyer.account.address,
    f.factory.address,
    DEPOSIT,
  ]);
  await assert.rejects(
    f.factory.write.createSubscription(
      [
        id(2),
        1n,
        f.now + 10n,
        f.now + 10n + DURATION,
        RATE,
        DEPOSIT - 1n,
        20n,
        500_000n,
      ],
      { account: f.buyer.account, value: RESERVE },
    ),
    /InvalidDeposit|revert/i,
  );
  await assert.rejects(
    f.factory.write.createSubscription(
      [
        id(3),
        1n,
        f.now + 10n,
        f.now + 10n + 31n * DAY,
        1n,
        31n * DAY,
        20n,
        500_000n,
      ],
      { account: f.buyer.account, value: RESERVE },
    ),
    /InvalidTerms|revert/i,
  );
  await assert.rejects(
    create(f, id(4), f.now + 10n, 100_000_001n),
    /InvalidReserve|revert/i,
  );
});

test("fee-on-transfer deposits revert before the subscription is recorded", async () => {
  const f = await fixture();
  await f.hts.write.setTransferCreditBps([9_000n]);
  await assert.rejects(create(f), /TokenBalanceMismatch|revert/i);
  assert.equal(await f.factory.read.subscriptionEscrow([id(1)]), zeroAddress);
  assert.equal(
    await f.hts.read.balanceOf([f.token, f.buyer.account.address]),
    10_000n,
  );
});

test("a changed outgoing transfer fee cannot underpay provider or consume extra escrow tokens", async () => {
  const f = await fixture();
  const escrow = await create(f);
  await f.hts.write.setTransferCreditBps([9_000n]);
  await f.connection.viem
    .getTestClient()
    .then((client) => client.setNextBlockTimestamp({ timestamp: f.now + 60n }));
  await assert.rejects(
    escrow.write.cancel([], { account: f.buyer.account }),
    /TokenBalanceMismatch|revert/i,
  );
  assert.equal(await escrow.read.paid(), 0n);
  assert.equal(
    await f.hts.read.balanceOf([f.token, f.provider.account.address]),
    0n,
  );
  assert.equal(await f.hts.read.balanceOf([f.token, escrow.address]), DEPOSIT);
});

test("contract buyer can atomically cancel to a payable reserve recipient", async () => {
  const f = await fixture();
  const rejecting =
    await f.connection.viem.deployContract("MockRejectingBuyer");
  await f.hts.write.mint([f.token, rejecting.address, DEPOSIT]);
  await f.hts.write.approve([
    f.token,
    rejecting.address,
    f.factory.address,
    DEPOSIT,
  ]);
  await rejecting.write.create(
    [
      f.factory.address,
      id(8),
      f.now + 10n,
      f.now + 10n + DURATION,
      RATE,
      DEPOSIT,
      20n,
      500_000n,
    ],
    { value: RESERVE },
  );
  const escrowAddress = (await f.factory.read.subscriptionEscrow([
    id(8),
  ])) as Address;
  const before = await f.publicClient.getBalance({
    address: f.caller.account.address,
  });
  await rejecting.write.cancelTo([escrowAddress, f.caller.account.address]);
  assert.equal(
    (await f.publicClient.getBalance({ address: f.caller.account.address })) -
      before,
    RESERVE,
  );
  assert.equal(
    await f.hts.read.balanceOf([f.token, rejecting.address]),
    DEPOSIT,
  );
  assert.equal(
    await (
      await f.connection.viem.getContractAt("SubscriptionEscrow", escrowAddress)
    ).read.closed(),
    true,
  );
});

test("scheduled payer fee depletion is isolated and HIP-1215 receives exact callback fields", async () => {
  const f = await fixture();
  const fee = 1_000_000n;
  const recipientBefore = await f.publicClient.getBalance({
    address: f.caller.account.address,
  });
  const escrow = await create(f);
  const scheduledAt = (await escrow.read.nextScheduledAt()) as bigint;
  const expectedCall = encodeFunctionData({
    abi: escrow.abi,
    functionName: "scheduledCheckpoint",
    args: [scheduledAt],
  });
  assert.equal(await f.scheduler.read.lastTo(), escrow.address);
  assert.equal(await f.scheduler.read.lastExpirySecond(), scheduledAt);
  assert.equal(await f.scheduler.read.lastGasLimit(), 500_000n);
  assert.equal(await f.scheduler.read.lastValue(), 0n);
  assert.equal(
    await f.scheduler.read.lastCallDataHash(),
    keccak256(expectedCall),
  );
  assert.equal(await escrow.read.automationReserveInitial(), RESERVE);
  assert.equal(await escrow.read.automationSpent(), 0n);
  await f.connection.viem
    .getTestClient()
    .then((client) =>
      client.setBalance({ address: escrow.address, value: RESERVE - fee }),
    );
  assert.equal(await escrow.read.automationSpent(), fee);

  await escrow.write.cancelTo([f.caller.account.address], {
    account: f.buyer.account,
  });
  const refunded =
    (await f.publicClient.getBalance({ address: f.caller.account.address })) -
    recipientBefore;
  assert.equal(refunded + fee, RESERVE);
  assert.equal(await escrow.read.automationRefunded(), refunded);
  assert.equal(await escrow.read.automationSpent(), fee);
});

test("successful scheduled callback is single-use and harmless after cancellation", async () => {
  const f = await fixture();
  const escrow = await create(f);
  await escrow.write.requestSchedule([], { account: f.buyer.account });
  const scheduledAt = (await escrow.read.nextScheduledAt()) as bigint;
  assert.ok(scheduledAt > 0n);
  const callData = encodeFunctionData({
    abi: escrow.abi,
    functionName: "scheduledCheckpoint",
    args: [scheduledAt],
  });
  await escrow.write.cancel([], { account: f.buyer.account });
  await f.scheduler.write.execute([escrow.address, callData]);
  assert.equal(await escrow.read.nextScheduledAt(), 0n);
  assert.equal(await escrow.read.paid(), 0n);
});

test("scheduled payer callback tolerates bounded EVM clock skew, pays only accrued value, and resumes once", async () => {
  const f = await fixture();
  const escrow = await create(f);
  const scheduledAt = (await escrow.read.nextScheduledAt()) as bigint;
  const start = (await escrow.read.start()) as bigint;
  const callData = encodeFunctionData({
    abi: escrow.abi,
    functionName: "scheduledCheckpoint",
    args: [scheduledAt],
  });
  assert.equal(scheduledAt, start + 20n);

  await f.connection.viem
    .getTestClient()
    .then((client) =>
      client.setNextBlockTimestamp({ timestamp: scheduledAt - 2n }),
    );
  const testClient = await f.connection.viem.getTestClient();
  await testClient.impersonateAccount({ address: escrow.address });
  await testClient.setBalance({ address: escrow.address, value: 10n ** 18n });
  const scheduledPayer = await f.connection.viem.getWalletClient(escrow.address);
  await escrow.write.scheduledCheckpoint([scheduledAt], {
    account: scheduledPayer.account,
  });
  await testClient.stopImpersonatingAccount({ address: escrow.address });

  const paid = RATE * (scheduledAt - 2n - start);
  const resumedAt = (await escrow.read.nextScheduledAt()) as bigint;
  assert.equal(await escrow.read.paid(), paid);
  assert.equal(
    await f.hts.read.balanceOf([f.token, f.provider.account.address]),
    paid,
  );
  assert.ok(resumedAt > scheduledAt);

  await escrow.write.scheduledCheckpoint([scheduledAt], {
    account: f.buyer.account,
  });
  assert.equal(await escrow.read.paid(), paid);
  assert.equal(await escrow.read.nextScheduledAt(), resumedAt);
});

test("too-early manual callback cannot pay or lock out authorized schedule recovery", async () => {
  const f = await fixture();
  const escrow = await create(f);
  const scheduledAt = (await escrow.read.nextScheduledAt()) as bigint;

  await f.connection.viem
    .getTestClient()
    .then((client) =>
      client.setNextBlockTimestamp({ timestamp: scheduledAt - 6n }),
    );
  await escrow.write.scheduledCheckpoint([scheduledAt], {
    account: f.caller.account,
  });
  assert.equal(await escrow.read.paid(), 0n);
  assert.equal(await escrow.read.nextScheduledAt(), scheduledAt);

  await f.connection.viem
    .getTestClient()
    .then((client) =>
      client.setNextBlockTimestamp({ timestamp: scheduledAt - 2n }),
    );
  await escrow.write.scheduledCheckpoint([scheduledAt], {
    account: f.caller.account,
  });
  assert.equal(await escrow.read.paid(), 0n);
  assert.equal(await escrow.read.nextScheduledAt(), scheduledAt);

  await f.connection.viem
    .getTestClient()
    .then((client) => client.setNextBlockTimestamp({ timestamp: scheduledAt }));
  await escrow.write.requestSchedule([], { account: f.buyer.account });
  assert.equal(await escrow.read.paid(), 0n);
  assert.ok(((await escrow.read.nextScheduledAt()) as bigint) > scheduledAt);
});

test("end callback checkpoints only so explicit close refunds the final observable reserve", async () => {
  const f = await fixture();
  const escrow = await create(f);
  const scheduledAt = (await escrow.read.nextScheduledAt()) as bigint;
  const callData = encodeFunctionData({
    abi: escrow.abi,
    functionName: "scheduledCheckpoint",
    args: [scheduledAt],
  });
  await f.connection.viem
    .getTestClient()
    .then((client) =>
      client.setNextBlockTimestamp({ timestamp: f.now + 10n + DURATION }),
    );
  await f.scheduler.write.execute([escrow.address, callData]);
  assert.equal(await escrow.read.paid(), DEPOSIT);
  assert.equal(await escrow.read.closed(), false);

  const finalReserve = 5_000_000n;
  await f.connection.viem
    .getTestClient()
    .then((client) =>
      client.setBalance({ address: escrow.address, value: finalReserve }),
    );
  const before = await f.publicClient.getBalance({
    address: f.caller.account.address,
  });
  await escrow.write.close([], { account: f.buyer.account });
  assert.equal(
    await f.publicClient.getBalance({ address: f.caller.account.address }),
    before,
  );
  assert.equal(await escrow.read.automationRefunded(), finalReserve);
  assert.equal(
    await f.publicClient.getBalance({ address: escrow.address }),
    0n,
  );
});
