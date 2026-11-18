/**
 * Run: npm test
 * (TS_NODE_TRANSPILE_ONLY=1 node --loader ts-node/esm src/sweep-scope.test.ts)
 *
 * resolveSweepScope picks which orgs a sweep visits. A wrong pick here is a
 * wrong "swept" list downstream, which the coordinator's archival inference
 * trusts — so the rules are pinned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSweepScope } from './api-server-extract.js';

const ORGS = [
  { id: 'org-a', name: 'AfterQuery', userId: 'u1' },
  { id: 'org-b', name: 'Deep Tune', userId: 'u2' },
  { id: 'org-c', name: 'Proximal', userId: 'u3' },
  { id: 'org-d', name: 'Longitude Labs', userId: 'u4' },
];

test('no scope = every org, not partial', () => {
  const r = resolveSweepScope(ORGS);
  assert.equal(r.partial, false);
  assert.deepEqual(r.selected.map((o) => o.id), ['org-a', 'org-b', 'org-c', 'org-d']);
  assert.deepEqual(r.unseen, []);
});

test('an empty scope object is also a full sweep', () => {
  const r = resolveSweepScope(ORGS, { org_ids: [], org_names: [] });
  assert.equal(r.partial, false);
  assert.equal(r.selected.length, 4);
});

test('org_ids are swept in request order, then names; duplicates collapse', () => {
  const r = resolveSweepScope(ORGS, { org_ids: ['org-c', 'org-a'], org_names: ['afterquery', 'Longitude Labs'] });
  assert.equal(r.partial, true);
  assert.deepEqual(r.selected.map((o) => o.id), ['org-c', 'org-a', 'org-d']);
  assert.deepEqual(r.unmatched, []);
});

test('names match case- and space-insensitively (Deeptune ≡ Deep Tune)', () => {
  const r = resolveSweepScope(ORGS, { org_names: ['Deeptune'] });
  assert.deepEqual(r.selected.map((o) => o.id), ['org-b']);
});

test('a requested org not on the account is reported, not silently dropped', () => {
  const r = resolveSweepScope(ORGS, { org_ids: ['org-zzz'], org_names: ['Nobody Inc'] });
  assert.deepEqual(r.selected, []);
  assert.deepEqual(r.unmatched, ['org-zzz', 'Nobody Inc']);
  assert.equal(r.partial, true);
});

test('include_unknown appends every org the caller has never seen, after the requested ones', () => {
  const r = resolveSweepScope(ORGS, { org_ids: ['org-c'], known_org_ids: ['org-a', 'org-b', 'org-c'], include_unknown: true });
  assert.deepEqual(r.selected.map((o) => o.id), ['org-c', 'org-d']);
  assert.deepEqual(r.unseen.map((o) => o.name), ['Longitude Labs']);
});

test('include_unknown with no known ids is still a partial sweep of everything (the caller asked for a scope)', () => {
  const r = resolveSweepScope(ORGS, { include_unknown: true });
  assert.equal(r.partial, true);
  assert.equal(r.selected.length, 4);
  assert.equal(r.unseen.length, 4);
});
