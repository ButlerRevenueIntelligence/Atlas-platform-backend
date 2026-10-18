import express from 'express';
import GraphIQMonitor from '../models/GraphIQMonitor.js';
import { MANAGERS, validateMonitor, loadMonitor, monitorDto } from '../services/graphiqMonitoring.js';
const router = express.Router();
// Mounted behind the MCP router's authenticated workspace, permission and membership gates.
router.get('/', async (req, res, next) => {
  try {
    res.json({
      ok: true,
      monitor: await loadMonitor(req.orgId),
      canManage: MANAGERS.includes(req.graphiqMember.role)
    });
  } catch (e) {
    next(e);
  }
});
router.put('/', async (req, res, next) => {
  if (!MANAGERS.includes(req.graphiqMember.role)) return res.status(403).json({
    message: 'A workspace manager must change monitoring settings'
  });
  let config;
  try {
    config = validateMonitor(req.body);
  } catch (e) {
    return res.status(400).json({
      message: e.message
    });
  }
  try {
    // Revision + unique orgId provide compare-and-swap, including concurrent first saves.
    const doc = await GraphIQMonitor.findOneAndUpdate({
      orgId: req.orgId,
      revision: req.body.revision
    }, {
      $set: {
        ...config,
        updatedBy: req.user.userId,
        nextRunAt: new Date(),
        failureCount: 0
      },
      $inc: {
        revision: 1
      }
    }, {
      new: true,
      upsert: req.body.revision === 0,
      runValidators: true,
      setDefaultsOnInsert: true
    }).lean();
    if (!doc) return res.status(409).json({
      message: 'Monitoring changed in another session. Reload and try again.'
    });
    res.json({
      ok: true,
      monitor: monitorDto(doc),
      canManage: true
    });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({
      message: 'Monitoring changed in another session. Reload and try again.'
    });
    next(e);
  }
});
export default router;
