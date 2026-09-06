import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const functionLine = source
  .split("\n")
  .find((line) => line.startsWith("function updateOracleNotice("));
if (!functionLine) throw new Error("updateOracleNotice was not found");

const elements = new Map(
  ["oracle-notice", "oracle-title", "oracle-description"].map((id) => [
    id,
    { hidden: false, textContent: "" },
  ]),
);
const updateOracleNotice = vm.runInNewContext(`(${functionLine})`, {
  $: (id) => elements.get(id),
});

function runCase(name, health, expected) {
  for (const element of elements.values()) {
    element.hidden = false;
    element.textContent = "";
  }
  updateOracleNotice(health);
  assert.equal(elements.get("oracle-notice").hidden, expected.hidden, name);
  assert.equal(elements.get("oracle-title").textContent, expected.title, name);
}

runCase(
  "compatible current oracle keeps a legacy-only note",
  {
    readiness: {
      oracle: {
        current: { status: "compatible" },
        legacy: { records: 1, status: "unavailable" },
      },
    },
  },
  { hidden: false, title: "Earlier forecasts remain ungraded" },
);
runCase(
  "unavailable current oracle keeps the warning",
  { readiness: { oracle: { current: { status: "unavailable" } } } },
  { hidden: false, title: "Grading is temporarily unavailable" },
);
runCase(
  "compatible current oracle with no legacy records hides the notice",
  {
    readiness: {
      oracle: {
        current: { status: "compatible" },
        legacy: { records: 0, status: "unavailable" },
      },
    },
  },
  { hidden: true, title: "" },
);
runCase(
  "missing current status does not make a false oracle claim",
  { oracle: { grading_status: "external_preflight_required" } },
  { hidden: false, title: "Oracle status could not be loaded" },
);

console.log("oracle notice checks: 4/4 passed");
