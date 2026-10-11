import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoWorkspaceDeals, isDemoWorkspace } from '../services/demoWorkspace.js';
import { buildDashboardResponse } from '../routes/dashboard.js';
import { buildRevenueRiskBriefing } from '../services/operatorRiskBriefing.js';
import { normalizeDeal } from '../routes/ai.js';
import boardRouter from '../routes/revenueIntel.js';
import Organization from '../models/Organization.js';
import Membership from '../models/Membership.js';
const now = new Date('2026-10-11T21:00:00Z');
const org = {_id:'0123456789abcdef01234567', name:'Atlas Demo Company'};

test('shared demo records have stable identity, full ownership, and rolling dates', () => {
 const rows = buildDemoWorkspaceDeals(org, now);
 const tomorrow = buildDemoWorkspaceDeals(org, new Date('2026-10-12T21:00:00Z'));
 assert.equal(rows.length, 9); assert.equal(new Set(rows.map(d=>d.id)).size, 9);
 assert.deepEqual(rows.map(d=>d.id), tomorrow.map(d=>d.id));
 assert.ok(rows.every(d=>d.ownerName && d.clientName && d.source==='demo'));
 assert.equal(new Date(tomorrow[0].closeDate)-new Date(rows[0].closeDate),86400000);
 assert.equal(isDemoWorkspace({name:'Actual Customer'}),false);
});
test('Overview, Operator and account totals agree on open sample pipeline', () => {
 const rows=buildDemoWorkspaceDeals(org,now);
 const dashboard=buildDashboardResponse({org,deals:rows,metrics:[],integrations:[],membership:{role:'owner'},workspaceMode:'demo'});
 assert.equal(dashboard.pipelineValue,1665000);
 assert.equal(dashboard.summary.openDeals,6);
 assert.equal(rows.filter(d=>!d.stage.startsWith('Closed')).reduce((n,d)=>n+d.amount*d.probability,0),963950);
 const risk=buildRevenueRiskBriefing({deals:rows.map(normalizeDeal),isDemo:true,now});
 assert.match(risk.summary,/\$1,155,000/); assert.match(risk.summary,/69%/);
 assert.match(risk.summary,/\$762,650/);
});
test('Command Center uses the canonical sample execution board and honors reactivation threshold', async () => {
 const oldOrg=Organization.findById, oldMembership=Membership.findOne;
 Organization.findById=()=>({lean:async()=>org});
 Membership.findOne=()=>({select(){return this;},lean:async()=>({role:'owner',status:'active'})});
 const handler=boardRouter.stack.find(layer=>layer.route?.path==='/board').route.stack.at(-1).handle;
 const get=async threshold=>{let result;const req={user:{userId:'abcdef0123456789abcdef01',orgId:org._id},headers:{},query:{reactivateAfterDays:threshold}};const res={status(){return this;},json(value){result=value;return this;}};await handler(req,res);return result;};
 try {
  const board=await get(30);
  assert.equal(board.workspaceMode,'demo'); assert.deepEqual(board.execution.counts,{overdue:2,dueToday:1,upcoming:3});
  assert.equal(board.execution.overdue[0].ownerName,'Maya Thompson');
  assert.equal(board.execution.overdue[0].probability,72);
  assert.equal(board.reactivation.count,1);assert.match(board.reactivation.items[0].name,/Harborview/);
  assert.equal(board.winLoss.won,2);assert.equal(board.winLoss.lost,1);
  assert.equal((await get(60)).reactivation.count,0);
 } finally {Organization.findById=oldOrg; Membership.findOne=oldMembership;}
});
