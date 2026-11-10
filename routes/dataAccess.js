import express from "express";
import mongoose from "mongoose";
import Acceptance from "../models/DataAccessAcceptance.js";
import { integrationWorkspace } from "../middleware/integrationWorkspace.js";
import { dataAccessAdmin, accessFailure } from "../middleware/dataAccess.js";
import {
  dataAccessMode,
  policySnapshot,
  CHECKBOXES,
} from "../services/dataAccessPolicy.js";
import { agreementDigest } from "../services/dataAccess.js";
const router = express.Router();
router.use(integrationWorkspace);
router.get("/:provider", async (req, res) => {
  try {
    const p = policySnapshot(req.params.provider);
    const latest = await Acceptance.findOne({
      orgId: req.user.orgId,
      provider: req.params.provider,
      digest: p.digest,
    })
      .sort({ acceptedAt: -1 })
      .lean();
    const own =
      latest && String(latest.userId) === String(req.user.userId || req.user.id)
        ? latest
        : await Acceptance.findOne({
            orgId: req.user.orgId,
            userId: req.user.userId || req.user.id,
            provider: req.params.provider,
            digest: p.digest,
          })
            .sort({ acceptedAt: -1 })
            .lean();
    const signed = await Acceptance.findOne({
      orgId: req.user.orgId,
      agreementDigest: agreementDigest(p.snapshot),
    }).lean();
    return res.json({
      ok: true,
      mode: dataAccessMode(),
      ...p,
      canAccept: Boolean(await dataAccessAdmin(req)),
      agreementAccepted: Boolean(signed),
      receipt: own || latest || null,
    });
  } catch (error) {
    return accessFailure(res, error);
  }
});
router.post("/:provider/accept", async (req, res) => {
  try {
    if (!(await dataAccessAdmin(req)))
      return res
        .status(403)
        .json({
          ok: false,
          message:
            "Only an active workspace owner or administrator can accept.",
        });
    const p = policySnapshot(req.params.provider);
    if (dataAccessMode() !== "enforce" || !p.ready)
      return res
        .status(409)
        .json({
          ok: false,
          message: "This disclosure is a draft and cannot be accepted.",
        });
    if (req.body.digest !== p.digest)
      return res
        .status(409)
        .json({
          ok: false,
          message:
            "The disclosure changed. Reload and review the current version.",
        });
    const signed = await Acceptance.findOne({
      orgId: req.user.orgId,
      agreementDigest: agreementDigest(p.snapshot),
    }).lean();
    const required = signed
      ? ["authority", "processing"]
      : Object.keys(CHECKBOXES);
    if (!required.every((k) => req.body.acknowledgments?.[k] === true))
      return res
        .status(400)
        .json({
          ok: false,
          message: "Complete every required acknowledgment.",
        });
    const receipt = await Acceptance.create({
      orgId: req.user.orgId,
      userId: req.user.userId || req.user.id,
      email: req.user.email,
      provider: req.params.provider,
      digest: p.digest,
      agreementDigest: agreementDigest(p.snapshot),
      snapshot: p.snapshot,
      acknowledgments: {
        authority: true,
        processing: true,
        agreement: !signed,
        priorAgreementReceiptId: signed ? String(signed._id) : null,
      },
    });
    return res.status(201).json({ ok: true, receipt });
  } catch (error) {
    return accessFailure(res, error);
  }
});
router.get("/receipts/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id))
      return res.status(404).json({ ok: false, message: "Receipt not found." });
    const receipt = await Acceptance.findOne({
      _id: req.params.id,
      orgId: req.user.orgId,
    }).lean();
    if (!receipt)
      return res.status(404).json({ ok: false, message: "Receipt not found." });
    return res.json({ ok: true, receipt });
  } catch (error) {
    return accessFailure(res, error);
  }
});
export default router;
