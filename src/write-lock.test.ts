import test from 'node:test';
import assert from 'node:assert/strict';
import { identityLockKey, lockHolder, withLock, withGlobalLock, TEAM_LOCK_KEY } from './write-lock.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('two identities never wait on each other', async () => {
  const order: string[] = [];
  const a = withLock(identityLockKey('a@x.com'), 'a', async () => { await sleep(60); order.push('a'); });
  const b = withLock(identityLockKey('b@x.com'), 'b', async () => { order.push('b'); });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['b', 'a']);
});

test('the same identity is serialized FIFO', async () => {
  const order: string[] = [];
  const key = identityLockKey('Same@X.com');
  const first = withLock(key, 'first', async () => { await sleep(40); order.push('first'); });
  assert.equal(lockHolder(key), 'first');
  const second = withLock(identityLockKey('same@x.com'), 'second', async () => { order.push('second'); });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(lockHolder(key), null);
});

test('a sweep on the team key does not block a recruiter upload', async () => {
  const order: string[] = [];
  const sweep = withGlobalLock('extract', async () => { await sleep(60); order.push('sweep'); });
  assert.equal(lockHolder(TEAM_LOCK_KEY), 'extract');
  await withLock(identityLockKey('r@x.com'), 'add-candidate', async () => { order.push('upload'); });
  await sweep;
  assert.deepEqual(order, ['upload', 'sweep']);
});

test('a hung write releases the lock after maxHoldMs but still resolves', async () => {
  const key = identityLockKey('hung@x.com');
  const order: string[] = [];
  const hung = withLock(key, 'hung', async () => { await sleep(120); order.push('hung-done'); return 'late'; }, { maxHoldMs: 30 });
  await sleep(50);
  assert.equal(lockHolder(key), null, 'released after the hold limit');
  await withLock(key, 'next', async () => { order.push('next'); });
  assert.equal(await hung, 'late');
  assert.deepEqual(order, ['next', 'hung-done']);
});

test('a failing call releases the lock and rejects only its own caller', async () => {
  const key = identityLockKey('f@x.com');
  await assert.rejects(withLock(key, 'boom', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await withLock(key, 'after', async () => 42), 42);
});
