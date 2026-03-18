// backend/utils/enforceTrialStatus.js
export default async function enforceTrialStatus(org) {
  if (!org) return org;

  const trialStatus = String(org?.trial?.status || "").toLowerCase();
  const trialEndsAt = org?.trial?.endsAt ? new Date(org.trial.endsAt) : null;

  if (trialStatus !== "trialing") {
    return org;
  }

  if (!trialEndsAt || Number.isNaN(trialEndsAt.getTime())) {
    return org;
  }

  const now = new Date();

  if (now >= trialEndsAt) {
    org.trial.status = "expired";
    org.accessStatus = "suspended";

    if (org.paymentStatus !== "paid") {
      org.billing = {
        ...(org.billing || {}),
        status: "canceled",
      };
    }

    await org.save();
  }

  return org;
}