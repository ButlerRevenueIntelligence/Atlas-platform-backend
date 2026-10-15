import Organization from '../models/Organization.js';
import { getUnifiedWorkspaceData } from './workspaceData.js';
import { buildDemoWorkspaceDeals, isDemoWorkspace } from './demoWorkspace.js';
import { captureDeals } from './leadershipBriefing.js';
export async function currentLeadershipData(orgId) {
  const org = await Organization.findById(orgId).lean();
  const demo = isDemoWorkspace(org);
  const now = new Date();
  const workspace = demo ? {
    deals: buildDemoWorkspaceDeals(org, new Date(now.toISOString().slice(0, 10))),
    integrations: []
  } : await getUnifiedWorkspaceData(orgId, {
    days: 90
  });
  return {
    now,
    demo,
    deals: captureDeals(workspace.deals || []),
    integrations: workspace.integrations || []
  };
}
