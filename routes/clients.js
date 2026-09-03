// backend/routes/clients.js
import express from "express";
import mongoose from "mongoose";

import { requireAuth } from "../middleware/auth.js";
import Membership from "../models/Membership.js";
import Client from "../models/Client.js";

const router = express.Router();

const ALLOWED_STATUSES = [
  "active",
  "paused",
  "prospect",
  "archived",
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const toObjectId = (value) => {
  if (!value) return null;

  const stringValue = String(value);

  return mongoose.Types.ObjectId.isValid(stringValue)
    ? new mongoose.Types.ObjectId(stringValue)
    : null;
};

const cleanString = (value, maxLength = 500) =>
  String(value || "").trim().slice(0, maxLength);

const normalizeEmail = (value) =>
  cleanString(value, 200).toLowerCase();

const escapeRegex = (value) =>
  String(value || "").replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

function normalizeWebsite(value) {
  const website = cleanString(value, 500);

  if (!website) {
    return {
      website: "",
      domain: "",
    };
  }

  try {
    const normalized = /^https?:\/\//i.test(website)
      ? website
      : `https://${website}`;

    const parsed = new URL(normalized);

    if (!parsed.hostname || !parsed.hostname.includes(".")) {
      return null;
    }

    return {
      website: normalized,
      domain: parsed.hostname
        .toLowerCase()
        .replace(/^www\./, ""),
    };
  } catch {
    return null;
  }
}

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
      message: "Missing workspace context.",
      code: "ORG_CONTEXT_REQUIRED",
    };
  }

  const membership = await Membership.findOne({
    userId,
    orgId,
    status: { $nin: ["disabled", "suspended"] },
  })
    .select("_id role status userId orgId")
    .lean();

  if (!membership) {
    return {
      ok: false,
      status: 403,
      message: "Not an active member of this workspace.",
      code: "ORG_ACCESS_DENIED",
    };
  }

  const role = String(
    membership.role || "analyst"
  ).toLowerCase();

  const canWrite = [
    "owner",
    "admin",
    "manager",
  ].includes(role);

  return {
    ok: true,
    userId,
    orgId,
    membership,
    role,
    canWrite,
  };
}

function sendContextError(res, ctx) {
  return res.status(ctx.status).json({
    ok: false,
    message: ctx.message,
    code: ctx.code,
  });
}

function sendWritePermissionError(res) {
  return res.status(403).json({
    ok: false,
    message:
      "Only workspace owners, administrators, and managers can manage customer accounts.",
    code: "INSUFFICIENT_PERMISSIONS",
  });
}

function validateStatus(value) {
  const status = cleanString(
    value || "active",
    30
  ).toLowerCase();

  return ALLOWED_STATUSES.includes(status)
    ? status
    : null;
}

function validateContactEmail(value) {
  const email = normalizeEmail(value);

  if (!email) {
    return {
      ok: true,
      email: "",
    };
  }

  if (!EMAIL_PATTERN.test(email)) {
    return {
      ok: false,
      email: "",
    };
  }

  return {
    ok: true,
    email,
  };
}

/**
 * GET /api/clients
 *
 * Lists customer accounts in the active workspace.
 * Archived accounts are hidden unless status=archived.
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx.ok) {
      return sendContextError(res, ctx);
    }

    const query = cleanString(req.query?.q, 100);
    const requestedStatus = cleanString(
      req.query?.status,
      30
    ).toLowerCase();

    const filter = {
      orgId: ctx.orgId,
    };

    if (requestedStatus) {
      if (!ALLOWED_STATUSES.includes(requestedStatus)) {
        return res.status(400).json({
          ok: false,
          message: "Invalid account status.",
          code: "INVALID_STATUS",
        });
      }

      filter.status = requestedStatus;
    } else {
      filter.status = { $ne: "archived" };
    }

    if (query) {
      const safeQuery = escapeRegex(query);

      filter.$or = [
        {
          name: {
            $regex: safeQuery,
            $options: "i",
          },
        },
        {
          industry: {
            $regex: safeQuery,
            $options: "i",
          },
        },
        {
          website: {
            $regex: safeQuery,
            $options: "i",
          },
        },
        {
          domain: {
            $regex: safeQuery,
            $options: "i",
          },
        },
        {
          primaryContactName: {
            $regex: safeQuery,
            $options: "i",
          },
        },
        {
          primaryContactEmail: {
            $regex: safeQuery,
            $options: "i",
          },
        },
      ];
    }

    const clients = await Client.find(filter)
      .sort({
        status: 1,
        name: 1,
        createdAt: -1,
      })
      .limit(200)
      .lean();

    return res.json({
      ok: true,
      orgId: String(ctx.orgId),

      membership: {
        role: ctx.role,
        status: ctx.membership.status,
        canWrite: ctx.canWrite,
      },

      clients,
    });
  } catch (err) {
    console.error("GET /api/clients error:", err);

    return res.status(500).json({
      ok: false,
      message:
        err?.message ||
        "Failed to list customer accounts.",
    });
  }
});

/**
 * GET /api/clients/:id
 *
 * Returns one workspace-scoped customer account.
 */
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx.ok) {
      return sendContextError(res, ctx);
    }

    const clientId = toObjectId(req.params.id);

    if (!clientId) {
      return res.status(400).json({
        ok: false,
        message: "Invalid account ID.",
        code: "INVALID_CLIENT_ID",
      });
    }

    const client = await Client.findOne({
      _id: clientId,
      orgId: ctx.orgId,
    }).lean();

    if (!client) {
      return res.status(404).json({
        ok: false,
        message: "Customer account not found.",
        code: "CLIENT_NOT_FOUND",
      });
    }

    return res.json({
      ok: true,
      client,

      membership: {
        role: ctx.role,
        status: ctx.membership.status,
        canWrite: ctx.canWrite,
      },
    });
  } catch (err) {
    console.error("GET /api/clients/:id error:", err);

    return res.status(500).json({
      ok: false,
      message:
        err?.message ||
        "Failed to load customer account.",
    });
  }
});

/**
 * POST /api/clients
 *
 * Creates a customer account in the active workspace.
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx.ok) {
      return sendContextError(res, ctx);
    }

    if (!ctx.canWrite) {
      return sendWritePermissionError(res);
    }

    const name = cleanString(
      req.body?.name,
      150
    );

    if (!name) {
      return res.status(400).json({
        ok: false,
        message: "Account name is required.",
        code: "NAME_REQUIRED",
      });
    }

    const status = validateStatus(
      req.body?.status || "active"
    );

    if (!status || status === "archived") {
      return res.status(400).json({
        ok: false,
        message:
          "New accounts must be active, paused, or prospect.",
        code: "INVALID_STATUS",
      });
    }

    const websiteData = normalizeWebsite(
      req.body?.website
    );

    if (req.body?.website && !websiteData) {
      return res.status(400).json({
        ok: false,
        message:
          "Enter a valid company website.",
        code: "INVALID_WEBSITE",
      });
    }

    const contactEmail = validateContactEmail(
      req.body?.primaryContactEmail
    );

    if (!contactEmail.ok) {
      return res.status(400).json({
        ok: false,
        message:
          "Enter a valid primary contact email.",
        code: "INVALID_EMAIL",
      });
    }

    const duplicateConditions = [
      {
        name: {
          $regex: `^${escapeRegex(name)}$`,
          $options: "i",
        },
      },
    ];

    if (websiteData?.domain) {
      duplicateConditions.push({
        domain: websiteData.domain,
      });
    }

    const duplicate = await Client.findOne({
      orgId: ctx.orgId,
      status: { $ne: "archived" },
      $or: duplicateConditions,
    }).lean();

    if (duplicate) {
      return res.status(409).json({
        ok: false,
        message:
          "A customer account with this name or domain already exists.",
        code: "CLIENT_ALREADY_EXISTS",
      });
    }

    const client = await Client.create({
      orgId: ctx.orgId,
      workspaceId: ctx.orgId,
      name,
      website: websiteData?.website || "",
      domain: websiteData?.domain || "",
      industry: cleanString(
        req.body?.industry,
        120
      ),
      primaryContactName: cleanString(
        req.body?.primaryContactName,
        120
      ),
      primaryContactEmail:
        contactEmail.email,
      primaryContactPhone: cleanString(
        req.body?.primaryContactPhone,
        50
      ),
      status,
      notes: cleanString(
        req.body?.notes,
        3000
      ),
      archivedAt: null,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    });

    return res.status(201).json({
      ok: true,
      client: client.toObject(),
    });
  } catch (err) {
    console.error("POST /api/clients error:", err);

    if (err?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message:
          "A customer account with this contact email already exists.",
        code: "DUPLICATE_CLIENT",
      });
    }

    return res.status(500).json({
      ok: false,
      message:
        err?.message ||
        "Failed to create customer account.",
    });
  }
});

/**
 * PUT /api/clients/:id
 *
 * Updates a workspace-scoped customer account.
 */
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx.ok) {
      return sendContextError(res, ctx);
    }

    if (!ctx.canWrite) {
      return sendWritePermissionError(res);
    }

    const clientId = toObjectId(req.params.id);

    if (!clientId) {
      return res.status(400).json({
        ok: false,
        message: "Invalid account ID.",
        code: "INVALID_CLIENT_ID",
      });
    }

    const existingClient = await Client.findOne({
      _id: clientId,
      orgId: ctx.orgId,
    });

    if (!existingClient) {
      return res.status(404).json({
        ok: false,
        message: "Customer account not found.",
        code: "CLIENT_NOT_FOUND",
      });
    }

    const updates = {
      updatedBy: ctx.userId,
    };

    if (req.body?.name !== undefined) {
      const name = cleanString(
        req.body.name,
        150
      );

      if (!name) {
        return res.status(400).json({
          ok: false,
          message:
            "Account name cannot be empty.",
          code: "NAME_REQUIRED",
        });
      }

      updates.name = name;
    }

    if (req.body?.website !== undefined) {
      const websiteData = normalizeWebsite(
        req.body.website
      );

      if (req.body.website && !websiteData) {
        return res.status(400).json({
          ok: false,
          message:
            "Enter a valid company website.",
          code: "INVALID_WEBSITE",
        });
      }

      updates.website =
        websiteData?.website || "";

      updates.domain =
        websiteData?.domain || "";
    }

    if (req.body?.industry !== undefined) {
      updates.industry = cleanString(
        req.body.industry,
        120
      );
    }

    if (
      req.body?.primaryContactName !== undefined
    ) {
      updates.primaryContactName = cleanString(
        req.body.primaryContactName,
        120
      );
    }

    if (
      req.body?.primaryContactEmail !== undefined
    ) {
      const contactEmail = validateContactEmail(
        req.body.primaryContactEmail
      );

      if (!contactEmail.ok) {
        return res.status(400).json({
          ok: false,
          message:
            "Enter a valid primary contact email.",
          code: "INVALID_EMAIL",
        });
      }

      updates.primaryContactEmail =
        contactEmail.email;
    }

    if (
      req.body?.primaryContactPhone !== undefined
    ) {
      updates.primaryContactPhone = cleanString(
        req.body.primaryContactPhone,
        50
      );
    }

    if (req.body?.status !== undefined) {
      const status = validateStatus(
        req.body.status
      );

      if (!status) {
        return res.status(400).json({
          ok: false,
          message:
            "Invalid customer account status.",
          code: "INVALID_STATUS",
        });
      }

      updates.status = status;
      updates.archivedAt =
        status === "archived"
          ? new Date()
          : null;
    }

    if (req.body?.notes !== undefined) {
      updates.notes = cleanString(
        req.body.notes,
        3000
      );
    }

    const finalName =
      updates.name || existingClient.name;

    const finalDomain =
      updates.domain !== undefined
        ? updates.domain
        : existingClient.domain;

    const duplicateConditions = [
      {
        name: {
          $regex: `^${escapeRegex(
            finalName
          )}$`,
          $options: "i",
        },
      },
    ];

    if (finalDomain) {
      duplicateConditions.push({
        domain: finalDomain,
      });
    }

    const duplicate = await Client.findOne({
      _id: { $ne: clientId },
      orgId: ctx.orgId,
      status: { $ne: "archived" },
      $or: duplicateConditions,
    }).lean();

    if (duplicate) {
      return res.status(409).json({
        ok: false,
        message:
          "Another customer account already uses this name or domain.",
        code: "CLIENT_ALREADY_EXISTS",
      });
    }

    const client =
      await Client.findOneAndUpdate(
        {
          _id: clientId,
          orgId: ctx.orgId,
        },
        {
          $set: updates,
        },
        {
          new: true,
          runValidators: true,
        }
      ).lean();

    return res.json({
      ok: true,
      client,
    });
  } catch (err) {
    console.error(
      "PUT /api/clients/:id error:",
      err
    );

    if (err?.code === 11000) {
      return res.status(409).json({
        ok: false,
        message:
          "Another customer account already uses this contact email.",
        code: "DUPLICATE_CLIENT",
      });
    }

    return res.status(500).json({
      ok: false,
      message:
        err?.message ||
        "Failed to update customer account.",
    });
  }
});

/**
 * DELETE /api/clients/:id
 *
 * Safely archives the account instead of deleting it.
 * Linked deals and account history remain intact.
 */
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx.ok) {
      return sendContextError(res, ctx);
    }

    if (!ctx.canWrite) {
      return sendWritePermissionError(res);
    }

    const clientId = toObjectId(req.params.id);

    if (!clientId) {
      return res.status(400).json({
        ok: false,
        message: "Invalid account ID.",
        code: "INVALID_CLIENT_ID",
      });
    }

    const client =
      await Client.findOneAndUpdate(
        {
          _id: clientId,
          orgId: ctx.orgId,
        },
        {
          $set: {
            status: "archived",
            archivedAt: new Date(),
            updatedBy: ctx.userId,
          },
        },
        {
          new: true,
          runValidators: true,
        }
      ).lean();

    if (!client) {
      return res.status(404).json({
        ok: false,
        message: "Customer account not found.",
        code: "CLIENT_NOT_FOUND",
      });
    }

    return res.json({
      ok: true,
      message: "Customer account archived.",
      client,
    });
  } catch (err) {
    console.error(
      "DELETE /api/clients/:id error:",
      err
    );

    return res.status(500).json({
      ok: false,
      message:
        err?.message ||
        "Failed to archive customer account.",
    });
  }
});

export default router;
