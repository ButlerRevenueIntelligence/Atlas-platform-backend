// backend/routes/deals.js
import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import Membership from "../models/Membership.js";
import Deal from "../models/Deal.js";
import Client from "../models/Client.js";

const router = express.Router();

const toObjectId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s)
    ? new mongoose.Types.ObjectId(s)
    : null;
};

const toDateOrNull = (v) => {
  if (v === undefined) return undefined;
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

function pickUserId(req) {
  return (
    toObjectId(req.user?.userId) ||
    toObjectId(req.user?.id) ||
    toObjectId(req.user?._id) ||
    null
  );
}

function pickOrgId(req) {
  const headerOrgId =
    toObjectId(req.headers["x-org-id"]) ||
    toObjectId(req.headers["x-workspace-id"]) ||
    null;

  const defaultOrgId =
    toObjectId(req.user?.orgId) ||
    toObjectId(req.user?.organizationId) ||
    toObjectId(req.user?.org) ||
    toObjectId(req.user?.activeWorkspace) ||
    null;

  return headerOrgId || defaultOrgId || null;
}

async function getOrgContext(req) {
  const userId = pickUserId(req);
  if (!userId) {
    return {
      ok: false,
      status: 401,
      message: "Unauthorized",
      code: "UNAUTHORIZED",
    };
  }

  const orgId = pickOrgId(req);
  if (!orgId) {
    return {
      ok: false,
      status: 400,
      message: "Missing org context (x-org-id).",
      code: "ORG_CONTEXT_REQUIRED",
      userId,
      orgId: null,
    };
  }

  const membership = await Membership.findOne({
    userId,
    orgId,
    status: { $ne: "disabled" },
  })
    .select("_id role status userId orgId")
    .lean();

  if (!membership) {
    return {
      ok: false,
      status: 403,
      message: "Not a member of this workspace",
      code: "ORG_ACCESS_DENIED",
    };
  }

  const role = String(membership.role || "analyst").toLowerCase();
  const canWrite = ["owner", "admin", "manager"].includes(role);

  return {
    ok: true,
    userId,
    orgId,
    membership,
    canWrite,
  };
}

const STAGES = [
  "Discovery",
  "Proposal",
  "Follow-Up",
  "Negotiation",
  "Closed Won",
  "Closed Lost",
];

function normalizeStage(s) {
  const val = (s || "").toString().trim();
  if (!val) return "Discovery";

  const lower = val.toLowerCase();
  if (lower.includes("disc")) return "Discovery";
  if (lower.includes("prop")) return "Proposal";
  if (lower.includes("follow")) return "Follow-Up";
  if (lower.includes("neg")) return "Negotiation";
  if (lower.includes("won")) return "Closed Won";
  if (lower.includes("lost")) return "Closed Lost";
  if (STAGES.includes(val)) return val;

  return "Discovery";
}

const isClosedStage = (stage) =>
  stage === "Closed Won" || stage === "Closed Lost";

// LIST deals
router.get("/", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx.ok) {
      return res.status(ctx.status).json({
        ok: false,
        message: ctx.message,
        code: ctx.code,
      });
    }

    const q = (req.query.q || "").toString().trim();
    const stage = (req.query.stage || "").toString().trim();

    const filter = { orgId: ctx.orgId };

    if (stage) {
      filter.stage = normalizeStage(stage);
    }

    if (q) {
      filter.name = { $regex: q, $options: "i" };
    }

    const deals = await Deal.find(filter)
      .sort({ createdAt: -1 })
      .limit(500)
      .populate({ path: "clientId", select: "name industry website status" })
      .lean();

    return res.status(200).json({
      ok: true,
      orgId: ctx.orgId,
      membership: {
        role: ctx.membership.role,
        status: ctx.membership.status,
      },
      deals,
    });
  } catch (err) {
    console.error("Deals list error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to list deals",
    });
  }
});

// GET one deal
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx.ok) {
      return res.status(ctx.status).json({
        ok: false,
        message: ctx.message,
        code: ctx.code,
      });
    }

    const id = toObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        ok: false,
        message: "Invalid deal id",
      });
    }

    const deal = await Deal.findOne({ _id: id, orgId: ctx.orgId })
      .populate({ path: "clientId", select: "name industry website status" })
      .lean();

    if (!deal) {
      return res.status(404).json({
        ok: false,
        message: "Deal not found",
      });
    }

    return res.status(200).json({
      ok: true,
      deal,
      membership: {
        role: ctx.membership.role,
        status: ctx.membership.status,
      },
    });
  } catch (err) {
    console.error("Deal get error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to get deal",
    });
  }
});

// GET deal activity timeline
router.get("/:id/activity", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx.ok) {
      return res.status(ctx.status).json({
        ok: false,
        message: ctx.message,
        code: ctx.code,
      });
    }

    const id = toObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        ok: false,
        message: "Invalid deal id",
      });
    }

    const deal = await Deal.findOne({ _id: id, orgId: ctx.orgId })
      .select(
        "activities nextAction nextActionDueAt lastActivityAt lastActivityType lastActivityNote stage amount probability createdAt closedAt closedReason competitor reactivationAt"
      )
      .lean();

    if (!deal) {
      return res.status(404).json({
        ok: false,
        message: "Deal not found",
      });
    }

    const activities = Array.isArray(deal.activities) ? deal.activities : [];
    activities.sort(
      (a, b) => new Date(b?.createdAt || 0) - new Date(a?.createdAt || 0)
    );

    return res.status(200).json({
      ok: true,
      nextAction: deal.nextAction || "",
      nextActionDueAt: deal.nextActionDueAt || null,
      lastActivityAt: deal.lastActivityAt || null,
      activities,
      outcome: {
        closedAt: deal.closedAt || null,
        closedReason: deal.closedReason || "",
        competitor: deal.competitor || "",
        reactivationAt: deal.reactivationAt || null,
      },
    });
  } catch (err) {
    console.error("Deal activity timeline error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to load activity",
    });
  }
});

// CREATE deal
router.post("/", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx.ok) {
      return res.status(ctx.status).json({
        ok: false,
        message: ctx.message,
        code: ctx.code,
      });
    }

    if (!ctx.canWrite) {
      return res.status(403).json({
        ok: false,
        message: "Insufficient permissions",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    const payload = req.body || {};
    const name = (payload.name || "").toString().trim();
    const clientId = toObjectId(payload.clientId);

    if (!name) {
      return res.status(400).json({
        ok: false,
        message: "Deal name is required",
      });
    }

    if (!clientId) {
      return res.status(400).json({
        ok: false,
        message: "clientId is required",
      });
    }

    const client = await Client.findOne({
      _id: clientId,
      orgId: ctx.orgId,
    })
      .select("_id")
      .lean();

    if (!client) {
      return res.status(400).json({
        ok: false,
        message: "Client not found for this org",
      });
    }

    const stage = normalizeStage(payload.stage || "Discovery");
    const now = new Date();

    const nextAction = (payload.nextAction || "").toString().trim();
    const nextActionDueAt = toDateOrNull(payload.nextActionDueAt);
    const closeDate = toDateOrNull(payload.closeDate);

    const doc = await Deal.create({
      orgId: ctx.orgId,
      workspaceId: ctx.orgId,
      clientId,
      name,
      stage,
      amount: Number(payload.amount ?? 0) || 0,
      probability: payload.probability == null ? 0.5 : Number(payload.probability),
      closeDate,
      nextAction,
      nextActionDueAt: nextActionDueAt === undefined ? null : nextActionDueAt,
      lastActivityAt: now,
      lastActivityType: "system",
      lastActivityNote: `Deal created in stage: ${stage}`,
      activities: [
        {
          type: "system",
          note: `Deal created in stage: ${stage}`,
          nextAction,
          createdAt: now,
          createdBy: ctx.userId,
        },
      ],
      closedAt: isClosedStage(stage) ? now : null,
      closedReason: (payload.closedReason || "").toString().trim(),
      competitor: (payload.competitor || "").toString().trim(),
      reactivationAt: toDateOrNull(payload.reactivationAt) ?? null,
    });

    const deal = await Deal.findById(doc._id)
      .populate({ path: "clientId", select: "name industry website status" })
      .lean();

    return res.status(201).json({
      ok: true,
      deal,
    });
  } catch (err) {
    console.error("Deal create error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to create deal",
    });
  }
});

// UPDATE deal
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx.ok) {
      return res.status(ctx.status).json({
        ok: false,
        message: ctx.message,
        code: ctx.code,
      });
    }

    if (!ctx.canWrite) {
      return res.status(403).json({
        ok: false,
        message: "Insufficient permissions",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    const id = toObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        ok: false,
        message: "Invalid deal id",
      });
    }

    const payload = req.body || {};
    const update = {};

    if (payload.name !== undefined) update.name = String(payload.name).trim();
    if (payload.amount !== undefined) update.amount = Number(payload.amount ?? 0) || 0;
    if (payload.probability !== undefined) update.probability = Number(payload.probability);
    if (payload.closeDate !== undefined) update.closeDate = toDateOrNull(payload.closeDate);

    if (payload.nextAction !== undefined) {
      update.nextAction = String(payload.nextAction || "").trim();
    }

    if (payload.nextActionDueAt !== undefined) {
      update.nextActionDueAt = toDateOrNull(payload.nextActionDueAt);
    }

    if (payload.closedReason !== undefined) {
      update.closedReason = String(payload.closedReason || "").trim();
    }

    if (payload.competitor !== undefined) {
      update.competitor = String(payload.competitor || "").trim();
    }

    if (payload.reactivationAt !== undefined) {
      update.reactivationAt = toDateOrNull(payload.reactivationAt);
    }

    if (payload.stage !== undefined) {
      const nextStage = normalizeStage(payload.stage);
      update.stage = nextStage;

      if (isClosedStage(nextStage)) {
        update.closedAt = new Date();
      } else {
        update.closedAt = null;
      }
    }

    if (payload.clientId !== undefined) {
      const newClientId = toObjectId(payload.clientId);

      if (!newClientId) {
        return res.status(400).json({
          ok: false,
          message: "Invalid clientId",
        });
      }

      const client = await Client.findOne({
        _id: newClientId,
        orgId: ctx.orgId,
      })
        .select("_id")
        .lean();

      if (!client) {
        return res.status(400).json({
          ok: false,
          message: "Client not found for this org",
        });
      }

      update.clientId = newClientId;
    }

    if (update.name !== undefined && !update.name) {
      return res.status(400).json({
        ok: false,
        message: "Deal name cannot be empty",
      });
    }

    const deal = await Deal.findOneAndUpdate(
      { _id: id, orgId: ctx.orgId },
      { $set: update },
      { new: true }
    )
      .populate({ path: "clientId", select: "name industry website status" })
      .lean();

    if (!deal) {
      return res.status(404).json({
        ok: false,
        message: "Deal not found",
      });
    }

    return res.status(200).json({
      ok: true,
      deal,
    });
  } catch (err) {
    console.error("Deal update error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to update deal",
    });
  }
});

// LOG ACTIVITY
router.post("/:id/activity", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx.ok) {
      return res.status(ctx.status).json({
        ok: false,
        message: ctx.message,
        code: ctx.code,
      });
    }

    if (!ctx.canWrite) {
      return res.status(403).json({
        ok: false,
        message: "Insufficient permissions",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    const id = toObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        ok: false,
        message: "Invalid deal id",
      });
    }

    const payload = req.body || {};
    const type =
      (payload.type || "note").toString().trim().toLowerCase() || "note";
    const note = (payload.note || "").toString().trim();
    const nextAction = (payload.nextAction || "").toString().trim();
    const nextActionDueAt = toDateOrNull(payload.nextActionDueAt);

    const now = new Date();

    const activity = {
      type,
      note,
      nextAction,
      createdAt: now,
      createdBy: ctx.userId,
    };

    const $set = {
      lastActivityAt: now,
      lastActivityType: type,
      lastActivityNote: note,
    };

    if (nextAction) {
      $set.nextAction = nextAction;
    }

    if (nextActionDueAt !== undefined) {
      $set.nextActionDueAt = nextActionDueAt;
    }

    const deal = await Deal.findOneAndUpdate(
      { _id: id, orgId: ctx.orgId },
      {
        $push: {
          activities: {
            $each: [activity],
            $slice: -50,
          },
        },
        $set,
      },
      { new: true }
    )
      .populate({ path: "clientId", select: "name industry website status" })
      .lean();

    if (!deal) {
      return res.status(404).json({
        ok: false,
        message: "Deal not found",
      });
    }

    return res.status(200).json({
      ok: true,
      deal,
    });
  } catch (err) {
    console.error("Deal activity error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to log activity",
    });
  }
});

// QUICK STAGE MOVE
router.patch("/:id/stage", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx.ok) {
      return res.status(ctx.status).json({
        ok: false,
        message: ctx.message,
        code: ctx.code,
      });
    }

    if (!ctx.canWrite) {
      return res.status(403).json({
        ok: false,
        message: "Insufficient permissions",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    const id = toObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        ok: false,
        message: "Invalid deal id",
      });
    }

    const stage = normalizeStage(req.body?.stage);
    const now = new Date();

    const $set = {
      stage,
      lastActivityAt: now,
      lastActivityType: "stage_move",
      lastActivityNote: `Stage moved to: ${stage}`,
    };

    if (isClosedStage(stage)) {
      $set.closedAt = now;
    } else {
      $set.closedAt = null;
    }

    const deal = await Deal.findOneAndUpdate(
      { _id: id, orgId: ctx.orgId },
      {
        $set,
        $push: {
          activities: {
            $each: [
              {
                type: "stage_move",
                note: `Stage moved to: ${stage}`,
                nextAction: "",
                createdAt: now,
                createdBy: ctx.userId,
              },
            ],
            $slice: -50,
          },
        },
      },
      { new: true }
    )
      .populate({ path: "clientId", select: "name industry website status" })
      .lean();

    if (!deal) {
      return res.status(404).json({
        ok: false,
        message: "Deal not found",
      });
    }

    return res.status(200).json({
      ok: true,
      deal,
    });
  } catch (err) {
    console.error("Deal stage patch error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to update stage",
    });
  }
});

// DELETE deal
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx.ok) {
      return res.status(ctx.status).json({
        ok: false,
        message: ctx.message,
        code: ctx.code,
      });
    }

    if (!ctx.canWrite) {
      return res.status(403).json({
        ok: false,
        message: "Insufficient permissions",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    const id = toObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        ok: false,
        message: "Invalid deal id",
      });
    }

    const result = await Deal.deleteOne({ _id: id, orgId: ctx.orgId });

    if (!result.deletedCount) {
      return res.status(404).json({
        ok: false,
        message: "Deal not found",
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Deal delete error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to delete deal",
    });
  }
});

export default router;