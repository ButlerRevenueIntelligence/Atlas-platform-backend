import GraphIQResearch from '../models/GraphIQResearch.js';
const clean = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const url = v => {
  if (typeof v !== 'string' || v.length > 2048) return '';
  try {
    const u = new URL(v);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : '';
  } catch {
    return '';
  }
};
const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(v) && Number.isFinite(new Date(v).getTime()) ? new Date(v).toISOString() : null;
export function normalizeResearch(result, kind) {
  let payload = result.structuredContent;
  const text = (Array.isArray(result.content) ? result.content : []).filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
  if (!payload && text) {
    try {
      payload = JSON.parse(text);
    } catch {}
  }
  const rows = Array.isArray(payload) ? payload : payload?.articles || payload?.news || payload?.organizations || payload?.entities || payload?.results || payload?.items || payload?.data || [];
  const records = Array.isArray(rows) ? rows.filter(r => r && typeof r === 'object').slice(0, 20).map((r, i) => kind === 'news' ? {
    id: clean(String(r.id || r['@id'] || i), 200),
    title: clean(r.title || r.headline || r.name, 500),
    summary: clean(r.summary || r.description || r.snippet, 2000),
    url: url(r.url || r.article_url || r.link),
    publishedAt: date(r.published_at || r.publishedAt || r.publication_date || r.date),
    publisher: clean(typeof r.source === 'string' ? r.source : r.source?.name || r.publisher?.name, 200)
  } : {
    id: clean(String(r.id || r['@id'] || i), 200),
    name: clean(r.name || r.organization_name || r.company_name, 300),
    description: clean(r.description || r.summary, 2000),
    website: url(r.website || r.website_url || r.url)
  }).filter(r => kind === 'news' ? r.title : r.name) : [];
  return {
    records,
    text: records.length ? '' : clean(text || (payload ? JSON.stringify(payload) : ''), 20000)
  };
}
export const researchDto = doc => doc ? {
  snapshotId: String(doc._id),
  kind: doc.kind,
  query: doc.query,
  tool: doc.tool,
  records: doc.records || [],
  text: doc.text || '',
  asOf: doc.createdAt,
  expiresAt: doc.expiresAt,
  source: 'GraphIQ MCP'
} : null;
export async function loadNewsContext(orgId, snapshotId) {
  if (!/^[a-f0-9]{24}$/i.test(String(snapshotId || ''))) return null;
  return researchDto(await GraphIQResearch.findOne({
    _id: snapshotId,
    orgId,
    kind: 'news',
    expiresAt: {
      $gt: new Date()
    }
  }).lean());
}
