import fs from 'node:fs/promises';
import path from 'node:path';

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  responseStatus?: number;
  responseBodySnippet?: string;
}

export interface ParsedGraphQLQuery {
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
  url: string;
}

/**
 * Parse the recon log to extract GraphQL queries
 */
export async function parseReconLog(): Promise<ParsedGraphQLQuery[]> {
  const reconFile = path.join(process.cwd(), 'ashby-recon-log.json');
  
  try {
    const content = await fs.readFile(reconFile, 'utf8');
    const requests: CapturedRequest[] = JSON.parse(content);
    
    const queries: ParsedGraphQLQuery[] = [];
    
    for (const req of requests) {
      if (req.method === 'POST' && req.postData) {
        try {
          const parsed = JSON.parse(req.postData);
          if (parsed.query && parsed.operationName) {
            queries.push({
              operationName: parsed.operationName,
              query: parsed.query,
              variables: parsed.variables || {},
              url: req.url
            });
          }
        } catch {
          // Not JSON or not a GraphQL query
        }
      }
    }
    
    return queries;
  } catch (error) {
    throw new Error(`Failed to parse recon log: ${error}`);
  }
}

/**
 * Find a specific GraphQL query by operation name
 */
export async function findQueryByOperationName(
  operationName: string
): Promise<ParsedGraphQLQuery | null> {
  const queries = await parseReconLog();
  const matches = queries.filter(q => q.operationName === operationName);
  
  if (matches.length === 0) {
    return null;
  }
  
  // Return the most recent one (last in array)
  return matches[matches.length - 1];
}

/**
 * Find queries related to pipeline/jobs/applications
 */
export async function findPipelineQueries(): Promise<{
  openJobs?: ParsedGraphQLQuery;
  activeApplications?: ParsedGraphQLQuery;
}> {
  const queries = await parseReconLog();
  
  // Find ApiOpenJobs
  const openJobs = queries.find(q => q.operationName === 'ApiOpenJobs');
  
  // Find applications query - could be ApiGetActiveApplications or applicationsByPrebuiltView
  const activeApplications = queries.find(q => 
    q.operationName === 'ApiGetActiveApplications' ||
    q.query.includes('applicationsByPrebuiltView') ||
    (q.query.includes('prebuiltView') && q.query.includes('Active'))
  );
  
  return {
    openJobs: openJobs || undefined,
    activeApplications: activeApplications || undefined
  };
}
