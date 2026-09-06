import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const deployment = JSON.parse(readFileSync('deployments/testnet.json', 'utf8'));
const results = [];
for (const [key, name] of [['registry', 'AgentRegistry'], ['ledger', 'SignalLedger']]) {
  const artifact = JSON.parse(readFileSync(`artifacts/contracts/${name}.sol/${name}.json`, 'utf8'));
  const build = JSON.parse(readFileSync(`artifacts/build-info/${artifact.buildInfoId}.json`, 'utf8'));
  const response = await fetch(`https://sourcify.dev/server/v2/verify/296/${deployment[key].address}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ stdJsonInput: build.input, compilerVersion: build.solcLongVersion, contractIdentifier: `${artifact.inputSourceName}:${name}` }),
  });
  const result = await response.json();
  results.push({ contract: name, address: deployment[key].address, http_status: response.status, result });
}
mkdirSync('docs/evidence', { recursive: true });
writeFileSync('docs/evidence/verification-jobs.json', JSON.stringify(results, null, 2) + '\n');
console.info(JSON.stringify(results));
