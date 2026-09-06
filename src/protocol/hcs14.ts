import { createHash } from "node:crypto";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAX_ASCII_LENGTH = 256;
const MAX_SKILLS = 256;

export type Hcs14IdentityInput = {
  registry: string;
  name: string;
  version: string;
  protocol: string;
  nativeId: string;
  skills: number[];
  uid: string;
  domain?: string;
};

export type Hcs14Identity = {
  uaid: string;
  target: "aid";
  standard: "HCS-14";
  status: "draft";
  canonical: string;
};

function fail(): never {
  throw new Error("invalid_hcs14_identity");
}

function boundedAscii(value: unknown, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") return fail();
  if (
    value.length > MAX_ASCII_LENGTH ||
    !/^[\x20-\x7e]*$/.test(value) ||
    /[;?#]/.test(value)
  )
    return fail();
  const normalized = value.trim();
  if (!normalized) return fail();
  return normalized;
}

function base58(bytes: Uint8Array): string {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = BASE58[remainder] + encoded;
    value /= 58n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0)
    leadingZeroes += 1;
  return "1".repeat(leadingZeroes) + (encoded || "1");
}

function normalizedSkills(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > MAX_SKILLS) return fail();
  const skills = value.map((skill) => {
    if (
      !Number.isSafeInteger(skill) ||
      skill < 0 ||
      (skill > 39 && skill < 100)
    )
      return fail();
    return skill;
  });
  return [...new Set(skills)].sort((a, b) => a - b);
}

export function createHcs14Identity(input: unknown): Hcs14Identity {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return fail();
  const raw = input as Record<string, unknown>;
  const allowed = new Set([
    "registry",
    "name",
    "version",
    "protocol",
    "nativeId",
    "skills",
    "uid",
    "domain",
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return fail();

  const registry = boundedAscii(raw.registry)!.toLowerCase();
  const name = boundedAscii(raw.name)!;
  const version = boundedAscii(raw.version)!;
  const protocol = boundedAscii(raw.protocol)!.toLowerCase();
  const nativeId = boundedAscii(raw.nativeId)!;
  const uid = boundedAscii(raw.uid)!;
  const domain = boundedAscii(raw.domain, false);
  const skills = normalizedSkills(raw.skills);

  const canonical = JSON.stringify({
    name,
    nativeId,
    protocol,
    registry,
    skills,
    version,
  });
  const digest = createHash("sha384").update(canonical, "utf8").digest();
  const parameters = [
    `uid=${uid}`,
    `registry=${registry}`,
    `proto=${protocol}`,
    `nativeId=${nativeId}`,
  ];
  if (domain) parameters.push(`domain=${domain}`);
  return {
    uaid: `uaid:aid:${base58(digest)};${parameters.join(";")}`,
    target: "aid",
    standard: "HCS-14",
    status: "draft",
    canonical,
  };
}
