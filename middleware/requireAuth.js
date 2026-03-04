// backend/middleware/requireAuth.js
import jwt from "jsonwebtoken";
import User from "../models/User.js";

export default async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");

    if (type !== "Bearer" || !token) {
      return res.status(401).json({ ok: false, message: "Missing token." });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ ok: false, message: "Missing JWT_SECRET." });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, secret);
    } catch (e) {
      return res.status(401).json({ ok: false, message: "Invalid token." });
    }

    // IMPORTANT: your token stores the user id in decoded.sub
    const userId = decoded?.sub;
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Invalid token payload (no user id)." });
    }

    const user = await User.findById(userId).select("-passwordHash");
    if (!user) {
      return res.status(401).json({ ok: false, message: "User not found." });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error("requireAuth error:", err);
    return res.status(401).json({ ok: false, message: "Unauthorized." });
  }
}