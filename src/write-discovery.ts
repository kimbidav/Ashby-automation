/**
 * write-discovery.ts — read-only validation harness for the Add-to-Ashby flow.
 *
 * Validates the discovered READ operations against the live session without
 * writing anything: candidate search, source resolution, open-jobs, and the
 * exact CandidateSocialLink `type` string on a real candidate (the mutation
 * uses the same enum). Mutations themselves are exercised on the first real
 * watched run — per DK's decision, no dummy candidates in client orgs.
 *
 * Usage:
 *   TS_NODE_TRANSPILE_ONLY=1 node --loader ts-node/esm src/write-discovery.ts --org "Reducto" [--candidate "Charles Lin"] [--foreign-job <job id from ANOTHER org>]
 *
 * ⚠️  This is a separate process sharing the live extractor's Ashby session,
 * and it switches org context OUTSIDE the server's global lock. The sweep no
 * longer verifies which org it is in (sessionUserV2 is gone), so running this
 * during a Refresh would file that org's remaining pages under the wrong
 * client. Check the extractor log first and only run it when no sweep,
 * archive check or upload is in flight.
 */
import { loadSession, persistSessionCookies } from './session.js';
import { fetchAllAvailableOrgs, enterOrgContext, fetchOpenJobsForOrg, graphqlReadQuery } from './client.js';
import { searchCandidatesInOrg, fetchSourceIdByTitle } from './mutations.js';
import { isWrongOrgContextError } from './org-verify.js';

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const orgName = arg('--org', 'Reducto');
  const candidateName = arg('--candidate', 'Charles Lin');

  const session = await loadSession();
  session.onCookiesRotated = (s: any) => { void persistSessionCookies(s); };

  const orgs = (await fetchAllAvailableOrgs(session)).filter((o) => o.userId);
  const firstOrg = orgs[0];
  const org = orgs.find((o) => o.name.toLowerCase() === orgName.toLowerCase());
  if (!org) throw new Error(`org "${orgName}" not found; available: ${orgs.map((o) => o.name).join(', ')}`);

  console.log(`\n── enterOrgContext(${org.name}) — read path, unverified`);
  await enterOrgContext(session, org.userId, org.name);
  console.log(`   switched to ${org.name} (${org.id}); credited_to_user_id=${org.userId}`);

  console.log(`\n── fetchOpenJobsForOrg`);
  const jobs = await fetchOpenJobsForOrg(session);
  for (const j of jobs) console.log(`   ${j.id}  ${j.title}  (${j.applicationCount} apps${j.locationName ? ', ' + j.locationName : ''})`);

  // The write path's proof of org: the target job is in the org's open jobs.
  if (jobs[0]) {
    console.log(`\n── enterOrgContext(${org.name}, {jobId}) — write path, verified by job membership`);
    const ctx = await enterOrgContext(session, org.userId, org.name, { jobId: jobs[0].id });
    console.log(`   OK: verifiedBy=${ctx.verifiedBy} using "${jobs[0].title}"`);
  }
  const foreignJob = arg('--foreign-job', '');
  if (foreignJob) {
    console.log(`\n── enterOrgContext(${org.name}, {jobId: <foreign>}) — must ABORT`);
    try {
      await enterOrgContext(session, org.userId, org.name, { jobId: foreignJob });
      throw new Error('FAIL: a job id from another org passed verification');
    } catch (err) {
      if (!isWrongOrgContextError(err)) throw err;
      console.log(`   OK: aborted with reason=${err.reason}, nothingWritten=${err.nothingWritten}`);
    }
  }

  console.log(`\n── fetchSourceIdByTitle("Sourced: Candidate Labs")`);
  const source = await fetchSourceIdByTitle(session, 'Sourced: Candidate Labs');
  console.log(`   ${source ? `${source.id}  "${source.displayTitle}"` : 'NOT FOUND in this org'}`);

  console.log(`\n── searchCandidatesInOrg("${candidateName}") — dup pre-check path`);
  const hits = await searchCandidatesInOrg(session, candidateName);
  for (const h of hits) console.log(`   ${h.id}  ${h.name}  email=${h.email ?? '—'}  linkedin=${h.linkedinUrl ?? '—'}`);

  if (hits[0]) {
    console.log(`\n── social-link type strings on ${hits[0].name} (exact enum for the Links mutation)`);
    const detail: any = await graphqlReadQuery(
      session,
      'ApiCandidateSocialLinks',
      `query ApiCandidateSocialLinks($id: String!) { candidate(id: $id) { id socialLinks { type url __typename } __typename } }`,
      { id: hits[0].id },
    );
    for (const l of detail?.candidate?.socialLinks || []) console.log(`   type="${l.type}"  ${l.url}`);
    if (!(detail?.candidate?.socialLinks || []).length) console.log('   (no social links on this candidate)');
  }

  if (firstOrg && firstOrg.id !== org.id) {
    await enterOrgContext(session, firstOrg.userId, firstOrg.name);
    console.log(`\nRestored org context to ${firstOrg.name}`);
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
