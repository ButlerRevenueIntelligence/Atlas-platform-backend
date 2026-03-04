// backend/middleware/requireRole.js

export function requireMinRole(minRole) {
  const roleRank = {
    owner: 5,
    admin: 4,
    manager: 3,
    analyst: 2,
    sales: 1,
  };

  return (req, res, next) => {
    const userRole = req.membership?.role || "analyst";

    if (roleRank[userRole] >= roleRank[minRole]) {
      return next();
    }

    return res.status(403).json({
      ok: false,
      message: "Insufficient permissions",
    });
  };
}