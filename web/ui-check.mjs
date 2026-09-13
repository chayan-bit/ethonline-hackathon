import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { demoApi } from "./demo-data.js";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const markup = await readFile(new URL("./index.html", import.meta.url), "utf8");
const styles = await readFile(new URL("./style.css", import.meta.url), "utf8");
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

assert.match(markup, /class="proof-ribbon"/, "proof lifecycle is visible");
assert.match(markup, /content="#f6f7f2"/, "browser chrome uses light theme");
assert.match(styles, /color-scheme:\s*light/, "light color scheme is declared");
assert.match(
  styles,
  /prefers-reduced-motion:\s*reduce/,
  "motion has an accessibility fallback",
);
assert.match(
  source,
  /event\?\.type === "hashchange"[\s\S]*prefers-reduced-motion: reduce/,
  "view navigation returns to the top without forcing motion",
);
assert.doesNotMatch(
  source + markup,
  /↗/,
  "interaction labels do not use decorative arrow clutter",
);
assert.equal(demoApi("/v1/agents").agents[0].metrics.reveal_pct, 100);
assert.equal(demoApi("/v1/agents/1/signals").samples.length, 3);
assert.match(markup, /href="\.\/style\.css"/, "assets work below a Pages path");

console.log("UI checks: 13/13 passed");
