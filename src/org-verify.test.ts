/**
 * Run: npm test
 * (TS_NODE_TRANSPILE_ONLY=1 node --loader ts-node/esm src/org-verify.test.ts)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WrongOrgContextError,
  assertJobInOrg,
  describeKeys,
  isSessionAuthFailure,
  isWrongOrgContextError,
  verdictFromSwitchBody,
  verifyJobMembership,
  wrongOrgResponseBody,
} from './org-verify.js';

const JOBS = [{ id: 'job-a' }, { id: 'job-b' }];

test('a job in the org passes', () => {
  assert.doesNotThrow(() => assertJobInOrg(JOBS, 'job-b', 'Reducto', { nothingWritten: true }));
});

test('a job from another org aborts, and says nothing was written', () => {
  assert.throws(
    () => assertJobInOrg(JOBS, 'job-from-elsewhere', 'Reducto', { nothingWritten: true }),
    (err: unknown) => {
      assert.ok(isWrongOrgContextError(err));
      assert.equal(err.reason, 'job_not_in_org');
      assert.equal(err.nothingWritten, true);
      assert.match(err.message, /^wrong_org_context: expected "Reducto"/);
      return true;
    },
  );
});

test('an empty or missing job list never passes', () => {
  for (const jobs of [[], null, undefined]) {
    assert.throws(() => assertJobInOrg(jobs, 'job-a', 'Reducto', { nothingWritten: true }), WrongOrgContextError);
  }
  assert.throws(() => assertJobInOrg(JOBS, '', 'Reducto', { nothingWritten: true }), WrongOrgContextError);
});

test('the post-create check reports the draft it left behind', async () => {
  await assert.rejects(
    verifyJobMembership(async () => JOBS, 'job-from-elsewhere', 'Reducto', {
      nothingWritten: false,
      draftCandidateId: 'cand-123',
      mismatchReason: 'post_create_mismatch',
    }),
    (err: unknown) => {
      assert.ok(isWrongOrgContextError(err));
      assert.equal(err.reason, 'post_create_mismatch');
      const body = wrongOrgResponseBody(err);
      assert.equal(body.error, 'wrong_org_context');
      assert.equal(body.nothing_written, false);
      assert.equal(body.draft_candidate_id, 'cand-123');
      return true;
    },
  );
});

test('a re-check before a later step is not mislabelled as post-create', async () => {
  await assert.rejects(
    verifyJobMembership(async () => JOBS, 'job-from-elsewhere', 'Reducto', { nothingWritten: false }),
    (err: unknown) => isWrongOrgContextError(err) && err.reason === 'job_not_in_org',
  );
});

test('fails closed when the job list cannot be fetched', async () => {
  await assert.rejects(
    verifyJobMembership(
      async () => {
        throw new Error('The user aborted a request.');
      },
      'job-a',
      'Reducto',
      { nothingWritten: true },
    ),
    (err: unknown) => isWrongOrgContextError(err) && err.reason === 'verification_unavailable',
  );
});

test('the 409 body omits draft_candidate_id when nothing was written', () => {
  const body = wrongOrgResponseBody(new WrongOrgContextError('job_not_in_org', 'Reducto', { nothingWritten: true }));
  assert.equal(body.nothing_written, true);
  assert.ok(!('draft_candidate_id' in body));
  assert.match(String(body.instructions), /Nothing was written/);
});

test('wrong-org messages carry no ids, so they cannot be misread as a dead session', () => {
  const err = new WrongOrgContextError('post_create_mismatch', 'Reducto', {
    nothingWritten: false,
    draftCandidateId: '8f401c2e-4010-4401-9401-a1b2c3d40100',
  });
  assert.equal(isSessionAuthFailure(err.message), false);
});

test('session-death detection matches a real 401, not digits inside an id', () => {
  assert.equal(isSessionAuthFailure('Failed to fetch CSRF token: 401 Unauthorized.'), true);
  assert.equal(isSessionAuthFailure('Session appears expired.'), true);
  assert.equal(isSessionAuthFailure('no interview plan found for job 8f401c2e-4401-4010 — cannot create application'), false);
  assert.equal(isSessionAuthFailure('Cannot query field "sessionUserV2" on type "Query".'), false);
});

test('describeKeys reports key names and never values', () => {
  const shape = describeKeys({
    user: { id: 'secret-user-id', email: 'dk@example.com' },
    organization: { id: 'secret-org-id', name: 'Reducto' },
    token: 'secret-token',
  });
  assert.equal(shape, '{organization:{id,name},token,user:{email,id}}');
  for (const leaked of ['secret', 'Reducto', 'dk@example.com']) assert.ok(!shape.includes(leaked));
  assert.equal(describeKeys([{ a: 1 }]), '[{a}]');
  assert.equal(describeKeys('(empty body)'), 'string');
});

test('the change_user response proves which org the switch landed in', () => {
  const body = { user: { id: 'usr-reducto', organizationId: 'org-reducto', email: 'x' } };
  assert.equal(verdictFromSwitchBody(body, { userId: 'usr-reducto', orgId: 'org-reducto' }), 'match');
  assert.equal(verdictFromSwitchBody(body, { userId: 'usr-reducto' }), 'match');
});

test('a switch that landed in another org is a mismatch', () => {
  const body = { user: { id: 'usr-other', organizationId: 'org-other' } };
  assert.equal(verdictFromSwitchBody(body, { userId: 'usr-reducto', orgId: 'org-reducto' }), 'mismatch');
  // Right user id but wrong org id is still a mismatch.
  assert.equal(verdictFromSwitchBody({ user: { id: 'usr-reducto', organizationId: 'org-other' } }, { userId: 'usr-reducto', orgId: 'org-reducto' }), 'mismatch');
});

test('an unrecognised change_user shape is unknown, never a pass or a fail', () => {
  for (const body of [null, '', {}, { user: null }, { user: { email: 'x' } }, { ok: true }]) {
    assert.equal(verdictFromSwitchBody(body, { userId: 'u', orgId: 'o' }), 'unknown');
  }
});
