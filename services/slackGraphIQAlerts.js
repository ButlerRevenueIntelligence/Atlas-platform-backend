import { createHash, randomUUID } from 'node:crypto';
import IntegrationConnection from '../models/IntegrationConnection.js';
import Organization from '../models/Organization.js';
import GraphIQSlackDelivery from '../models/GraphIQSlackDelivery.js';
const DAY = 86400000;
const hash = value => createHash('sha256').update(value).digest('hex');
const escape = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clean = (v, n = 500) => typeof v === 'string' ? v.trim().slice(0, n) : '';
const canonical = value => {
  try {
    const u = new URL(value);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return '';
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    return u.href.slice(0, 2048);
  } catch {
    return '';
  }
};
export function graphIQAlertItems(kind, records = []) {
  if (!Array.isArray(records)) return [];
  const items = [];
  const seen = new Set();
  for (const r of records.slice(0, 100)) {
    if (!r || typeof r !== 'object') continue;
    const name = clean(kind === 'news' ? r.title : r.name, 200),
      link = canonical(kind === 'news' ? r.url : r.website),
      summary = clean(kind === 'news' ? r.summary : r.description, 700);
    if (!name) continue;
    const publisher = clean(r.publisher, 150),
      publishedAt = typeof r.publishedAt === 'string' && Number.isFinite(new Date(r.publishedAt).getTime()) ? new Date(r.publishedAt).toISOString() : null;
    const fingerprint = hash(JSON.stringify(kind === 'news' ? ['news', link || [name.toLowerCase(), publisher.toLowerCase(), publishedAt]] : ['companies', name.toLowerCase(), link, summary]));
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    items.push({
      fingerprint,
      name,
      link,
      summary,
      publisher,
      publishedAt
    });
  }
  return items.slice(0, 20);
}
export function validSlackWebhook(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && ['hooks.slack.com', 'hooks.slack-gov.com'].includes(u.hostname) && !u.port && !u.username && !u.password && !u.search && !u.hash && /^\/services\/[A-Za-z0-9_/-]+$/.test(u.pathname);
  } catch {
    return false;
  }
}
const text = value => ({
  type: 'plain_text',
  text: clean(value, 2900),
  emoji: false
});
export function buildGraphIQSlackPayload({
  workspace,
  kind,
  query,
  items,
  sourcePage,
  now = new Date()
}) {
  const root = 'https://app.atlasrevenueai.com',
    path = sourcePage === 'account-intelligence' ? '/account-intelligence' : '/market-signals';
  const blocks = [{
    type: 'header',
    text: text(kind === 'news' ? 'Atlas · GraphIQ news' : 'Atlas · GraphIQ company research')
  }, {
    type: 'section',
    text: text(`${workspace || 'Atlas workspace'} · ${items.length} new or changed ${kind === 'news' ? 'news result(s)' : 'company profile(s)'}\nSearch: ${clean(query, 300)}\nRetrieved: ${now.toISOString()}`)
  }];
  for (const item of items.slice(0, 5)) {
    blocks.push({
      type: 'section',
      text: text(`${item.name}\n${item.summary}${kind === 'news' ? `\nPublisher: ${item.publisher || 'Not supplied'} · Published: ${item.publishedAt || 'Not supplied'}` : ''}`),
      ...(item.link ? {
        accessory: {
          type: 'button',
          text: text('Open source'),
          url: item.link,
          action_id: 'graphiq_source'
        }
      } : {})
    });
  }
  if (items.length > 5) blocks.push({
    type: 'context',
    elements: [text(`${items.length - 5} additional results are available in Atlas.`)]
  });
  blocks.push({
    type: 'context',
    elements: [text('Source: GraphIQ. Reporting and company profiles do not establish buying intent or a verified CRM account match.')]
  }, {
    type: 'actions',
    elements: [{
      type: 'button',
      text: text('Open Market Signals'),
      url: root + '/market-signals',
      action_id: 'open_market_signals'
    }, {
      type: 'button',
      text: text('Open Account Intelligence'),
      url: root + '/account-intelligence',
      action_id: 'open_account_intelligence'
    }]
  });
  return {
    text: `Atlas GraphIQ ${kind === 'news' ? 'news' : 'company research'}: ${items.length} new or changed results for ${escape(clean(query, 200))}. ${root + path}`,
    blocks,
    unfurl_links: false,
    unfurl_media: false
  };
}
export async function getGraphIQSlackStatus(orgId) {
  const connection = await IntegrationConnection.findOne({
    orgId,
    provider: 'slack'
  }).select('status mode settings.graphiqAlertsEnabled metadata.incomingWebhookChannel metadata.graphiqAlerts').lean();
  return {
    connected: connection?.status === 'connected' && connection?.mode === 'live',
    enabled: connection?.settings?.graphiqAlertsEnabled !== false,
    channel: connection?.metadata?.incomingWebhookChannel || null,
    lastDelivery: connection?.metadata?.graphiqAlerts || null
  };
}
async function recordStatus(connection, orgId, status) {
  await IntegrationConnection.updateOne({
    _id: connection._id,
    orgId
  }, {
    $set: {
      'metadata.graphiqAlerts': status
    }
  });
}
// Distinguish definite HTTP rejections from ambiguous network failures. Never auto-retry an uncertain send.
export async function notifyGraphIQResearch({
  orgId,
  kind,
  query,
  records,
  sourcePage,
  now = new Date()
}) {
  if (!['market-signals', 'account-intelligence'].includes(sourcePage)) return {
    state: 'skipped',
    reason: 'not_a_notifying_view'
  };
  if (!orgId || !['news', 'companies'].includes(kind)) return {
    state: 'skipped',
    reason: 'unsupported_research'
  };
  const items = graphIQAlertItems(kind, records);
  if (!items.length) return {
    state: 'skipped',
    reason: 'no_structured_results'
  };
  let connection, claimScope;
  let attempted = false;
  try {
    connection = await IntegrationConnection.findOne({
      orgId,
      provider: 'slack',
      status: 'connected',
      mode: 'live'
    }).select('+webhookUrl');
    if (!connection) return {
      state: 'skipped',
      reason: 'slack_not_connected'
    };
    if (connection.settings?.graphiqAlertsEnabled === false) return {
      state: 'skipped',
      reason: 'disabled'
    };
    const webhook = String(connection.webhookUrl || '');
    if (!validSlackWebhook(webhook)) return {
      state: 'failed',
      reason: 'invalid_slack_destination'
    };
    const org = await Organization.findById(orgId).select('name').lean();
    const destination = hash(webhook),
      claim = randomUUID(),
      claimed = [];
    claimScope = {
      orgId,
      destination,
      claim
    };
    for (const item of items) {
      const filter = {
        orgId,
        destination,
        fingerprint: item.fingerprint
      };
      try {
        await GraphIQSlackDelivery.create({
          ...filter,
          claim,
          state: 'sending',
          expiresAt: new Date(now.getTime() + 30 * DAY)
        });
        claimed.push(item);
      } catch (e) {
        if (e.code !== 11000) throw e;
        const retried = await GraphIQSlackDelivery.findOneAndUpdate({
          ...filter,
          state: 'failed',
          retryAt: {
            $lte: now
          }
        }, {
          $set: {
            claim,
            state: 'sending',
            expiresAt: new Date(now.getTime() + 30 * DAY)
          }
        }, {
          new: true
        }).lean();
        if (retried) claimed.push(item);
      }
    }
    if (!claimed.length) return {
      state: 'skipped',
      reason: 'already_notified_or_in_progress'
    };
    const filter = {
      orgId,
      destination,
      claim,
      fingerprint: {
        $in: claimed.map(i => i.fingerprint)
      }
    };
    const payload = buildGraphIQSlackPayload({
      workspace: org?.name,
      kind,
      query,
      items: claimed,
      sourcePage,
      now
    });
    let response, body;
    try {
      attempted = true;
      response = await fetch(webhook, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      body = (await response.text()).trim();
    } catch {
      await GraphIQSlackDelivery.updateMany(filter, {
        $set: {
          state: 'uncertain'
        }
      });
      const status = {
        state: 'uncertain',
        reason: 'delivery_not_confirmed',
        attemptAt: now,
        kind
      };
      await recordStatus(connection, orgId, status);
      return status;
    }
    if (response.status >= 500 || response.status === 408 || response.ok && body !== 'ok') {
      await GraphIQSlackDelivery.updateMany(filter, {
        $set: {
          state: 'uncertain'
        }
      });
      const status = {
        state: 'uncertain',
        reason: 'delivery_not_confirmed',
        attemptAt: now,
        kind
      };
      await recordStatus(connection, orgId, status);
      return status;
    }
    if (!response.ok) {
      const seconds = Number(response.headers.get('retry-after'));
      const retryAt = new Date(now.getTime() + Math.min(86400, Math.max(60, Number.isFinite(seconds) ? seconds : 60)) * 1000);
      await GraphIQSlackDelivery.updateMany(filter, {
        $set: {
          state: 'failed',
          retryAt
        }
      });
      const status = {
        state: 'failed',
        reason: response.status === 429 ? 'slack_rate_limited' : 'slack_rejected',
        attemptAt: now,
        kind,
        retryAt
      };
      await recordStatus(connection, orgId, status);
      return status;
    }
    await GraphIQSlackDelivery.updateMany(filter, {
      $set: {
        state: 'sent',
        sentAt: now
      }
    });
    const status = {
      state: 'sent',
      sentAt: now,
      kind,
      count: claimed.length
    };
    await recordStatus(connection, orgId, status);
    return status;
  } catch {
    if (claimScope && !attempted) await GraphIQSlackDelivery.updateMany({
      ...claimScope,
      state: 'sending'
    }, {
      $set: {
        state: 'failed',
        retryAt: new Date(now.getTime() + 60000)
      }
    }).catch(() => {});
    const status = {
      state: attempted ? 'uncertain' : 'failed',
      reason: attempted ? 'delivery_status_not_saved' : 'notification_processing_failed',
      attemptAt: now,
      kind
    };
    if (connection) await recordStatus(connection, orgId, status).catch(() => {});
    return status;
  }
}
