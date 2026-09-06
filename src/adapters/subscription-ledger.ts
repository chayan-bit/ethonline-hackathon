import { keccak256, stringToHex, type Address, type Hex } from "viem";
import type { Config } from "./config.ts";
import {
  accountAddress,
  artifact,
  executeContract,
  publicClient,
} from "./hedera.ts";
import { signalTuple } from "./ledger.ts";
import { SCHEMA_ID } from "../protocol/signal.ts";
import {
  SUBSCRIPTION_HORIZON_SECONDS,
} from "../protocol/subscription.ts";
import { subscriptionProviderMetadata } from "../service/subscription-metadata.ts";
import type { Prepared } from "../service/gateway.ts";
import type { Store } from "../service/store.ts";

export class SubscriptionLedgerAdapter {
  readonly abi = artifact("SubscriptionLedger").abi;
  private readonly client;

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly execute: typeof executeContract = executeContract,
    private readonly now = () => Math.floor(Date.now() / 1000),
  ) {
    this.client = publicClient(config);
  }

  get address(): Address {
    if (!this.config.subscriptionLedgerAddress)
      throw new Error("subscription_ledger_not_configured");
    return this.config.subscriptionLedgerAddress;
  }

  private get agentId(): string {
    if (!this.config.subscriptionAgentId)
      throw new Error("subscription_agent_not_configured");
    return this.config.subscriptionAgentId;
  }

  async provider() {
    if (!this.config.registryAddress || !this.config.subscriptionPayeeId)
      throw new Error("registry_not_configured");
    const values = (await this.client.readContract({
      address: this.config.registryAddress,
      abi: artifact("AgentRegistry").abi,
      functionName: "getAgent",
      args: [BigInt(this.agentId)],
    })) as readonly unknown[];
    const metadataHash = keccak256(
      stringToHex(JSON.stringify(subscriptionProviderMetadata(this.config))),
    );
    if (
      values[4] !== metadataHash ||
      String(values[2]).toLowerCase() !==
        accountAddress(this.config.subscriptionPayeeId).toLowerCase() ||
      (Number(values[7]) & 2) === 0
    )
      throw new Error("registry_metadata_mismatch");
    return { agent_id: this.agentId, active: values[3] === true };
  }

  async oracleAddress(): Promise<Address> {
    return (await this.client.readContract({
      address: this.address,
      abi: this.abi,
      functionName: "pyth",
    })) as Address;
  }

  async commitment(requestId: string) {
    const values = (await this.client.readContract({
      address: this.address,
      abi: this.abi,
      functionName: "getCommitment",
      args: [requestId as Hex],
    })) as readonly unknown[];
    return {
      exists: values[0] === true,
      subscription_id: values[1] as Hex,
      agent_id: String(values[2]),
      hash: values[3] as Hex,
      committed_at: Number(values[4]),
      issued_at: Number(values[5]),
      target_time: Number(values[6]),
      price_feed_id: values[7] as Hex,
      subscriber: values[8] as Address,
      revealed: values[9] === true,
    };
  }

  async commit(subscriptionId: string, prepared: Prepared) {
    if (!/^0x[0-9a-f]{64}$/.test(subscriptionId))
      throw new Error("invalid_subscription_id");
    const signal = prepared.signal;
    if (
      signal.agent_id !== this.agentId ||
      signal.target_time - signal.issued_at !== SUBSCRIPTION_HORIZON_SECONDS ||
      Math.abs(signal.issued_at - this.now()) > 30
    )
      throw new Error("invalid_subscription_commit_timing");
    const current = await this.commitment(signal.request_id);
    if (current.exists) {
      if (
        current.subscription_id !== subscriptionId ||
        current.hash !== prepared.hash
      )
        throw new Error("commitment_conflict");
      const saved = this.store.get<{ transaction_id: string }>(
        "subscription_commit_receipts",
        signal.request_id,
      );
      if (!saved) throw new Error("commit_receipt_pending");
      return saved;
    }
    const result = await this.execute(
      this.config,
      this.address,
      this.abi,
      "commit",
      [
        subscriptionId,
        signal.request_id,
        BigInt(signal.agent_id),
        prepared.hash,
        SCHEMA_ID,
        BigInt(signal.issued_at),
        BigInt(signal.target_time),
        signal.price_feed_id,
      ],
    );
    this.store.put("subscription_commit_receipts", signal.request_id, result);
    return result;
  }

  async reveal(prepared: Prepared) {
    const current = await this.commitment(prepared.signal.request_id);
    if (current.revealed) return;
    return this.execute(this.config, this.address, this.abi, "reveal", [
      prepared.signal.request_id,
      signalTuple(prepared.signal),
      prepared.salt,
    ]);
  }

  async revealRecord(requestId: string) {
    const values = (await this.client.readContract({
      address: this.address,
      abi: this.abi,
      functionName: "getReveal",
      args: [requestId as Hex],
    })) as readonly unknown[];
    return { revealed: values[0] === true, revealed_at: Number(values[3]) };
  }

  async gradeRecord(requestId: string) {
    const values = (await this.client.readContract({
      address: this.address,
      abi: this.abi,
      functionName: "getGrade",
      args: [requestId as Hex],
    })) as readonly unknown[];
    return {
      graded: values[0] === true,
      oracle_excluded: values[1] === true,
      exclusion_reason: Number(values[2]),
      actual_return_bps: String(values[3]),
      absolute_error_bps: String(values[4]),
      direction_correct: values[5] === true,
      issue: values[6],
      target: values[7],
      finalized_at: Number(values[8]),
    };
  }

  grade(requestId: string, issue: Hex[], target: Hex[], feeTinybars: bigint) {
    return this.execute(
      this.config,
      this.address,
      this.abi,
      "grade",
      [requestId, issue, target],
      feeTinybars,
    );
  }
}
