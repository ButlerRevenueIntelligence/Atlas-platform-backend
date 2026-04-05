// backend/utils/enforceTrialStatus.js
export default async function enforceTrialStatus(org) {
  if (!org) return org;

  const trialStatus = String(org?.trial?.status || "").toLowerCase();
  const trialEndsAt = org?.trial?.endsAt ? new Date(org.trial.endsAt) : null;
  const billingStatus = String(org?.billing?.status || "").toLowerCase();
  const paymentStatus = String(org?.paymentStatus || "").toLowerCase();

  if (trialStatus !== "trialing") {
    return org;
  }

  if (!trialEndsAt || Number.isNaN(trialEndsAt.getTime())) {
    return org;
  }

  const now = new Date();

  if (now < trialEndsAt) {
    return org;
  }

  org.trial = {
    ...(org.trial || {}),
    status: "expired",
  };

  const hasActivePaidSubscription =
    billingStatus === "active" || paymentStatus === "paid";

  if (hasActivePaidSubscription) {
    org.accessStatus = "active";
    org.approvedForAccess = true;
    org.demoCompleted = true;

    org.billing = {
      ...(org.billing || {}),
      status: "active",
    };

    org.paymentStatus = "paid";
  } else {
    org.accessStatus = "suspended";
    org.approvedForAccess = false;

    org.billing = {
      ...(org.billing || {}),
      status: "canceled",
    };

    org.paymentStatus = "canceled";
  }

  await org.save();
  return org;
}