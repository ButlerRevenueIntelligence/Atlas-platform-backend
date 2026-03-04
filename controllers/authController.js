// backend/controllers/authController.js

import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import User from "../models/user.js";
import Organization from "../models/organization.js";

/*
  ==========================================
  JWT SIGN FUNCTION
  ==========================================
*/
const signToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      orgId: user.orgId,
      role: user.role
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
};

/*
  ==========================================
  SIGNUP
  Creates:
   - Organization
   - Owner User
   - JWT
  ==========================================
*/
export const signup = async (req, res) => {
  try {
    const { email, password, companyName } = req.body;

    if (!email || !password || !companyName) {
      return res.status(400).json({ error: "All fields required" });
    }

    const existing = await User.findOne({
      email: email.toLowerCase().trim()
    });

    if (existing) {
      return res.status(400).json({ error: "User already exists" });
    }

    // Create organization
    const org = await Organization.create({
      name: companyName,
      plan: "trial",
      isActive: true
    });

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const user = await User.create({
      email: email.toLowerCase().trim(),
      passwordHash,
      orgId: org._id,
      role: "owner",
      isActive: true
    });

    // Save ownerId to org
    await Organization.updateOne(
      { _id: org._id },
      { $set: { ownerId: user._id } }
    );

    const token = signToken(user);

    res.json({ token });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Signup failed" });
  }
};

/*
  ==========================================
  LOGIN
  ==========================================
*/
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({
      email: email.toLowerCase().trim()
    });

    if (!user) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);

    if (!ok) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const token = signToken(user);

    res.json({ token });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
};
