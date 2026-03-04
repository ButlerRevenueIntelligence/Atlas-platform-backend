// backend/routes/clients.js
import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import Membership from "../models/Membership.js";
import Client from "../models/Client.js";

const router = express.Router();

const toObjectId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
};

async function getOrgContext(req) {
  const userId = toObjectId(req.user?.userId);
  if (!userId) return { ok: false, status: 401, message: "Unauthorized" };

  const headerOrgId = toObjectId(req.headers["x-org-id"]);
  const defaultOrgId = toObjectId(req.user?.orgId);
  const orgId = headerOrgId || defaultOrgId;

  if (!orgId) return { ok: false, status: 200, message: "No org selected", userId, orgId: null };

  const membership = await Membership.findOne({
    userId,
    orgId,
    status: { $ne: "disabled" },
  })
    .select("_id role status")
    .lean();

  if (!membership) {
    return { ok: false, status: 403, message: "Not a member of this workspace" };
  }

  const role = (membership.role || "analyst").toLowerCase();
  const canWrite = role === "owner" || role === "admin" || role === "manager";

  return { ok: true, userId, orgId, membership, canWrite };
}

// LIST clients (with search)
router.get("/", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx.ok) return res.status(ctx.status).json({ ok: false, message: ctx.message });

    if (!ctx.orgId) return res.status(200).json({ ok: true, clients: [] });

    const q = (req.query.q || "").toString().trim();
    const filter = { orgId: ctx.orgId };

    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { industry: { $regex: q, $options: "i" } },
        { primaryContactEmail: { $regex: q, $options: "i" } },
      ];
    }

    const clients = await Client.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    return res.status(200).json({ ok: true, clients });
  } catch (err) {
    console.error("Clients list error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Failed to list clients" });
  }
});

// GET single client
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx.ok) return res.status(ctx.status).json({ ok: false, message: ctx.message });
    if (!ctx.orgId) return res.status(404).json({ ok: false, message: "Client not found" });

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: "Invalid client id" });

    const client = await Client.findOne({ _id: id, orgId: ctx.orgId }).lean();
    if (!client) return res.status(404).json({ ok: false, message: "Client not found" });

    return res.status(200).json({ ok: true, client });
  } catch (err) {
    console.error("Client get error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Failed to get client" });
  }
});

// CREATE client
router.post("/", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx.ok) return res.status(ctx.status).json({ ok: false, message: ctx.message });
    if (!ctx.canWrite) return res.status(403).json({ ok: false, message: "Insufficient permissions" });
    if (!ctx.orgId) return res.status(400).json({ ok: false, message: "No org selected" });

    const payload = req.body || {};
    const name = (payload.name || "").toString().trim();
    if (!name) return res.status(400).json({ ok: false, message: "Client name is required" });

    const doc = await Client.create({
      orgId: ctx.orgId,
      name,
      website: (payload.website || "").toString().trim(),
      industry: (payload.industry || "").toString().trim(),
      primaryContactName: (payload.primaryContactName || "").toString().trim(),
      primaryContactEmail: (payload.primaryContactEmail || "").toString().trim().toLowerCase(),
      primaryContactPhone: (payload.primaryContactPhone || "").toString().trim(),
      status: (payload.status || "active").toString().trim(),
      notes: (payload.notes || "").toString(),
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    });

    return res.status(201).json({ ok: true, client: doc.toObject() });
  } catch (err) {
    console.error("Client create error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Failed to create client" });
  }
});

// UPDATE client
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx.ok) return res.status(ctx.status).json({ ok: false, message: ctx.message });
    if (!ctx.canWrite) return res.status(403).json({ ok: false, message: "Insufficient permissions" });
    if (!ctx.orgId) return res.status(400).json({ ok: false, message: "No org selected" });

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: "Invalid client id" });

    const payload = req.body || {};

    const update = {};
    const setIf = (k, v) => {
      if (v === undefined) return;
      update[k] = v;
    };

    setIf("name", payload.name !== undefined ? String(payload.name).trim() : undefined);
    setIf("website", payload.website !== undefined ? String(payload.website).trim() : undefined);
    setIf("industry", payload.industry !== undefined ? String(payload.industry).trim() : undefined);
    setIf(
      "primaryContactName",
      payload.primaryContactName !== undefined ? String(payload.primaryContactName).trim() : undefined
    );
    setIf(
      "primaryContactEmail",
      payload.primaryContactEmail !== undefined ? String(payload.primaryContactEmail).trim().toLowerCase() : undefined
    );
    setIf(
      "primaryContactPhone",
      payload.primaryContactPhone !== undefined ? String(payload.primaryContactPhone).trim() : undefined
    );
    setIf("status", payload.status !== undefined ? String(payload.status).trim() : undefined);
    setIf("notes", payload.notes !== undefined ? String(payload.notes) : undefined);

    update.updatedBy = ctx.userId;

    if (update.name !== undefined && !update.name) {
      return res.status(400).json({ ok: false, message: "Client name cannot be empty" });
    }

    const client = await Client.findOneAndUpdate(
      { _id: id, orgId: ctx.orgId },
      { $set: update },
      { new: true }
    ).lean();

    if (!client) return res.status(404).json({ ok: false, message: "Client not found" });

    return res.status(200).json({ ok: true, client });
  } catch (err) {
    console.error("Client update error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Failed to update client" });
  }
});

// DELETE client
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);
    if (!ctx.ok) return res.status(ctx.status).json({ ok: false, message: ctx.message });
    if (!ctx.canWrite) return res.status(403).json({ ok: false, message: "Insufficient permissions" });
    if (!ctx.orgId) return res.status(400).json({ ok: false, message: "No org selected" });

    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: "Invalid client id" });

    // 🔥 NEW: Prevent deleting client with deals
    const Deal = (await import("../models/Deal.js")).default;

    const existingDeals = await Deal.countDocuments({
      clientId: id,
      orgId: ctx.orgId,
    });

    if (existingDeals > 0) {
      return res.status(400).json({
        ok: false,
        message: `Cannot delete client. ${existingDeals} deal(s) are still linked.`,
      });
    }

    const result = await Client.deleteOne({ _id: id, orgId: ctx.orgId });
    if (!result.deletedCount) return res.status(404).json({ ok: false, message: "Client not found" });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Client delete error:", err);
    return res.status(500).json({ ok: false, message: err?.message || "Failed to delete client" });
  }
});

export default router;