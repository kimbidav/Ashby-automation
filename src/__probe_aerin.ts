/**
 * One-off: locate the Aerin Kim record created by the partial upload
 * (delete after use). Read-only.
 */
import { loadSession, persistSessionCookies } from './session.js';
import { fetchAllAvailableOrgs, enterOrgContext, graphqlReadQuery } from './client.js';
import { searchCandidatesInOrg } from './mutations.js';

async function main() {
  const session = await loadSession();
  session.onCookiesRotated = (s: any) => { void persistSessionCookies(s); };

  const orgs = (await fetchAllAvailableOrgs(session)).filter((o) => o.userId);
  const firstOrg = orgs[0];

  for (const orgName of ['Trajectory', firstOrg?.name].filter(Boolean) as string[]) {
    const org = orgs.find((o) => o.name.toLowerCase() === orgName.toLowerCase());
    if (!org) { console.log(`org ${orgName}: not found`); continue; }
    const ctx = await enterOrgContext(session, org.userId, org.name);
    console.log(`\n── org ${ctx.orgName}: searchCandidates("Aerin")`);
    const hits = await searchCandidatesInOrg(session, 'Aerin', { resolveLinks: true, maxLinkLookups: 3 });
    if (!hits.length) console.log('   (no hits)');
    for (const h of hits) console.log(`   ${h.id}  ${h.name}  email=${h.email ?? '—'}  linkedin=${h.linkedinUrl ?? '—'}`);
    if (orgName === 'Trajectory' && hits.length) {
      // Full detail on the first hit: applications + restricted summaries + resume presence
      const detail: any = await graphqlReadQuery(session, 'ApiCandidateProbe', `
        query ApiCandidateProbe($id: String!) {
          candidate(id: $id) {
            id
            name
            createdAt
            creditedToUser { id firstName lastName __typename }
            source { id title displayTitle __typename }
            applications { id __typename }
            applicationRestrictedSummaries { summary { id job { id title __typename } __typename } __typename }
            resume { id file { id filename __typename } __typename }
            socialLinks { type url __typename }
            emailAddresses { value type isPrimary __typename }
            __typename
          }
        }`, { id: hits[0].id });
      console.log('   detail:', JSON.stringify(detail?.candidate, null, 2)?.slice(0, 1500));
    }
    if (orgName === 'Trajectory' && !hits.length) continue;
  }

  if (firstOrg) {
    await enterOrgContext(session, firstOrg.userId, firstOrg.name);
    console.log(`\nRestored org context to ${firstOrg.name}`);
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
