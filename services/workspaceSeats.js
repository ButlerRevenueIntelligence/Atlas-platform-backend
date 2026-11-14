import crypto from 'node:crypto';
import Organization from '../models/Organization.js';
import Membership from '../models/Membership.js';

export const occupiedSeatFilter = { status: { $nin: ['disabled', 'suspended'] } };
export const seatsUsed = orgId => Membership.countDocuments({ orgId, ...occupiedSeatFilter });
export function seatCapacity(org) {
  if (org?.plan !== 'ENTERPRISE') return Infinity;
  const extra = org.billing?.enterpriseAdditionalSeats;
  return 25 + (Number.isSafeInteger(extra) && extra > 0 ? extra : 0);
}

// Serialize membership activation, subscription synchronization and seat reductions per workspace.
export async function withSeatLock(orgId, action) {
  const token = crypto.randomUUID();
  const org = await Organization.findOneAndUpdate({ _id: orgId, $or: [
    { 'billing.seatLockUntil': { $exists: false } },
    { 'billing.seatLockUntil': null },
    { 'billing.seatLockUntil': { $lte: new Date() } },
  ] }, { $set: { 'billing.seatLockToken': token, 'billing.seatLockUntil': new Date(Date.now() + 300000) } }, { new: true });
  if (!org) throw Object.assign(new Error('Another seat change is in progress. Please retry shortly.'), { status: 409, code: 'SEAT_CHANGE_BUSY' });
  try { return await action(org); }
  finally { await Organization.updateOne({ _id: orgId, 'billing.seatLockToken': token }, { $unset: { 'billing.seatLockToken': 1, 'billing.seatLockUntil': 1 } }); }
}

function capacityError() {
  return Object.assign(new Error('This workspace has used all purchased seats. Ask an owner or admin to add seats in Billing before activating another user.'), { status: 409, code: 'SEAT_LIMIT_REACHED' });
}
export async function createSeatedMembership(data) {
  return withSeatLock(data.orgId, async org => {
    if (!['disabled', 'suspended'].includes(data.status) && await seatsUsed(data.orgId) >= seatCapacity(org)) throw capacityError();
    return Membership.create(data);
  });
}
export async function updateSeatedMembership(orgId, membershipId, updates) {
  return withSeatLock(orgId, async org => {
    const target = await Membership.findOne({ _id: membershipId, orgId }).lean();
    if (!target) throw Object.assign(new Error('Membership not found.'), { status: 404 });
    const activates = updates.status && !['disabled', 'suspended'].includes(updates.status) && ['disabled', 'suspended'].includes(target.status);
    if (activates && await seatsUsed(orgId) >= seatCapacity(org)) throw capacityError();
    return Membership.findOneAndUpdate({ _id: membershipId, orgId }, { $set: updates }, { new: true, runValidators: true }).lean();
  });
}
