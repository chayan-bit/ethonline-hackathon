import assert from "node:assert/strict";
import { test } from "node:test";
import { createHcs14Identity } from "../../src/protocol/hcs14.ts";

test("creates the official HCS-14 AID vector with canonical six-field hashing", () => {
  const identity = createHcs14Identity({
    registry: " HOL ",
    name: "Support Agent",
    version: "1.0.0",
    protocol: " HCS-10 ",
    nativeId: "hedera:testnet:0.0.123456",
    skills: [17, 0, 17],
    uid: "0",
  });

  assert.deepEqual(identity, {
    uaid: "uaid:aid:8yjEeyipVRyYFKKjnt8QXXTTQbprY1fVCqZA3UvN39v4JQtjHACwMmaq9HXCcZRu6V;uid=0;registry=hol;proto=hcs-10;nativeId=hedera:testnet:0.0.123456",
    target: "aid",
    standard: "HCS-14",
    status: "draft",
    canonical:
      '{"name":"Support Agent","nativeId":"hedera:testnet:0.0.123456","protocol":"hcs-10","registry":"hol","skills":[0,17],"version":"1.0.0"}',
  });
});

test("sorts and deduplicates skills and emits ordered routing parameters", () => {
  const identity = createHcs14Identity({
    registry: "Registry",
    name: "Agent",
    version: "2.0",
    protocol: "PROTO",
    nativeId: "native:1",
    skills: [101, 0, 39, 101, 0],
    uid: "agent-1",
    domain: "example.com",
  });

  assert.match(
    identity.uaid,
    /^uaid:aid:[1-9A-HJ-NP-Za-km-z]+;uid=agent-1;registry=registry;proto=proto;nativeId=native:1;domain=example\.com$/,
  );
  assert.equal(
    identity.canonical,
    '{"name":"Agent","nativeId":"native:1","protocol":"proto","registry":"registry","skills":[0,39,101],"version":"2.0"}',
  );
  assert.doesNotMatch(identity.uaid, /purpose=/);
});

test("rejects unknown purpose, unsafe strings, unbounded fields, and reserved skill IDs", () => {
  const base = {
    registry: "hol",
    name: "Agent",
    version: "1",
    protocol: "hcs-10",
    nativeId: "native",
    skills: [0],
    uid: "0",
  };
  for (const input of [
    { ...base, purpose: "chat" },
    { ...base, registry: "hol;evil" },
    { ...base, name: "Agent\n" },
    { ...base, nativeId: "native?unsafe" },
    { ...base, version: "x".repeat(257) },
    { ...base, skills: [40] },
    { ...base, skills: [99] },
    { ...base, skills: [-1] },
    { ...base, skills: [1.5] },
    { ...base, skills: [Number.MAX_SAFE_INTEGER + 1] },
  ])
    assert.throws(() => createHcs14Identity(input), /invalid_hcs14_identity/);
});

test("rejects missing required fields and optional empty domain", () => {
  const base = {
    registry: "hol",
    name: "Agent",
    version: "1",
    protocol: "hcs-10",
    nativeId: "native",
    skills: [0],
    uid: "0",
  };
  for (const key of [
    "registry",
    "name",
    "version",
    "protocol",
    "nativeId",
    "skills",
    "uid",
  ]) {
    const input = { ...base } as Record<string, unknown>;
    delete input[key];
    assert.throws(() => createHcs14Identity(input), /invalid_hcs14_identity/);
  }
  assert.throws(
    () => createHcs14Identity({ ...base, domain: " " }),
    /invalid_hcs14_identity/,
  );
});
