// backend/routes/clients.js
import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import Membership from "../models/Membership.js";
import Client from "../models/Client.js";
import Deal from "../models/Deal.js";

const router = express.Router();

const toObjectId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s)
    ? new mongoose.Types.ObjectId(s)
    : null;
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

// LIST clients
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
    const status = (req.query.status || "").toString().trim().toLowerCase();

    const filter = { orgId: ctx.orgId };

    if (status) {
      filter.status = status;
    }

    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { industry: { $regex: q, $options: "i" } },
        { website: { $regex: q, $options: "i" } },
        { domain: { $regex: q, $options: "i" } },
        { primaryContactName: { $regex: q, $options: "i" } },
        { primaryContactEmail: { $regex: q, $options: "i" } },
      ];
    }

    const clients = await Client.find(filter)
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return res.status(200).json({
      ok: true,
      orgId: ctx.orgId,
      membership: {
        role: ctx.membership.role,
        status: ctx.membership.status,
      },
      clients,
    });
  } catch (err) {
    console.error("Clients list error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to list clients",
    });
  }
});

// GET single client
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
        message: "Invalid client id",
      });
    }

    const client = await Client.findOne({ _id: id, orgId: ctx.orgId }).lean();

    if (!client) {
      return res.status(404).json({
        ok: false,
        message: "Client not found",
      });
    }

    return res.status(200).json({
      ok: true,
      client,
      membership: {
        role: ctx.membership.role,
        status: ctx.membership.status,
      },
    });
  } catch (err) {
    console.error("Client get error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to get client",
    });
  }
});

// CREATE client
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

    if (!name) {
      return res.status(400).json({
        ok: false,
        message: "Client name is required",
      });
    }

    const doc = await Client.create({
      orgId: ctx.orgId,
      workspaceId: ctx.orgId,
      name,
      website: (payload.website || "").toString().trim(),
      industry: (payload.industry || "").toString().trim(),
      primaryContactName: (payload.primaryContactName || "").toString().trim(),
      primaryContactEmail: (payload.primaryContactEmail || "")
        .toString()
        .trim()
        .toLowerCase(),
      primaryContactPhone: (payload.primaryContactPhone || "").toString().trim(),
      status: (payload.status || "active").toString().trim().toLowerCase(),
      notes: (payload.notes || "").toString().trim(),
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    });

    return res.status(201).json({
      ok: true,
      client: doc.toObject(),
    });
  } catch (err) {
    console.error("Client create error:", err);

    if (err?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message: "A client with that primary contact email already exists in this workspace.",
        code: "DUPLICATE_CLIENT_CONTACT_EMAIL",
      });
    }

    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to create client",
    });
  }
});

// UPDATE client
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
        message: "Invalid client id",
      });
    }

    const payload = req.body || {};
    const update = {};

    const setIf = (key, value) => {
      if (value === undefined) return;
      update[key] = value;
    };

    setIf("name", payload.name !== undefined ? String(payload.name).trim() : undefined);
    setIf("website", payload.website !== undefined ? String(payload.website).trim() : undefined);
    setIf("industry", payload.industry !== undefined ? String(payload.industry).trim() : undefined);
    setIf(
      "primaryContactName",
      payload.primaryContactName !== undefined
        ? String(payload.primaryContactName).trim()
        : undefined
    );
    setIf(
      "primaryContactEmail",
      payload.primaryContactEmail !== undefined
        ? String(payload.primaryContactEmail).trim().toLowerCase()
        : undefined
    );
    setIf(
      "primaryContactPhone",
      payload.primaryContactPhone !== undefined
        ? String(payload.primaryContactPhone).trim()
        : undefined
    );
    setIf(
      "status",
      payload.status !== undefined
        ? String(payload.status).trim().toLowerCase()
        : undefined
    );
    setIf("notes", payload.notes !== undefined ? String(payload.notes).trim() : undefined);

    update.updatedBy = ctx.userId;

    if (update.name !== undefined && !update.name) {
      return res.status(400).json({
        ok: false,
        message: "Client name cannot be empty",
      });
    }

    const client = await Client.findOneAndUpdate(
      { _id: id, orgId: ctx.orgId },
      { $set: update },
      { new: true }
    ).lean();

    if (!client) {
      return res.status(404).json({
        ok: false,
        message: "Client not found",
      });
    }

    return res.status(200).json({
      ok: true,
      client,
    });
  } catch (err) {
    console.error("Client update error:", err);

    if (err?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message: "A client with that primary contact email already exists in this workspace.",
        code: "DUPLICATE_CLIENT_CONTACT_EMAIL",
      });
    }

    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to update client",
    });
  }
});

// DELETE client
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
        message: "Invalid client id",
      });
    }

    const existingDeals = await Deal.countDocuments({
      clientId: id,
      orgId: ctx.orgId,
    });

    if (existingDeals > 0) {
      return res.status(400).json({
        ok: false,
        message: `Cannot delete client. ${existingDeals} deal(s) are still linked.`,
        code: "CLIENT_HAS_DEALS",
      });
    }

    const result = await Client.deleteOne({ _id: id, orgId: ctx.orgId });

    if (!result.deletedCount) {
      return res.status(404).json({
        ok: false,
        message: "Client not found",
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Client delete error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to delete client",
    });
  }
});

export default router;