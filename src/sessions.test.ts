import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  decodeSessionFile, deleteUserSession, emailHash, encodeSessionFile, listUserSessions,
  loadUserSession, readUserSessionFile, sessionPathFor, updateUserSessionFile, writeUserSessionFile,
} from './sessions.js';

const stored = (email: string) => ({
  cookies: { ashby_session_token: 's%3Asecret', authenticated: 'true' },
  userEmail: email,
  identityUserIds: { 'org-1': 'user-1' },
  orgCount: 1,
  seededAt: '2026-09-23T00:00:00.000Z',
  status: 'healthy' as const,
});

test('session files are keyed by a hash of the lowercased email', () => {
  assert.equal(emailHash('DK@CandidateLabs.com'), emailHash('dk@candidatelabs.com'));
  assert.match(path.basename(sessionPathFor('dk@candidatelabs.com', '/tmp/x')), /^[0-9a-f]{32}\.json$/);
});

test('write / load / update / list / delete round trip', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sessions-'));
  await writeUserSessionFile('A@x.com', stored('A@x.com'), dir);
  const s = await loadUserSession('a@x.com', dir);
  assert.ok(s);
  assert.equal(s.userEmail, 'a@x.com');
  assert.equal(s.persistPath, sessionPathFor('a@x.com', dir));
  assert.deepEqual(s.orgIds, ['org-1']);
  await updateUserSessionFile('a@x.com', { status: 'expired', lastError: 'nope' }, dir);
  assert.equal((await readUserSessionFile('a@x.com', dir))?.status, 'expired');
  const list = await listUserSessions(dir);
  assert.deepEqual(list.map((u) => [u.email, u.status, u.org_count]), [['a@x.com', 'expired', 1]]);
  assert.equal(await deleteUserSession('a@x.com', dir), true);
  assert.equal(await loadUserSession('a@x.com', dir), null);
});

test('a file without auth cookies is treated as no session', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sessions-'));
  await writeUserSessionFile('b@x.com', { ...stored('b@x.com'), cookies: {} }, dir);
  assert.equal(await loadUserSession('b@x.com', dir), null);
});

test('encryption at rest round-trips and hides the cookie', () => {
  const key = crypto.randomBytes(32);
  const json = JSON.stringify(stored('c@x.com'));
  const enc = encodeSessionFile(json, key);
  assert.ok(!enc.includes('secret'));
  assert.equal(decodeSessionFile(enc, key), json);
  assert.equal(decodeSessionFile(json, key), json, 'plaintext files still read');
  assert.throws(() => decodeSessionFile(enc, null), /SESSION_ENC_KEY/);
});
