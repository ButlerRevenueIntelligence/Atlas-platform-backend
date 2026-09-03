import express from "express";
import mongoose from "mongoose";
import Partner from "../models/Partner.js";
import { requireAuth, requireOrgRole } from "../middleware/auth.js";

const router = express.Router();

const toObjId = (value) => {
  if (!value) return null;

  const stringValue = String(value);

  return mongoose.Types.ObjectId.isValid(stringValue)
    ? new mongoose.Types.ObjectId(stringValue)
    : null;
};

const cleanString = (value) =>
  typeof value === "string" ? value.trim() : "";

const cleanNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

const allowedTypes = [
  "referral",
  "reseller",
  "technology",
  "strategic",
  "affiliate",
  "agency",
  "other",
];

const allowedStatuses = [
  "active",
  "prospective",
  "inactive",
  "archived",
];

function getOrgId(req) {
  return toObjId(req.user?.orgId);
}

function getUserId(req) {
  return toObjId(req.user?.userId || req.user?._id || req.user?.id);
}

/**
 * GET /api/partners
 * Returns actual partner records belonging to the active workspace.
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const orgId = getOrgId(req);

    if (!orgId) {
      return res.status(400).json({
        ok: false,
        message: "Missing org context",
      });
    }

    const query = {
      orgId,
      status: { $ne: "archived" },
    };

    const requestedStatus = cleanString(req.query?.status).toLowerCase();

    if (
      requestedStatus &&
      allowedStatuses.includes(requestedStatus) &&
      requestedStatus !== "archived"
    ) {
      query.status = requestedStatus;
    }

    const partners = await Partner.find(query)
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      ok: true,
      partners,
    });
  } catch (err) {
    console.error("GET /api/partners error:", err);

    return res.status(500).json({
      ok: false,
      message: err?.message || "Server error",
    });
  }
});

/**
 * POST /api/partners
 * Creates a partner in the active workspace.
 * Only owners and admins should manage partner records.
 */
router.post(
  "/",
  requireAuth,
  requireOrgRole("admin"),
  async (req, res) => {
    try {
      const orgId = getOrgId(req);
      const userId = getUserId(req);

      if (!orgId) {
        return res.status(400).json({
          ok: false,
          message: "Missing org context",
        });
      }

      const companyName = cleanString(req.body?.companyName);
      const contactName = cleanString(req.body?.contactName);
      const email = cleanString(req.body?.email).toLowerCase();

      const partnershipType = cleanString(
        req.body?.partnershipType
      ).toLowerCase();

      const status = cleanString(req.body?.status).toLowerCase();

      if (!companyName) {
        return res.status(400).json({
          ok: false,
          message: "Partner company name is required",
        });
      }

      const duplicate = await Partner.findOne({
        orgId,
        companyName: {
          $regex: `^${companyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          $options: "i",
        },
        status: { $ne: "archived" },
      }).lean();

      if (duplicate) {
        return res.status(409).json({
          ok: false,
          message: "A partner with this company name already exists",
        });
      }

      const partner = await Partner.create({
        orgId,
        companyName,
        contactName,
        email,
        partnershipType: allowedTypes.includes(partnershipType)
          ? partnershipType
          : "referral",
        status: allowedStatuses.includes(status) ? status : "active",
        referredOpportunities: cleanNumber(
          req.body?.referredOpportunities
        ),
        influencedPipeline: cleanNumber(req.body?.influencedPipeline),
        revenueGenerated: cleanNumber(req.body?.revenueGenerated),
        notes: cleanString(req.body?.notes),
        createdBy: userId,
        updatedBy: userId,
      });

      return res.status(201).json({
        ok: true,
        partner,
      });
    } catch (err) {
      console.error("POST /api/partners error:", err);

      return res.status(500).json({
        ok: false,
        message: err?.message || "Server error",
      });
    }
  }
);

/**
 * PATCH /api/partners/:partnerId
 * Updates a partner in the active workspace.
 */
router.patch(
  "/:partnerId",
  requireAuth,
  requireOrgRole("admin"),
  async (req, res) => {
    try {
      const orgId = getOrgId(req);
      const partnerId = toObjId(req.params.partnerId);
      const userId = getUserId(req);

      if (!orgId) {
        return res.status(400).json({
          ok: false,
          message: "Missing org context",
        });
      }

      if (!partnerId) {
        return res.status(400).json({
          ok: false,
          message: "Invalid partner ID",
        });
      }

      const updates = {};

      if (req.body?.companyName !== undefined) {
        const companyName = cleanString(req.body.companyName);

        if (!companyName) {
          return res.status(400).json({
            ok: false,
            message: "Partner company name is required",
          });
        }

        updates.companyName = companyName;
      }

      if (req.body?.contactName !== undefined) {
        updates.contactName = cleanString(req.body.contactName);
      }

      if (req.body?.email !== undefined) {
        updates.email = cleanString(req.body.email).toLowerCase();
      }

      if (req.body?.partnershipType !== undefined) {
        const partnershipType = cleanString(
          req.body.partnershipType
        ).toLowerCase();

        if (!allowedTypes.includes(partnershipType)) {
          return res.status(400).json({
            ok: false,
            message: "Invalid partnership type",
          });
        }

        updates.partnershipType = partnershipType;
      }

      if (req.body?.status !== undefined) {
        const status = cleanString(req.body.status).toLowerCase();

        if (!allowedStatuses.includes(status)) {
          return res.status(400).json({
            ok: false,
            message: "Invalid partner status",
          });
        }

        updates.status = status;
      }

      if (req.body?.referredOpportunities !== undefined) {
        updates.referredOpportunities = cleanNumber(
          req.body.referredOpportunities
        );
      }

      if (req.body?.influencedPipeline !== undefined) {
        updates.influencedPipeline = cleanNumber(
          req.body.influencedPipeline
        );
      }

      if (req.body?.revenueGenerated !== undefined) {
        updates.revenueGenerated = cleanNumber(
          req.body.revenueGenerated
        );
      }

      if (req.body?.notes !== undefined) {
        updates.notes = cleanString(req.body.notes);
      }

      updates.updatedBy = userId;

      const partner = await Partner.findOneAndUpdate(
        {
          _id: partnerId,
          orgId,
        },
        {
          $set: updates,
        },
        {
          new: true,
          runValidators: true,
        }
      ).lean();

      if (!partner) {
        return res.status(404).json({
          ok: false,
          message: "Partner not found",
        });
      }

      return res.json({
        ok: true,
        partner,
      });
    } catch (err) {
      console.error("PATCH /api/partners/:partnerId error:", err);

      return res.status(500).json({
        ok: false,
        message: err?.message || "Server error",
      });
    }
  }
);

/**
 * DELETE /api/partners/:partnerId
 * Archives the partner instead of permanently deleting it.
 */
router.delete(
  "/:partnerId",
  requireAuth,
  requireOrgRole("admin"),
  async (req, res) => {
    try {
      const orgId = getOrgId(req);
      const partnerId = toObjId(req.params.partnerId);
      const userId = getUserId(req);

      if (!orgId) {
        return res.status(400).json({
          ok: false,
          message: "Missing org context",
        });
      }

      if (!partnerId) {
        return res.status(400).json({
          ok: false,
          message: "Invalid partner ID",
        });
      }

      const partner = await Partner.findOneAndUpdate(
        {
          _id: partnerId,
          orgId,
        },
        {
          $set: {
            status: "archived",
            updatedBy: userId,
          },
        },
        {
          new: true,
          runValidators: true,
        }
      ).lean();

      if (!partner) {
        return res.status(404).json({
          ok: false,
          message: "Partner not found",
        });
      }

      return res.json({
        ok: true,
        message: "Partner archived",
      });
    } catch (err) {
      console.error("DELETE /api/partners/:partnerId error:", err);

      return res.status(500).json({
        ok: false,
        message: err?.message || "Server error",
      });
    }
  }
);

export default router;
