import GraphIQResearch from '../models/GraphIQResearch.js';
import CompanyIntelligence from '../models/CompanyIntelligence.js';
import { withGraphIQMcp, searchArguments } from './graphiqMcp.js';
import { normalizeResearch } from './graphiqResearch.js';
export async function retrieveGraphIQResearch({
  orgId,
  kind,
  query
}) {
  const name = kind === 'news' ? 'search_news' : 'search_organizations';
  const result = await withGraphIQMcp(async (client, tools) => {
    const tool = tools.find(t => t.name === name);
    return client.call(name, searchArguments(tool, query.trim()));
  });
  const normalized = normalizeResearch(result, kind),
    expiresAt = new Date(Date.now() + 86400000);
  const snapshot = await GraphIQResearch.create({
    orgId: orgId,
    kind,
    query: query.trim(),
    tool: name,
    ...normalized,
    expiresAt
  });
  // Preserve the shared company-context contract for existing Atlas consumers.
  let companySnapshotId = null;
  if (kind === 'companies' && normalized.records.length) {
    const company = await CompanyIntelligence.create({
      orgId: orgId,
      query: {
        mcpQuery: query.trim()
      },
      data: {
        organizations: normalized.records
      },
      expiresAt
    });
    companySnapshotId = String(company._id);
  }
  return {
    snapshot,
    companySnapshotId,
    records: normalized.records
  };
}
