import test from 'node:test';
import assert from 'node:assert/strict';
import { seatQuantity, enterpriseMonthlyCents, subscriptionPlanItem, additionalSeatQuantity, validateMonthlyPrice } from '../utils/enterpriseBilling.js';
import { createSeatedMembership, updateSeatedMembership, withSeatLock } from '../services/workspaceSeats.js';
import Organization from '../models/Organization.js';
import Membership from '../models/Membership.js';
import User from '../models/User.js';
process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
process.env.STRIPE_PRICE_ENTERPRISE = 'price_enterprise';
process.env.STRIPE_PRICE_ENTERPRISE_SEAT = 'price_extra';
const { default: router, stripe } = await import('../routes/stripe.js');
const orgId = '507f1f77bcf86cd799439011';
const userId = '507f1f77bcf86cd799439012';
const makePrice = (id, amount) => ({ id, active: true, currency: 'usd', billing_scheme: 'per_unit', unit_amount: amount, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } });
const price = makePrice('price_extra', 11500);
const subscription = extra => ({ id: 'sub_test', status: 'active', customer: 'cus_test', metadata: { orgId }, items: { data: [ ...(extra ? [{ id: 'si_extra', quantity: extra, price }] : []), { id: 'si_base', quantity: 1, price: makePrice('price_enterprise', 350000) } ] } });
const workspace = () => ({ _id: orgId, plan: 'ENTERPRISE', billing: { stripeCustomerId: 'cus_test', stripeSubscriptionId: 'sub_test', status: 'active', enterpriseAdditionalSeats: 0 }, async save() { this.saved = true; } });
function setup(t, used = 25) {
 const org = workspace();
 t.mock.method(Organization, 'findById', async () => org);
 t.mock.method(Organization, 'findOneAndUpdate', async () => org);
 t.mock.method(Organization, 'updateOne', async () => ({}));
 t.mock.method(Membership, 'countDocuments', async () => used);
 t.mock.method(Membership, 'findOne', () => ({ lean: async () => ({ userId, orgId, role: 'owner', status: 'active' }) }));
 t.mock.method(stripe.prices, 'retrieve', async id => id === 'price_enterprise' ? makePrice(id,350000) : price);
 return org;
}
async function request(path, body, role) {
 const layer = router.stack.find(l => l.route?.path === path);
 const response = { code: 200, status(n) { this.code=n; return this; }, json(value) { this.body=value; return this; } };
 await layer.route.stack.at(-1).handle({ user: {userId, orgId}, headers: {}, body }, response);
 return response;
}

test('Enterprise totals include exactly 25 seats and $115 for every additional seat', () => {
 for (const [seats,total] of [[25,350000],[26,361500],[30,407500],[50,637500]]) assert.equal(enterpriseMonthlyCents(seats),total);
 for (const bad of [null,'',24,-1,25.5,'abc',Infinity,10001]) assert.throws(() => seatQuantity(bad));
});
test('seat add-on appearing first cannot change the base plan; duplicate/invalid quantities fail closed', () => {
 assert.equal(subscriptionPlanItem(subscription(5), {ENTERPRISE:{priceId:'price_enterprise'}}).id,'si_base');
 assert.equal(additionalSeatQuantity(subscription(5),'price_extra'),5);
 const bad=subscription(5);bad.items.data.unshift({...bad.items.data[0]});assert.throws(()=>additionalSeatQuantity(bad,'price_extra'));
 const invalid=subscription(5);invalid.items.data[0].quantity=1.5;assert.throws(()=>additionalSeatQuantity(invalid,'price_extra'));
});
test('wrong currency, interval, metered usage or price cannot be billed as the $115 seat price', () => {
 validateMonthlyPrice(price,11500);
 for (const changed of [{currency:'eur'},{unit_amount:15000},{active:false},{recurring:{...price.recurring,interval:'year'}},{recurring:{...price.recurring,usage_type:'metered'}}]) assert.throws(()=>validateMonthlyPrice({...price,...changed},11500));
});
test('the 26th user is rejected at capacity and the workspace lock is released', async t => {
 setup(t);const release=Organization.updateOne;const create=t.mock.method(Membership,'create',async()=>{throw Error('must not create');});
 await assert.rejects(createSeatedMembership({orgId,userId,status:'active'}), e=>e.code==='SEAT_LIMIT_REACHED');
 assert.equal(create.mock.calls.length,0);assert.equal(release.mock.calls.length,1);
});
test('a paid extra seat allows acceptance and disabled-user reactivation', async t => {
 const org=setup(t);org.billing.enterpriseAdditionalSeats=1;
 t.mock.method(Membership,'create',async data=>data);
 assert.equal((await createSeatedMembership({orgId,userId,status:'active'})).status,'active');
 t.mock.method(Membership,'findOne',()=>({lean:async()=>({status:'disabled'})}));
 t.mock.method(Membership,'findOneAndUpdate',()=>({lean:async()=>({status:'active'})}));
 assert.equal((await updateSeatedMembership(orgId,userId,{status:'active'})).status,'active');
});
test('simultaneous seat mutation is rejected before a second membership can be activated', async t => {
 setup(t);t.mock.method(Organization,'findOneAndUpdate',async()=>null);
 await assert.rejects(withSeatLock(orgId,async()=>assert.fail('must not run')),e=>e.code==='SEAT_CHANGE_BUSY');
});
test('failed Stripe payment never grants additional capacity', async t => {
 const org=setup(t);
 t.mock.method(stripe.subscriptions,'retrieve',async()=>subscription(0));
 t.mock.method(stripe.subscriptions,'update',async()=>{throw Object.assign(new Error('declined'),{type:'StripeCardError'});});
 const res=await request('/enterprise-seats',{seats:26,confirmed:true});
 assert.equal(res.code,402);assert.equal(org.billing.enterpriseAdditionalSeats,0);assert.equal(org.saved,undefined);
});
test('successful increase bills only extra seats, invoices proration, and grants the resulting capacity', async t => {
 const org=setup(t);let sub=subscription(0);
 t.mock.method(stripe.subscriptions,'retrieve',async()=>sub);
 const update=t.mock.method(stripe.subscriptions,'update',async(id,payload)=>{assert.deepEqual(payload.items,[{price:'price_extra',quantity:5}]);assert.equal(payload.proration_behavior,'always_invoice');assert.equal(payload.payment_behavior,'error_if_incomplete');sub=subscription(5);return sub;});
 const res=await request('/enterprise-seats',{seats:30,confirmed:true});
 assert.equal(res.code,200);assert.equal(res.body.monthlyCents,407500);assert.equal(org.billing.enterpriseAdditionalSeats,5);assert.equal(update.mock.calls.length,1);
});
test('reducing seats below occupied users is rejected before any Stripe change', async t => {
 setup(t,28);const update=t.mock.method(stripe.subscriptions,'update',async()=>assert.fail());
 const res=await request('/enterprise-seats',{seats:25,confirmed:true});assert.equal(res.code,409);assert.equal(update.mock.calls.length,0);
});
test('reducing back to 25 removes only the add-on and creates proration credit', async t => {
 const org=setup(t,25);let sub=subscription(5);
 t.mock.method(stripe.subscriptions,'retrieve',async()=>sub);
 t.mock.method(stripe.subscriptions,'update',async(id,payload)=>{assert.deepEqual(payload.items,[{id:'si_extra',deleted:true}]);assert.equal(payload.proration_behavior,'create_prorations');sub=subscription(0);return sub;});
 const res=await request('/enterprise-seats',{seats:25,confirmed:true});assert.equal(res.code,200);assert.equal(org.billing.enterpriseAdditionalSeats,0);
});
test('non-managers cannot change purchased seats',async t=>{
 setup(t);t.mock.method(Membership,'findOne',()=>({lean:async()=>({role:'viewer'})}));
 const res=await request('/enterprise-seats',{seats:26,confirmed:true});assert.equal(res.code,403);
});
test('seat changes require explicit confirmation and reject incorrect Stripe configuration', async t=>{
 setup(t);
 assert.equal((await request('/enterprise-seats',{seats:26})).code,400);
 t.mock.method(stripe.prices,'retrieve',async()=>({...price,unit_amount:15000}));
 assert.equal((await request('/enterprise-seats',{seats:26,confirmed:true})).code,503);
});
test('Enterprise checkout includes the base once and bills only seats above 25', async t => {
 setup(t);t.mock.method(User,'findById',()=>({select(){return this;},lean:async()=>({email:'owner@example.test'})}));
 const org=workspace();org.billing={status:'inactive'};t.mock.method(Organization,'findById',async()=>org);
 const create=t.mock.method(stripe.checkout.sessions,'create',async payload=>{assert.deepEqual(payload.line_items,[{price:'price_enterprise',quantity:1},{price:'price_extra',quantity:5}]);return {url:'https://checkout.stripe.com/test'};});
 const res=await request('/create-checkout-session',{plan:'ENTERPRISE',seats:30});assert.equal(res.code,200);assert.equal(create.mock.calls.length,1);
});
test('retry after a successful Stripe update does not charge again', async t=>{
 const org=setup(t);t.mock.method(stripe.subscriptions,'retrieve',async()=>subscription(5));
 const update=t.mock.method(stripe.subscriptions,'update',async()=>assert.fail('duplicate billing'));
 const res=await request('/enterprise-seats',{seats:30,confirmed:true});assert.equal(res.code,200);assert.equal(org.billing.enterpriseAdditionalSeats,5);assert.equal(update.mock.calls.length,0);
});
