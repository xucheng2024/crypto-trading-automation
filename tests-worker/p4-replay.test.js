import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { evaluateWatchdog } from '../src/application/operations-watchdog.js';

test('P4 replay matrix maps every T8 row to a concrete executed test', async () => {
  const matrix = JSON.parse(await readFile('fixtures/p4/replay-matrix.json', 'utf8'));
  assert.equal(matrix.length, 12);
  for (const row of matrix) {
    assert.match(row.file, /^tests-worker\/[a-z0-9.-]+\.test\.js$/);
    const source = await readFile(row.file, 'utf8');
    assert.ok(source.includes(row.test), `${row.scenario} lacks concrete evidence: ${row.file} :: ${row.test}`);
  }
});
test('P4 watchdog reports every fail-closed operational reason', () => {
  assert.deepEqual(evaluateWatchdog({ ws: {}, unknownCount: 1, riskHalt: true, exitBacklog: 1, watermarkStalled: true }).reasons.sort(), ['BUY_RISK_HALT','EXIT_BACKLOG','OWNER_LOST','READY_FALSE','UNKNOWN_ORDER','WATERMARK_STALLED','WS_BUSINESS_STALE','WS_PRIVATE_STALE','WS_PUBLIC_STALE'].sort());
});
test('P4 maintenance composition remains separated from Engine-only OKX responsibilities', async () => {
  const source = await readFile('src/application/maintenance-composition.js', 'utf8');
  assert.doesNotMatch(source, /safely\('ANNOUNCEMENT'|safely\('RECONCILIATION'/);
  assert.match(source, /retainTerminalAttempts/);
});
