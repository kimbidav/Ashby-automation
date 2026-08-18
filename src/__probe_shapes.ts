/**
 * One-off (delete after use): re-search Trajectory for the orphaned created
 * candidate, and read canonical shapes from the pre-existing AfterQuery
 * record (note content JSON, emailAddresses.type) to fix the failing
 * mutations. Read-only.
 */
import { loadSession, persistSessionCookies } from './session.js';
import { fetchAllAvailableOrgs, enterOrgContext, graphqlReadQuery } from './client.js';
import { searchCandidatesInOrg } from './mutations.js';

const AFTERQUERY_AERIN = 'acdf8485-6106-4ee8-9119-822f61812915';

async function main() {
  const session = await loadSession();
  session.onCookiesRotated = (s: any) => { void persistSessionCookies(s); };
  const orgs = (await fetchAllAvailableOrgs(session)).filter((o) => o.userId);
  const firstOrg = orgs[0];

  // 1. Trajectory: search again (index may have caught up)
  const traj = orgs.find((o) => o.name.toLowerCase() === 'trajectory');
  if (traj) {
    await enterOrgContext(session, traj.userId, traj.name);
    for (const q of ['Aerin', 'Aerin Kim', 'Kim']) {
      const hits = await searchCandidatesInOrg(session, q, { resolveLinks: false });
      console.log(`Trajectory search "${q}": ${hits.map((h) => `${h.name} (${h.id})`).join(', ') || 'no hits'}`);
    }
  }

  // 2. AfterQuery: canonical shapes from the manual record
  const aq = orgs.find((o) => o.name.toLowerCase() === 'afterquery');
  if (aq) {
    await enterOrgContext(session, aq.userId, aq.name);
    const detail: any = await graphqlReadQuery(session, 'ApiShapeProbe', `
      query ApiShapeProbe($id: String!) {
        candidate(id: $id) {
          id
          emailAddresses { value type isPrimary __typename }
          socialLinks { type url __typename }
          notes {
            id
            createdAt
            content
            __typename
          }
          __typename
        }
      }`, { id: AFTERQUERY_AERIN });
    const c = detail?.candidate;
    console.log('\nAfterQuery emailAddresses:', JSON.stringify(c?.emailAddresses));
    console.log('AfterQuery socialLinks:', JSON.stringify(c?.socialLinks));
    const notes = c?.notes || [];
    console.log(`notes: ${notes.length}`);
    if (notes[0]) {
      console.log('note[0].createdAt:', notes[0].createdAt);
      console.log('note[0].content (first 800 chars):', JSON.stringify(notes[0].content).slice(0, 800));
    }
  }

  if (firstOrg) await enterOrgContext(session, firstOrg.userId, firstOrg.name);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
