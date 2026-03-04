import Organization from "../models/Organization.js";

export const getCurrentOrganization = async (req, res) => {
  try {
    // req.user is attached by middleware
    const orgId = req.user?.orgId;
    const userId = req.user?._id;

    console.log("ORG LOOKUP orgId=", orgId?.toString(), "userId=", userId?.toString());

    let org = null;

    // ✅ Primary: by user.orgId
    if (orgId) {
      org = await Organization.findById(orgId);
    }

    // ✅ Fallback: by ownerId
    if (!org && userId) {
      org = await Organization.findOne({ ownerId: userId });
    }

    if (!org) {
      return res.status(404).json({ message: "Organization not found" });
    }

    return res.json(org);
  } catch (e) {
    console.log(e);
    return res.status(500).json({ message: "Server error" });
  }
};
