import test from 'node:test';
import assert from 'node:assert/strict';
import authRouter from '../routes/auth.js';
import workspaceRouter from '../routes/workspaces.js';
import Organization from '../models/Organization.js';
import Membership from '../models/Membership.js';
import User from '../models/User.js';
import {requirePlan} from '../middleware/requirePlan.js';
const userId='507f1f77bcf86cd799439011',orgId='507f1f77bcf86cd799439012';
const response=()=>({code:200,status(code){this.code=code;return this},json(body){this.body=body;return this}});
const handler=(router,path)=>router.stack.find(layer=>layer.route?.path===path&&layer.route.methods.post).route.stack.at(-1).handle;
const days=7*24*60*60*1000;
function trialAssertions(org){
 assert.equal(org.plan,'GROWTH');assert.equal(org.trial.status,'trialing');
 assert.ok(Math.abs(new Date(org.trial.endsAt)-new Date(org.trial.startedAt)-days)<100);
 assert.equal(org.billing.status,'trialing');assert.equal(org.paymentStatus,'trialing');assert.equal(org.accessStatus,'active');
}
test('public signup creates a seven-day Growth business trial and returns Growth in every workspace payload',async t=>{
 const old=process.env.JWT_SECRET;process.env.JWT_SECRET='test-only-secret';t.after(()=>{if(old===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=old});
 let created;
 t.mock.method(User,'findOne',()=>({lean:async()=>null}));
 t.mock.method(User,'create',async data=>({_id:userId,...data}));
 t.mock.method(User,'updateOne',async()=>({matchedCount:1}));
 t.mock.method(Organization,'create',async data=>(created={_id:orgId,...data}));
 t.mock.method(Membership,'create',async data=>data);
 const res=response();await handler(authRouter,'/signup')({body:{name:'New Business',email:'new@example.test',password:'test-password-123',plan:'CORE'}},res);
 assert.equal(res.code,200);assert.equal(res.body.ok,true);trialAssertions(created);
 for(const payload of [res.body.user,res.body.activeWorkspace,res.body.workspace,res.body.workspaces[0].workspace])assert.equal(payload.plan,'GROWTH');
});
test('creating another business workspace grants Growth without accepting client-controlled billing fields',async t=>{
 let created;
 t.mock.method(User,'findById',async()=>({_id:userId,async save(){}}));
 t.mock.method(Membership,'countDocuments',async()=>1);
 t.mock.method(Organization,'exists',async()=>null);
 t.mock.method(Organization,'create',async data=>(created={_id:orgId,...data}));
 t.mock.method(Membership,'create',async data=>data);
 const res=response();await handler(workspaceRouter,'/')({user:{userId},body:{name:'New Business',plan:'ENTERPRISE',billing:{status:'active'}}},res);
 assert.equal(res.code,201);trialAssertions(created);assert.equal(res.body.workspace.plan,'GROWTH');assert.equal(res.body.membership.role,'owner');
});
test('Growth trials pass Growth feature enforcement but do not receive Enterprise access',async t=>{
 const org={_id:orgId,plan:'GROWTH',accessStatus:'active',paymentStatus:'trialing',billing:{status:'trialing'},trial:{status:'trialing',endsAt:new Date(Date.now()+days)},async save(){assert.fail('Active trial should not be changed')}};
 t.mock.method(Organization,'findById',async()=>org);
 let allowed=false;const req={headers:{'x-org-id':orgId}};const res=response();await requirePlan('GROWTH')(req,res,()=>allowed=true);
 assert.equal(allowed,true);assert.equal(req.currentPlan,'GROWTH');
 const denied=response();await requirePlan('ENTERPRISE')({headers:{'x-org-id':orgId}},denied,()=>assert.fail('Enterprise granted'));
 assert.equal(denied.code,403);assert.equal(denied.body.code,'PLAN_UPGRADE_REQUIRED');
});
test('existing paid Core workspaces are not upgraded by the trial default',async t=>{
 const org={_id:orgId,plan:'SCALE',accessStatus:'active',paymentStatus:'paid',billing:{status:'active'},trial:{status:'converted'},async save(){assert.fail('Paid plan modified')}};
 t.mock.method(Organization,'findById',async()=>org);const res=response();
 await requirePlan('GROWTH')({headers:{'x-org-id':orgId}},res,()=>assert.fail('Paid Core upgraded'));
 assert.equal(res.code,403);assert.equal(res.body.currentPlan,'CORE');assert.equal(org.plan,'SCALE');
});
test('Growth trial access still expires after its existing end date',async t=>{
 const org={_id:orgId,plan:'GROWTH',accessStatus:'active',paymentStatus:'trialing',billing:{status:'trialing'},trial:{status:'trialing',endsAt:new Date(Date.now()-1000)},async save(){this.saved=true}};
 const end=org.trial.endsAt;t.mock.method(Organization,'findById',async()=>org);const res=response();
 await requirePlan('GROWTH')({headers:{'x-org-id':orgId}},res,()=>assert.fail('Expired trial granted access'));
 assert.equal(res.code,403);assert.equal(res.body.code,'TRIAL_EXPIRED');assert.equal(org.trial.endsAt,end);assert.equal(org.saved,true);
});
