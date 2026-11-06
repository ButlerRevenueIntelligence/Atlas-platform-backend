import test from 'node:test';
import assert from 'node:assert/strict';
import Connection from '../models/IntegrationConnection.js';
import Organization from '../models/Organization.js';
import {prepareSyncAttempt, syncScheduledConnection, markSyncFailed} from '../jobs/integrationAutoSync.js';
import {runRegisteredSync} from '../services/providerSyncRegistry.js';
import '../routes/integrations.js';

function fixture(t, overrides = {}) {
  const stored = {_id:'connection-a', orgId:'workspace-a', provider:'salesforce', status:'error', mode:'live', accessToken:'existing-access', refreshToken:'existing-refresh', metadata:{instanceUrl:'https://example.my.salesforce.com'}, lastSyncAt:new Date('2026-11-05T12:00:00Z'), ...overrides};
  const writes = [], alerts = [], calls = [];
  t.mock.method(Connection, 'updateOne', async (filter, update) => {
    writes.push({filter,update});
    if (filter.status && !filter.status.$in.includes(stored.status)) return {matchedCount:0};
    for(const [key,value] of Object.entries(update.$set)) {
      if(key.startsWith('metadata.')) stored.metadata[key.slice(9)]=value; else stored[key]=value;
    }
    return {matchedCount:1};
  });
  t.mock.method(Connection,'findOne', filter=>({select:async()=>{
    assert.equal(filter.orgId,'workspace-a');assert.equal(filter.provider,'salesforce');
    const allowed=typeof filter.status==='string'?[filter.status]:filter.status.$in;
    if(!allowed.includes(stored.status))return null;
    return {...stored,metadata:{...stored.metadata},async save(){Object.assign(stored,this)}};
  }}));
  t.mock.method(Organization,'findByIdAndUpdate',async()=>({}));
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return {ok:true,status:200,json:async()=>({records:[],done:true})};});
  t.mock.method(console,'error',()=>{});t.mock.method(console,'log',()=>{});
  return {stored,writes,calls,alerts,notifications:{recovery:async()=>alerts.push('recovery'),failure:async()=>alerts.push('failure')}};
}
test('a stale Mongoose connected snapshot forcibly repairs database error state before retry',async t=>{
  const f=fixture(t);
  const snapshot=Connection.hydrate({_id:'507f1f77bcf86cd799439011',orgId:'507f1f77bcf86cd799439012',provider:'salesforce',status:'connected'});
  snapshot.status='connected';assert.equal(snapshot.isModified('status'),false);
  assert.equal(await prepareSyncAttempt(snapshot),true);
  assert.equal(f.stored.status,'connected');assert.equal(f.stored.lastSyncStatus,'running');
  assert.ok(f.stored.lastSyncAttemptAt instanceof Date);
  assert.equal(f.stored.lastSyncAt.toISOString(),'2026-11-05T12:00:00.000Z');
  assert.deepEqual(f.writes[0].filter.status,{$in:['connected','error']});
});
test('Salesforce importer retries a recoverable error record instead of returning not connected',async t=>{
  const f=fixture(t);
  assert.equal((await runRegisteredSync('salesforce','workspace-a')).ok,true);
  assert.equal(f.calls.length,2);assert.equal(f.stored.lastSyncStatus,'success');assert.equal(f.stored.status,'connected');
});
test('scheduled retry completes the actual Salesforce importer and sends one recovery',async t=>{
  const f=fixture(t);const snapshot={...f.stored,status:'connected'};
  assert.deepEqual(await syncScheduledConnection(snapshot,f.notifications),{ok:true});
  assert.equal(f.stored.status,'connected');assert.equal(f.stored.lastSyncStatus,'success');assert.deepEqual(f.alerts,['recovery']);
});
test('Slack recovery delivery failure cannot turn a successful Salesforce import into failure',async t=>{
  const f=fixture(t);
  await syncScheduledConnection({...f.stored},{...f.notifications,recovery:async()=>{throw Error('Slack unavailable')}});
  assert.equal(f.stored.lastSyncStatus,'success');assert.equal(f.stored.status,'connected');assert.equal(f.stored.lastError,null);assert.deepEqual(f.alerts,[]);
});
test('report/network failure retains authorization and does not advance the last successful sync time',async t=>{
  const f=fixture(t,{status:'connected'});const previous=f.stored.lastSyncAt;
  t.mock.method(globalThis,'fetch',async()=>{throw Error('Temporary Salesforce network failure')});
  assert.deepEqual(await syncScheduledConnection({...f.stored},f.notifications),{ok:false});
  assert.equal(f.stored.status,'connected');assert.equal(f.stored.lastSyncStatus,'failed');assert.equal(f.stored.lastSyncAt,previous);
  assert.match(f.stored.lastError,/network failure/);assert.deepEqual(f.alerts,['failure']);
});
test('expired Salesforce session refreshes once and retries both queries before reporting recovery',async t=>{
  const f=fixture(t);let expired=true,refreshes=0;
  for(const key of ['SALESFORCE_CLIENT_ID','SALESFORCE_CLIENT_SECRET']){const old=process.env[key];process.env[key]='test';t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old});}
  t.mock.method(globalThis,'fetch',async url=>{
    if(url.includes('/oauth2/token')){refreshes++;expired=false;return {ok:true,status:200,json:async()=>({access_token:'renewed-access'})};}
    return expired?{ok:false,status:401,json:async()=>[{message:'Session expired',errorCode:'INVALID_SESSION_ID'}]}:{ok:true,status:200,json:async()=>({records:[],done:true})};
  });
  assert.equal((await syncScheduledConnection({...f.stored},f.notifications)).ok,true);
  assert.equal(refreshes,1);assert.equal(f.stored.accessToken,'renewed-access');assert.equal(f.stored.refreshToken,'existing-refresh');assert.deepEqual(f.alerts,['recovery']);
});
test('a revoked refresh grant remains an authorization error and preserves last successful time',async t=>{
  const f=fixture(t);const previous=f.stored.lastSyncAt;
  for(const key of ['SALESFORCE_CLIENT_ID','SALESFORCE_CLIENT_SECRET']){const old=process.env[key];process.env[key]='test';t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old});}
  t.mock.method(globalThis,'fetch',async url=>url.includes('/oauth2/token')?{ok:false,status:400,json:async()=>({error:'invalid_grant'})}:{ok:false,status:401,json:async()=>[{message:'Session expired'}]});
  await syncScheduledConnection({...f.stored},f.notifications);
  assert.equal(f.stored.status,'error');assert.equal(f.stored.lastSyncStatus,'failed');assert.equal(f.stored.lastSyncAt,previous);assert.match(f.stored.lastError,/authorization expired/);
});
test('already running or cancelled work is skipped without false failure/recovery alerts',async t=>{
  const f=fixture(t);
  for(const code of ['SYNC_IN_PROGRESS','SYNC_CANCELLED'])assert.deepEqual(await syncScheduledConnection({...f.stored},{...f.notifications,sync:async()=>{throw Object.assign(Error('Skipped'),{code})}}),{skipped:true});
  assert.deepEqual(f.alerts,[]);
});
test('stale scheduled snapshot cannot revive an explicitly disconnected Salesforce connection',async t=>{
  const f=fixture(t,{status:'disconnected'});let imports=0;
  assert.deepEqual(await syncScheduledConnection({...f.stored,status:'connected'},{...f.notifications,sync:async()=>imports++}),{skipped:true});
  await markSyncFailed({...f.stored,status:'connected'},Error('Late failure'));
  assert.equal(f.stored.status,'disconnected');assert.equal(imports,0);assert.deepEqual(f.alerts,[]);
});

test('malformed Salesforce records cannot report false recovery',async t=>{
  const f=fixture(t);const previous=f.stored.lastSyncAt;
  t.mock.method(globalThis,'fetch',async()=>({ok:true,status:200,json:async()=>({})}));
  assert.deepEqual(await syncScheduledConnection({...f.stored},f.notifications),{ok:false});
  assert.equal(f.stored.lastSyncStatus,'failed');assert.equal(f.stored.lastSyncAt,previous);assert.deepEqual(f.alerts,['failure']);
});
test('a disconnection during a failed import suppresses stale failure alerts',async t=>{
  const f=fixture(t);
  const result=await syncScheduledConnection({...f.stored},{...f.notifications,sync:async()=>{f.stored.status='disconnected';throw Error('Late network failure')}});
  assert.deepEqual(result,{skipped:true});assert.equal(f.stored.status,'disconnected');assert.deepEqual(f.alerts,[]);
});
