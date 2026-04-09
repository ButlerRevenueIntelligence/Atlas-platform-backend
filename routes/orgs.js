// backend/routes/orgs.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const Organization = require("../models/Organization");
const Membership = require("../models/Membership");
const auth = require("../middleware/auth");

// simple slug helper
function slugify(value = "") {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Create workspace / org
router.post("/", auth, async (req, res) => {
  try {
    const { name, slug, plan = "Enterprise" } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Organization name is required." });
    }

    const finalSlug = slugify(slug || name);

    const existingOrg = await Organization.findOne({
      $or: [{ name: name.trim() }, { slug: finalSlug }],
    });

    if (existingOrg) {
      return res.status(409).json({
        message: "An organization with that name or slug already exists.",
      });
    }

    const org = await Organization.create({
      name: name.trim(),
      slug: finalSlug,
      plan,
      status: "active",
      createdBy: req.user.id,
    });

    await Membership.create({
      userId: req.user.id,
      orgId: org._id,
      role: "owner",
      status: "active",
    });

    return res.status(201).json({
      ok: true,
      org: {
        _id: org._id,
        name: org.name,
        slug: org.slug,
        plan: org.plan,
        status: org.status,
      },
    });
  } catch (err) {
    console.error("Create org error:", err);
    return res.status(500).json({ message: "Failed to create organization." });
  }
});

module.exports = router;