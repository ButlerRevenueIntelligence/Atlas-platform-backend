import Organization from "../models/Organization.js";

export const getCurrentIntegrations = async (req, res) => {
  try {
    // req.user is set by middleware/auth.js
    const orgId = req.user?.orgId;

    if (!orgId) {
      return res.status(400).json({ ok: false, message: "Missing orgId on user" });
    }

    const org = await Organization.findById(orgId).lean();

    if (!org) {
      return res.status(404).json({ ok: false, message: "Organization not found" });
    }

    return res.status(200).json({
      ok: true,
      integrations: org.integrations || {},
      orgId: org._id,
    });
  } catch (err) {
    console.error("getCurrentIntegrations error:", err);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
};
