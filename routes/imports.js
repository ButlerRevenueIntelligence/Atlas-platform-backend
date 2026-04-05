import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import Membership from "../models/Membership.js";

const router = express.Router();

const toObjectId = (v) => {
  if (!v) return null;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s)
    ? new mongoose.Types.ObjectId(s)
    : null;
};

const safeNum = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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
  return (
    toObjectId(req.headers["x-org-id"]) ||
    toObjectId(req.headers["x-workspace-id"]) ||
    toObjectId(req.user?.orgId) ||
    toObjectId(req.user?.organizationId) ||
    toObjectId(req.user?.org) ||
    toObjectId(req.user?.activeWorkspace) ||
    null
  );
}

async function getOrgContext(req) {
  const userId = pickUserId(req);
  const orgId = pickOrgId(req);

  if (!userId) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  if (!orgId) {
    return {
      ok: false,
      status: 400,
      message: "Missing org context (x-org-id).",
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
    };
  }

  return { ok: true, userId, orgId, membership };
}

function normalizeKey(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[_-]/g, "");
}

function getValue(row, keys = []) {
  const entries = Object.entries(row || {});
  const normalized = new Map(entries.map(([k, v]) => [normalizeKey(k), v]));

  for (const key of keys) {
    const val = normalized.get(normalizeKey(key));
    if (val !== undefined && val !== null && String(val).trim() !== "") {
      return val;
    }
  }

  return "";
}

function parseDate(value) {
  if (!value) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === "number") {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const parsed = new Date(excelEpoch.getTime() + value * 86400000);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeStage(stage) {
  const s = String(stage || "").trim().toLowerCase();
  if (!s) return "Discovery";
  if (s.includes("disc")) return "Discovery";
  if (s.includes("prop")) return "Proposal";
  if (s.includes("follow")) return "Follow-Up";
  if (s.includes("neg")) return "Negotiation";
  if (s.includes("won")) return "Closed Won";
  if (s.includes("lost")) return "Closed Lost";
  return "Discovery";
}

function detectRowType(row) {
  const hasDealSignals =
    getValue(row, ["deal name", "deal title", "name", "opportunity", "opportunity name", "deal"]) ||
    getValue(row, ["stage", "pipeline stage"]) ||
    getValue(row, ["amount", "value", "deal value", "expected revenue"]);

  const hasMetricSignals =
    !!getValue(row, ["date", "day"]) &&
    [
      getValue(row, ["revenue", "sales"]),
      getValue(row, ["spend", "ad spend", "cost"]),
      getValue(row, ["leads"]),
    ].some((v) => String(v || "").trim() !== "");

  if (hasMetricSignals) return "metric";
  if (hasDealSignals) return "deal";
  return "unknown";
}

router.post("/spreadsheet", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx.ok) {
      return res.status(ctx.status).json({
        ok: false,
        message: ctx.message,
      });
    }

    const db = mongoose.connection.db;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const fileName = String(req.body?.fileName || "spreadsheet");
    const importMode = String(req.body?.mode || "auto").toLowerCase();

    if (!rows.length) {
      return res.status(400).json({
        ok: false,
        message: "No spreadsheet rows received.",
      });
    }

    let dealsInserted = 0;
    let metricsInserted = 0;
    let skipped = 0;

    const clientsCollection = db.collection("clients");
    const dealsCollection = db.collection("deals");
    const metricsCollection = db.collection("metrics_daily");

    for (const row of rows) {
      const rowType = importMode === "auto" ? detectRowType(row) : importMode;

      if (rowType === "deal") {
        const clientName = String(
          getValue(row, ["client", "client name", "account", "company"]) || ""
        ).trim();

        let clientId = null;

        if (clientName) {
          let existingClient = await clientsCollection.findOne({
            orgId: ctx.orgId,
            name: clientName,
          });

          if (!existingClient) {
            const insertedClient = await clientsCollection.insertOne({
              orgId: ctx.orgId,
              name: clientName,
              website: String(getValue(row, ["website"]) || "").trim(),
              industry: String(getValue(row, ["industry"]) || "").trim(),
              notes: `Imported from ${fileName}`,
              createdAt: new Date(),
              updatedAt: new Date(),
            });

            clientId = insertedClient.insertedId;
          } else {
            clientId = existingClient._id;
          }
        }

        const dealName = String(
          getValue(row, ["deal name", "deal title", "name", "opportunity", "opportunity name", "deal"]) || ""
        ).trim();

        if (!dealName) {
          skipped += 1;
          continue;
        }

        const existingDeal = await dealsCollection.findOne({
          orgId: ctx.orgId,
          name: dealName,
          clientId: clientId || null,
        });

        if (existingDeal) {
          skipped += 1;
          continue;
        }

        const rawProbability = safeNum(
          getValue(row, ["probability", "close probability", "win probability"]),
          0.5
        );

        const normalizedProbability =
          rawProbability > 1 ? Math.min(rawProbability / 100, 1) : Math.max(rawProbability, 0);

        await dealsCollection.insertOne({
          orgId: ctx.orgId,
          clientId,
          name: dealName,
          amount: safeNum(getValue(row, ["amount", "value", "deal value", "expected revenue"]), 0),
          stage: normalizeStage(getValue(row, ["stage", "pipeline stage"])),
          probability: normalizedProbability,
          closeDate: parseDate(getValue(row, ["close date", "expected close date"])),
          nextAction: String(getValue(row, ["next action"]) || "").trim(),
          nextActionDueAt: parseDate(getValue(row, ["next action due", "next action due date"])),
          closedReason: String(getValue(row, ["closed reason", "loss reason"]) || "").trim(),
          competitor: String(getValue(row, ["competitor"]) || "").trim(),
          reactivationAt: parseDate(getValue(row, ["reactivation date"])),
          createdAt: new Date(),
          updatedAt: new Date(),
          source: "spreadsheet_import",
        });

        dealsInserted += 1;
        continue;
      }

      if (rowType === "metric") {
        const date = parseDate(getValue(row, ["date", "day"]));

        if (!date) {
          skipped += 1;
          continue;
        }

        const existingMetric = await metricsCollection.findOne({
          orgId: ctx.orgId,
          date,
        });

        if (existingMetric) {
          skipped += 1;
          continue;
        }

        await metricsCollection.insertOne({
          orgId: ctx.orgId,
          date,
          revenue: safeNum(getValue(row, ["revenue", "sales"]), 0),
          spend: safeNum(getValue(row, ["spend", "ad spend", "cost"]), 0),
          leads: safeNum(getValue(row, ["leads"]), 0),
          createdAt: new Date(),
          updatedAt: new Date(),
          source: "spreadsheet_import",
        });

        metricsInserted += 1;
        continue;
      }

      skipped += 1;
    }

    return res.json({
      ok: true,
      message: "Spreadsheet imported successfully.",
      summary: {
        fileName,
        totalRows: rows.length,
        dealsInserted,
        metricsInserted,
        skipped,
      },
    });
  } catch (err) {
    console.error("spreadsheet import error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Server error",
    });
  }
});

export default router;