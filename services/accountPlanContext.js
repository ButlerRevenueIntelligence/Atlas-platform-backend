import Organization from '../models/Organization.js';
import Client from '../models/Client.js';
import Account from '../models/Account.js';
import { getUnifiedWorkspaceData } from './workspaceData.js';
import { buildDemoWorkspaceDeals, isDemoWorkspace } from './demoWorkspace.js';
import { captureDeals } from './leadershipBriefing.js';
import { buildAccountCatalog } from './accountActionPlans.js';
export async function accountPlanContext(orgId) {
  const org = await Organization.findById(orgId).select('_id name slug').lean();
  if (!org) throw new Error('Workspace not found');
  const demo = isDemoWorkspace(org),
    now = new Date();
  const [clients, accounts, data] = demo ? [[], [], {
    deals: buildDemoWorkspaceDeals(org, new Date(now.toISOString().slice(0, 10))),
    warnings: []
  }] : await Promise.all([Client.find({
    orgId,
    archivedAt: null
  }).lean(), Account.find({
    orgId,
    archivedAt: null
  }).lean(), getUnifiedWorkspaceData(orgId, {
    days: 30
  })]);
  return {
    demo,
    now,
    deals: captureDeals(data.deals || []),
    catalog: buildAccountCatalog({
      clients,
      accounts,
      deals: data.deals || [],
      demo
    }),
    warnings: data.warnings || []
  };
}
