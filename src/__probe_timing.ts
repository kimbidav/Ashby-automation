// Post-baseline experiment: is InitialFetch slow because of the query shape
// (scorecards) or because of a per-switch server-side warm-up? And do the
// three ArchivedSweep views cost per round-trip or per view?
// Run from the extractor repo with the launchd extractor STOPPED (it owns the
// rotating session chain):
//   cd /Users/david/Documents/Ashby-automation && TS_NODE_TRANSPILE_ONLY=1 \
//     node --loader ts-node/esm <this file> 'Agave' 'AfterQuery' 'Proximal'
import { loadSession, persistSessionCookies } from './session.js';
import {
  fetchAllAvailableOrgs, switchOrgContext, fetchPipelineForOrg, fetchArchivedForOrg,
  snapshotRequestTimings, diffRequestTimings, formatRequestTimings, resetRequestTimings,
} from './client.js';

const wanted = process.argv.slice(2);
const session = await loadSession();
session.onCookiesRotated = (s) => { void persistSessionCookies(s); };
const orgs = await fetchAllAvailableOrgs(session);
const byName = new Map(orgs.map((o) => [o.name.toLowerCase(), o]));
const first = orgs.find((o) => o.userId);

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const before = snapshotRequestTimings();
  const t0 = Date.now();
  const out = await fn();
  console.log(`    ${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s — ${formatRequestTimings(diffRequestTimings(before, snapshotRequestTimings()))}`);
  return out;
}

resetRequestTimings();
for (const name of wanted) {
  const org = byName.get(name.toLowerCase());
  if (!org?.userId) { console.log(`?? ${name} not on the account`); continue; }
  console.log(`\n[${org.name}]`);
  await timed('switch', () => switchOrgContext(session, org.userId!, org.id));
  await timed('InitialFetch full #1 (first query after switch)', () => fetchPipelineForOrg(session, org.id, org.userId, org.name, { alreadyInOrg: true }));
  await timed('InitialFetch full #2 (same org, warm)', () => fetchPipelineForOrg(session, org.id, org.userId, org.name, { alreadyInOrg: true }));
  await timed('InitialFetch lean #3 (warm)', () => fetchPipelineForOrg(session, org.id, org.userId, org.name, { alreadyInOrg: true, lean: true }));
  // Re-switch so the lean query is also measured as the FIRST query after a switch.
  await timed('re-switch', () => switchOrgContext(session, org.userId!, org.id));
  await timed('InitialFetch lean #4 (first after switch)', () => fetchPipelineForOrg(session, org.id, org.userId, org.name, { alreadyInOrg: true, lean: true }));
  await timed('ArchivedSweep: Archived only', () => fetchArchivedForOrg(session, org.id, org.userId, org.name, { alreadyInOrg: true, views: ['Archived'] }));
  await timed('ArchivedSweep: Hired only', () => fetchArchivedForOrg(session, org.id, org.userId, org.name, { alreadyInOrg: true, views: ['Hired'] }));
  await timed('ArchivedSweep: ApplicationReview only', () => fetchArchivedForOrg(session, org.id, org.userId, org.name, { alreadyInOrg: true, views: ['ApplicationReview'] }));
}
if (first?.userId) await switchOrgContext(session, first.userId, first.id);
console.log('\nrestored to', first?.name);
