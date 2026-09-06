import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { keccak256, type Abi, type Hex } from "viem";

export type SubscriptionArtifact = {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableRanges: { start: number; length: number }[];
};

const EXPECTED = Object.freeze({
  SubscriptionVault: {
    buildInfoId: "solc-0_8_28-f23d3e783486ab357f0c65c3b4c57e85fb8a2156",
    sourceSha256:
      "d0e8eba1b7bfce51a850c8c777a07687bfcbf232106cb1108fae6c2e6d35a652",
    creationHash:
      "0x5dea4c986b5727636e9b1aa3c2c960eebb9b9b18b832c0c45f4e25ec02743f36",
    runtimeHash:
      "0xf3eccd526fa5563fe3e596582b120814ab12fc951992c19fd641dc29a7697d64",
    settingsSha256:
      "bfac1d106096729a9dd939aabcdbcb4c995c2b81dadc31808397cdbf15a5176d",
  },
  SubscriptionLedger: {
    buildInfoId: "solc-0_8_28-a3f70db0680bd5ada2386af7413f187d925593a5",
    sourceSha256:
      "719723500d3be144004fc37659b9eaae9fa7debb4b3c4ecf507cbcb87e4bd4d7",
    creationHash:
      "0xf17638d0ddac44cdd56d3c15924b19af9b8e68b594779fd4eede7dcda3aa21e1",
    runtimeHash:
      "0x16b0a4297df4c6f7c64b6e2df3e73a2c1cb8d6e4fffca4e5f48bcf6519d59b9c",
    settingsSha256:
      "394fa363ffb39a1a3e7241dcfec3401f167b43745459d46b6938c62c40fcd175",
  },
});
const SOLC = "0.8.28+commit.7893614a";
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function load(name: keyof typeof EXPECTED): SubscriptionArtifact {
  const sourcePath = `contracts/${name}.sol`;
  const raw = JSON.parse(
    readFileSync(`artifacts/contracts/${name}.sol/${name}.json`, "utf8"),
  ) as Record<string, any>;
  const build = JSON.parse(
    readFileSync(
      `artifacts/build-info/${String(raw.buildInfoId)}.json`,
      "utf8",
    ),
  ) as Record<string, any>;
  const expected = EXPECTED[name];
  const source = readFileSync(sourcePath, "utf8");
  const checks = {
    buildInfoId: String(raw.buildInfoId),
    sourceSha256: sha256(source),
    creationHash: keccak256(raw.bytecode as Hex),
    runtimeHash: keccak256(raw.deployedBytecode as Hex),
    settingsSha256: sha256(JSON.stringify(build.input?.settings)),
  };
  if (
    build.solcLongVersion !== SOLC ||
    build.input?.sources?.[`project/${sourcePath}`]?.content !== source ||
    Object.entries(expected).some(
      ([key, value]) => checks[key as keyof typeof checks] !== value,
    )
  )
    throw new Error(`subscription_artifact_mismatch:${name}`);
  if (name === "SubscriptionLedger") {
    const engine = readFileSync("contracts/OracleGradeEngine.sol", "utf8");
    if (
      sha256(engine) !==
        "9114dc4f24a1d6fd9a49c72d1f8f0c294b9af5106e5cbf0d54bbde21b08d4f15" ||
      build.input?.sources?.["project/contracts/OracleGradeEngine.sol"]
        ?.content !== engine
    )
      throw new Error("subscription_artifact_mismatch:OracleGradeEngine");
  }
  return {
    abi: raw.abi as Abi,
    bytecode: raw.bytecode as Hex,
    deployedBytecode: raw.deployedBytecode as Hex,
    immutableRanges: Object.values(raw.immutableReferences ?? {}).flat() as {
      start: number;
      length: number;
    }[],
  };
}

export function loadSubscriptionArtifacts() {
  return {
    SubscriptionVault: load("SubscriptionVault"),
    SubscriptionLedger: load("SubscriptionLedger"),
  } as const;
}

export const SUBSCRIPTION_EXPECTED_ARTIFACTS = EXPECTED;
