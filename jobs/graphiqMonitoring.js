import { graphIQDiagnostic, logGraphIQEvent } from '../services/graphiqDiagnostics.js';
import cron from 'node-cron';
import { randomUUID } from 'node:crypto';
import GraphIQMonitor from '../models/GraphIQMonitor.js';
import GraphIQSlackDelivery from '../models/GraphIQSlackDelivery.js';
import Organization from '../models/Organization.js';
import Membership from '../models/Membership.js';
import { getGraphIQSlackStatus, notifyGraphIQResearch } from '../services/slackGraphIQAlerts.js';
import { retrieveGraphIQResearch } from '../services/retrieveGraphIQResearch.js';
import { MANAGERS } from '../services/graphiqMonitoring.js';
const MINUTE = 60000;
export function workspaceCanMonitor(org, now = new Date()) {
  if (!org || org.accessStatus !== 'active' || org.trial?.status === 'expired') return false;
  const paid = org.billing?.status === 'active' || org.paymentStatus === 'paid';
  if (paid) return true;
  if (org.trial?.status === 'trialing' && org.trial.endsAt && new Date(org.trial.endsAt) <= now) return false;
  return org.billing?.status === 'trialing' || org.paymentStatus === 'trialing';
}
// One workspace lease spans all saved queries; it survives restarts and competing replicas.
export async function runGraphIQMonitoring({
  now = new Date(),
  maxWorkspaces = 10,
  clock = () => new Date(),
  retrieve = retrieveGraphIQResearch,
  notify = notifyGraphIQResearch,
  slackStatus = getGraphIQSlackStatus
} = {}) {
  const summary = {
    claimed: 0,
    completed: 0
  };
  if (!process.env.GRAPHIQ_API_KEY) return {
    ...summary,
    reason: 'missing_graphiq_key'
  };
  // Indexes are required before admitting any scheduled work, including on new deployments.
  await Promise.all([GraphIQMonitor.init(), GraphIQSlackDelivery.init()]);
  for (let n = 0; n < Math.min(10, Math.max(0, maxWorkspaces)); n++) {
    const claim = randomUUID(),
      claimAt = clock();
    const monitor = await GraphIQMonitor.findOneAndUpdate({
      enabled: true,
      nextRunAt: {
        $lte: now
      },
      leaseUntil: {
        $lte: now
      }
    }, {
      $set: {
        claim,
        leaseUntil: new Date(claimAt.getTime() + 30 * MINUTE),
        lastRunAt: claimAt,
        lastState: 'running'
      }
    }, {
      new: true,
      sort: {
        nextRunAt: 1
      }
    }).lean();
    if (!monitor) break;
    summary.claimed++;
    logGraphIQEvent('monitor_check_started', {
      orgId: monitor.orgId
    });
    const owner = {
      _id: monitor._id,
      orgId: monitor.orgId,
      claim
    };
    const current = async () => Boolean(await GraphIQMonitor.exists({
      ...owner,
      revision: monitor.revision,
      enabled: true,
      leaseUntil: {
        $gt: clock()
      }
    }));
    let state = 'success',
      reason = null,
      disable = false;
    const results = [];
    try {
      const org = await Organization.findById(monitor.orgId).select('accessStatus billing paymentStatus trial').lean();
      const member = await Membership.findOne({
        orgId: monitor.orgId,
        userId: monitor.updatedBy,
        status: 'active',
        role: {
          $in: MANAGERS
        }
      }).lean();
      const slack = await slackStatus(monitor.orgId);
      if (!workspaceCanMonitor(org, clock())) {
        state = 'paused';
        reason = 'workspace_inactive';
      } else if (!member) {
        state = 'paused';
        reason = 'manager_access_required';
      } else if (!slack.connected || !slack.enabled) {
        state = 'paused';
        reason = 'slack_unavailable_or_disabled';
      } else for (const search of monitor.searches) {
        if (!(await current())) {
          state = 'superseded';
          break;
        }
        try {
          const activeSlack = await slackStatus(monitor.orgId);
          if (!activeSlack.connected || !activeSlack.enabled) {
            state = 'paused';
            reason = 'slack_unavailable_or_disabled';
            break;
          }
          logGraphIQEvent('monitor_query_started', {
            orgId: monitor.orgId
          });
          const result = await retrieve({
            orgId: monitor.orgId,
            kind: search.kind,
            query: search.query
          });
          // A settings change or expired lease fences a provider response before notification.
          if (!(await current())) {
            state = 'superseded';
            break;
          }
          const delivery = await notify({
            orgId: monitor.orgId,
            ...search,
            records: result.records
          });
          results.push({
            ...search,
            count: result.records.length,
            delivery
          });
        } catch (e) {
          logGraphIQEvent('monitor_query_failed', {
            orgId: monitor.orgId,
            ...graphIQDiagnostic(e)
          });
          state = 'error';
          disable = ['redirect_rejected', 'authentication_failed', 'access_denied', 'unsupported_schema', 'unsupported_tool', 'unsupported_protocol'].includes(e.code);
          reason = disable ? 'graphiq_access_check_required' : 'graphiq_check_failed';
          // Store a safe classification, never provider response bodies or secrets.
          results.push({
            ...search,
            diagnostic: graphIQDiagnostic(e),
            error: ['redirect_rejected', 'authentication_failed', 'access_denied', 'unsupported_schema', 'unsupported_tool', 'unsupported_protocol'].includes(e.code) ? e.code : 'provider_unavailable'
          });
          break;
        }
      }
    } catch {
      state = 'error';
      reason = 'monitor_processing_failed';
    }
    const finished = clock(),
      failures = state === 'error' ? (monitor.failureCount || 0) + 1 : 0;
    const interval = state === 'error' ? Math.max(monitor.intervalMinutes, Math.min(1440, 60 * 2 ** Math.min(failures - 1, 5))) : monitor.intervalMinutes;
    await GraphIQMonitor.updateOne({
      ...owner,
      revision: monitor.revision
    }, {
      $set: {
        ...(disable ? {
          enabled: false
        } : {}),
        lastState: state,
        lastReason: reason,
        lastCompletedAt: finished,
        lastResults: results,
        failureCount: failures,
        nextRunAt: new Date(finished.getTime() + interval * MINUTE),
        leaseUntil: new Date(0),
        claim: null
      }
    });
    // Release a previous revision without overwriting its replacement's next run or settings.
    await GraphIQMonitor.updateOne(owner, {
      $set: {
        leaseUntil: new Date(0),
        claim: null
      }
    });
    logGraphIQEvent('monitor_check_finished', {
      orgId: monitor.orgId,
      state,
      results: results.length
    });
    summary.completed++;
  }
  return summary;
}
export function startGraphIQMonitoring() {
  let running = false,
    stopped = false;
  logGraphIQEvent('monitor_scheduler_started');
  let lastHeartbeat = 0;
  const task = cron.schedule('* * * * *', async () => {
    if (running || stopped) return;
    running = true;
    try {
      const summary = await runGraphIQMonitoring();
      if (summary.claimed || Date.now() - lastHeartbeat >= 300000) {
        logGraphIQEvent('monitor_scheduler_tick', summary.reason ? {
          code: summary.reason
        } : summary);
        lastHeartbeat = Date.now();
      }
    } catch {
      logGraphIQEvent('monitor_scheduler_failed', {
        code: 'internal_error'
      });
    } finally {
      running = false;
    }
  });
  return () => {
    stopped = true;
    task.stop();
  };
}
