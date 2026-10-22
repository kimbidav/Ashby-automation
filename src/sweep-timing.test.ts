/**
 * Run: npm test
 * (TS_NODE_TRANSPILE_ONLY=1 node --loader ts-node/esm src/sweep-timing.test.ts)
 *
 * The per-request timing helpers behind the sweep's per-org log lines and
 * extraction_stats.request_timing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffRequestTimings,
  formatRequestTimings,
  opNameFromUrl,
  recordRequestTiming,
  resetRequestTimings,
  snapshotRequestTimings,
} from './client.js';

test('op name comes from the GraphQL op= parameter', () => {
  assert.equal(opNameFromUrl('https://app.ashbyhq.com/api/graphql?op=InitialFetch'), 'InitialFetch');
  assert.equal(opNameFromUrl('https://app.ashbyhq.com/api/graphql?x=1&op=ArchivedSweep'), 'ArchivedSweep');
});

test('REST paths use the last segment, dropping a trailing id', () => {
  assert.equal(opNameFromUrl('https://app.ashbyhq.com/api/csrf/token'), 'token');
  assert.equal(opNameFromUrl('https://app.ashbyhq.com/api/auth/available_identities'), 'available_identities');
  assert.equal(
    opNameFromUrl('https://app.ashbyhq.com/api/auth/change_user/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'),
    'change_user',
  );
});

test('snapshots accumulate and diff per op', () => {
  resetRequestTimings();
  recordRequestTiming('change_user', 400);
  recordRequestTiming('token', 200);
  const before = snapshotRequestTimings();
  recordRequestTiming('InitialFetch', 9000);
  recordRequestTiming('change_user', 500);
  const delta = diffRequestTimings(before, snapshotRequestTimings());
  assert.deepEqual(delta, {
    InitialFetch: { calls: 1, ms: 9000 },
    change_user: { calls: 1, ms: 500 },
  });
  // The snapshot is a copy: later calls don't mutate it.
  assert.deepEqual(before.change_user, { calls: 1, ms: 400 });
});

test('format lists the slowest op first with call counts', () => {
  const line = formatRequestTimings({
    token: { calls: 1, ms: 300 },
    InitialFetch: { calls: 1, ms: 9800 },
    ArchivedSweep: { calls: 3, ms: 3100 },
  });
  assert.equal(line, 'InitialFetch 9.8s, ArchivedSweep 3.1s (3), token 0.3s');
});
