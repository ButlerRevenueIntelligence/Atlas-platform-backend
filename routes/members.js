/**
 * DELETE /api/members/:membershipId
 * Owner/Admin can remove a member from the current workspace
 */
router.delete("/:membershipId", requireAuth, async (req, res) => {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx.ok) {
      return res.status(ctx.status).json({
        ok: false,
        message: ctx.message,
        code: ctx.code,
      });
    }

    if (!ctx.canManageMembers) {
      return res.status(403).json({
        ok: false,
        message: "Only owners and admins can manage workspace members.",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    const membershipId = toId(req.params.membershipId);

    if (!membershipId) {
      return res.status(400).json({
        ok: false,
        message: "Invalid membershipId",
      });
    }

    const targetMembership = await Membership.findOne({
      _id: membershipId,
      orgId: ctx.orgId,
    });

    if (!targetMembership) {
      return res.status(404).json({
        ok: false,
        message: "Membership not found",
      });
    }

    const requesterRole = String(ctx.membership.role || "").toLowerCase();
    const targetRole = String(targetMembership.role || "").toLowerCase();

    if (String(targetMembership.userId) === String(ctx.userId)) {
      return res.status(400).json({
        ok: false,
        message: "You cannot remove your own membership.",
        code: "SELF_REMOVE_NOT_ALLOWED",
      });
    }

    if (requesterRole !== "owner" && targetRole === "owner") {
      return res.status(403).json({
        ok: false,
        message: "Only the workspace owner can remove another owner.",
        code: "OWNER_ONLY_ACTION",
      });
    }

    await Membership.deleteOne({
      _id: membershipId,
      orgId: ctx.orgId,
    });

    return res.json({
      ok: true,
      message: "Member removed from workspace",
    });
  } catch (err) {
    console.error("members delete error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Server error",
    });
  }
});
export default router;