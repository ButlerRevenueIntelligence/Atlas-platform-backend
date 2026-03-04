// backend/middleware/requirePerm.js
import { hasPerm } from "../utils/permissions.js";

export function requirePerm(perm) {
  return (req, res, next) => {
    const perms = req.user?.perms || [];
    if (!hasPerm(perms, perm)) {
      return res.status(403).json({
        ok: false,
        message: `Missing permission: ${perm}`,
      });
    }
    next();
  };
}