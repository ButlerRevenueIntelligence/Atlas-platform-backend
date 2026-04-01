import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";

function normalizeOrg(org, membership = null) {
  if (!org) return null;

  return {
    _id: org._id,
    name: org.name,
    slug: org.slug,
    type: org.type,
    plan: org.plan,
    accessStatus: org.accessStatus || "active",
    paymentStatus: org.paymentStatus || "pending",
    role: membership?.role || (String(org.ownerId) === String(membership?.userId) ? "owner" : "member"),
    membershipStatus: membership?.status || "active",
    workspace: {
      _id: org._id,
      name: org.name,
      slug: org.slug,
      type: org.type,
      plan: org.plan,
      accessStatus: org.accessStatus || "active",
      paymentStatus: org.paymentStatus || "pending",
    },
  };
}

export const getCurrentOrganization = async (req, res) => {
  try {
    const orgId =
      req.headers["x-org-id"] ||
      req.user?.orgId ||
      req.user?.activeOrgId ||
      null;

    const userId = req.user?._id || req.user?.userId || req.user?.id;

    let org = null;

    if (orgId) {
      org = await Organization.findById(orgId).lean();
    }

    if (!org && userId) {
      const membership = await Membership.findOne({
        userId,
        status: { $in: ["active", "invited"] },
      })
        .sort({ createdAt: 1 })
        .lean();

      if (membership?.orgId) {
        org = await Organization.findById(membership.orgId).lean();
      }
    }

    if (!org && userId) {
      org = await Organization.findOne({ ownerId: userId }).sort({ createdAt: 1 }).lean();
    }

    if (!org) {
      return res.status(404).json({ ok: false, message: "Organization not found" });
    }

    return res.json({
      ok: true,
      organization: org,
    });
  } catch (e) {
    console.error("getCurrentOrganization error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
};

export const getMyOrganizations = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.userId || req.user?.id;

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized",
      });
    }

    const memberships = await Membership.find({
      userId,
      status: { $in: ["active", "invited"] },
    }).lean();

    const membershipMap = new Map();
    const orgIds = [];

    for (const membership of memberships) {
      const id = String(membership.orgId || "");
      if (!id) continue;

      orgIds.push(membership.orgId);

      const existing = membershipMap.get(id);
      if (!existing) {
        membershipMap.set(id, membership);
        continue;
      }

      const rank = {
        owner: 6,
        admin: 5,
        manager: 4,
        analyst: 3,
        member: 2,
        viewer: 1,
      };

      const currentRank = rank[String(existing.role || "").toLowerCase()] || 0;
      const nextRank = rank[String(membership.role || "").toLowerCase()] || 0;

      if (nextRank > currentRank) {
        membershipMap.set(id, membership);
      }
    }

    const ownedOrgs = await Organization.find({ ownerId: userId }).lean();

    for (const org of ownedOrgs) {
      const id = String(org._id);
      if (!membershipMap.has(id)) {
        membershipMap.set(id, {
          userId,
          orgId: org._id,
          workspaceId: org._id,
          role: "owner",
          status: "active",
        });
        orgIds.push(org._id);
      }
    }

    const uniqueOrgIds = [...new Set(orgIds.map((x) => String(x)))];

    const orgs = await Organization.find({
      _id: { $in: uniqueOrgIds },
    })
      .sort({ createdAt: 1 })
      .lean();

    const result = orgs.map((org) => {
      const membership = membershipMap.get(String(org._id)) || null;
      return normalizeOrg(org, membership);
    });

    return res.json({
      ok: true,
      orgs: result,
    });
  } catch (e) {
    console.error("getMyOrganizations error:", e);
    return res.status(500).json({
      ok: false,
      message: "Server error",
    });
  }
};