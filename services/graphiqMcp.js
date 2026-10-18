import { networkFailureCode } from './graphiqDiagnostics.js';
import { randomUUID } from 'node:crypto';
export const GRAPHIQ_MCP_URL = 'https://app.graphiq.ai/mcp';
const VERSIONS = ['2025-03-26', '2025-06-18'];
const LIMIT = 2 * 1024 * 1024;
export class GraphIQMcpError extends Error {
  constructor(code, message, status = 502, diagnostic = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.diagnostic = diagnostic;
  }
}
const fail = (code, message, status, diagnostic) => {
  throw new GraphIQMcpError(code, message, status, diagnostic);
};
function rpcResult(value, id) {
  const messages = Array.isArray(value) ? value : [value];
  const found = messages.find(v => v?.jsonrpc === '2.0' && v.id === id && ('result' in v || 'error' in v));
  if (!found) return null;
  if (found.error) fail('provider_error', 'GraphIQ could not complete this MCP request. Check tool access and the connection.');
  return found.result;
}
export async function readMcpResponse(response, id) {
  const type = response.headers.get('content-type') || '';
  if (!/application\/json|text\/event-stream/.test(type)) fail('invalid_response', 'GraphIQ returned an unsupported MCP response.');
  const reader = response.body?.getReader();
  if (!reader) fail('invalid_response', 'GraphIQ returned no MCP response.');
  const decoder = new TextDecoder();
  let total = 0,
    buffer = '';
  try {
    while (true) {
      const {
        value,
        done
      } = await reader.read();
      if (value) {
        total += value.byteLength;
        if (total > LIMIT) fail('response_too_large', 'GraphIQ returned more data than this research view supports.');
        buffer += decoder.decode(value, {
          stream: true
        });
      }
      if (type.includes('text/event-stream')) {
        buffer = buffer.replace(/\r\n/g, '\n');
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let message;
          try {
            message = JSON.parse(data);
          } catch {
            fail('invalid_response', 'GraphIQ returned malformed MCP event data.');
          }
          const result = rpcResult(message, id);
          if (result !== null) return result;
        }
      }
      if (done) break;
    }
    if (type.includes('application/json')) {
      let parsed;
      try {
        parsed = JSON.parse(buffer);
      } catch {
        fail('invalid_response', 'GraphIQ returned malformed MCP JSON.');
      }
      const result = rpcResult(parsed, id);
      if (result !== null) return result;
    }
    fail('missing_response', 'GraphIQ ended the connection before returning this request.');
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export class GraphIQMcpClient {
  constructor({
    apiKey = process.env.GRAPHIQ_API_KEY,
    fetchImpl = globalThis.fetch,
    timeout = 12000
  } = {}) {
    if (!apiKey) fail('not_configured', 'GraphIQ API key is not configured on the backend.', 503);
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.timeout = timeout;
    this.deadline = Date.now() + 30000;
    this.session = null;
    this.version = null;
    this.endpoint = GRAPHIQ_MCP_URL;
  }
  async post(options, stage) {
    const redirectStatuses = [301, 302, 303, 307, 308];
    let response = await this.fetch(this.endpoint, options);
    if (!redirectStatuses.includes(response.status)) return response;
    const status = response.status,
      location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    let target;
    try {
      if (!location || location.length > 2048) throw new Error();
      target = new URL(location, this.endpoint);
    } catch {}
    // Only a single method-preserving canonical MCP redirect may receive credentials.
    if (![307, 308].includes(status) || !target || target.origin !== new URL(GRAPHIQ_MCP_URL).origin || !['/mcp', '/mcp/'].includes(target.pathname) || target.username || target.password || target.search || target.hash || target.href === this.endpoint) {
      fail('redirect_rejected', 'GraphIQ redirected to an unsupported endpoint. Ask GraphIQ to confirm the canonical MCP endpoint and API-key access.', 502, {
        stage,
        httpStatus: status
      });
    }
    this.endpoint = target.href;
    // Reuse the same body, id and abort signal; no new time budget for redirects.
    response = await this.fetch(this.endpoint, options);
    if (redirectStatuses.includes(response.status)) {
      const status = response.status;
      await response.body?.cancel().catch(() => {});
      fail('redirect_rejected', 'GraphIQ returned repeated redirects. Ask GraphIQ to confirm its canonical MCP endpoint.', 502, {
        stage,
        httpStatus: status
      });
    }
    return response;
  }
  async send(method, params, notification = false) {
    this.lastMethod = method;
    if (Date.now() >= this.deadline) fail('network_error', 'GraphIQ MCP request exceeded its time budget.', 502, {
      stage: method,
      networkCode: 'TIMEOUT'
    });
    const id = randomUUID();
    let response;
    try {
      response = await this.post({
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(1, Math.min(this.timeout, this.deadline - Date.now()))),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'X-API-Key': this.apiKey,
          ...(this.session ? {
            'Mcp-Session-Id': this.session
          } : {}),
          ...(this.version ? {
            'MCP-Protocol-Version': this.version
          } : {})
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          ...(notification ? {} : {
            id
          }),
          method,
          ...(params ? {
            params
          } : {})
        })
      }, method);
    } catch (e) {
      if (e instanceof GraphIQMcpError) throw e;
      const networkCode = networkFailureCode(e);
      fail('network_error', `Unable to reach GraphIQ MCP (${networkCode}, ${method}). Check backend connectivity and provider access.`, 502, {
        stage: method,
        networkCode
      });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401) fail('authentication_failed', 'GraphIQ rejected the backend API key. Check its MCP access.', 503, {
        stage: method,
        httpStatus: 401
      });
      if (response.status === 403) fail('access_denied', 'GraphIQ denied access. Check MCP entitlement and whether GraphIQ blocks this backend network.', 503, {
        stage: method,
        httpStatus: 403
      });
      if (response.status === 429) fail('rate_limited', 'GraphIQ rate limit reached. Try again later.', 429, {
        stage: method,
        httpStatus: 429
      });
      fail('provider_unavailable', 'GraphIQ MCP is unavailable or its session expired. Run the connection check again.', 503, {
        stage: method,
        httpStatus: response.status
      });
    }
    if (method === 'initialize') {
      const session = response.headers.get('mcp-session-id');
      if (session && (!/^[\x21-\x7e]+$/.test(session) || session.length > 2048)) fail('invalid_session', 'GraphIQ returned an invalid MCP session.');
      this.session = session;
    }
    if (notification) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    try {
      return await readMcpResponse(response, id);
    } catch (e) {
      if (e instanceof GraphIQMcpError) throw e;
      fail('network_error', 'GraphIQ MCP response timed out or was interrupted.', 502, {
        stage: method,
        networkCode: networkFailureCode(e)
      });
    }
  }
  async initialize() {
    const result = await this.send('initialize', {
      protocolVersion: VERSIONS[0],
      capabilities: {},
      clientInfo: {
        name: 'Atlas Revenue AI',
        version: '1.0.0'
      }
    });
    if (!VERSIONS.includes(result?.protocolVersion) || !result.capabilities?.tools) fail('unsupported_protocol', 'GraphIQ did not negotiate a supported MCP tool protocol.');
    this.version = result.protocolVersion;
    await this.send('notifications/initialized', null, true);
  }
  async tools() {
    const tools = [];
    let cursor;
    const seen = new Set();
    for (let page = 0; page < 4; page++) {
      const result = await this.send('tools/list', cursor ? {
        cursor
      } : {});
      if (!Array.isArray(result?.tools) || tools.length + result.tools.length > 100) fail('invalid_tools', 'GraphIQ returned an unsupported tool inventory.');
      for (const t of result.tools) {
        if (typeof t.name !== 'string' || seen.has(t.name)) fail('invalid_tools', 'GraphIQ tool names were missing or duplicated.');
        seen.add(t.name);
        tools.push(t);
      }
      if (!result.nextCursor) return tools;
      if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 2048 || result.nextCursor === cursor) fail('invalid_tools', 'GraphIQ tool pagination did not advance.');
      cursor = result.nextCursor;
    }
    fail('invalid_tools', 'GraphIQ tool inventory exceeded the supported page limit.');
  }
  async call(name, args) {
    if (!['search_news', 'search_organizations'].includes(name)) fail('unsupported_tool', 'This MCP operation is not enabled in Atlas.', 400);
    const result = await this.send('tools/call', {
      name,
      arguments: args
    });
    if (!result || result.isError) fail('tool_error', 'GraphIQ could not run this search. Check the tool schema, query and account access.');
    return result;
  }
  async close() {
    if (!this.session) return;
    try {
      const r = await this.fetch(this.endpoint, {
        method: 'DELETE',
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
        headers: {
          'X-API-Key': this.apiKey,
          'Mcp-Session-Id': this.session,
          ...(this.version ? {
            'MCP-Protocol-Version': this.version
          } : {})
        }
      });
      await r.body?.cancel().catch(() => {});
    } catch {}
    this.session = null;
  }
}
// Recognize the provider's nullable string field without accepting arbitrary composition.
function textRule(rule) {
  if (!rule || rule.$ref || rule.oneOf || rule.allOf) return null;
  if (rule.type === 'string' && !rule.anyOf) return rule;
  if (Array.isArray(rule.anyOf)) return rule.anyOf.find(branch => branch?.type === 'string' && !branch.$ref && !branch.anyOf && !branch.oneOf && !branch.allOf) || null;
  return null;
}
function bindText(rule, query) {
  const branch = textRule(rule);
  if (!branch || [rule, branch].some(r => r.enum || r.const !== undefined || r.pattern || query.length < (r.minLength || 0) || query.length > (r.maxLength ?? 10000))) fail('unsupported_schema', 'The query is incompatible with the discovered GraphIQ search schema.', 422);
  return query;
}
function boundedOption(properties, args, key, value) {
  const rule = properties[key];
  if (!rule) return;
  if (rule.$ref || rule.anyOf || rule.oneOf || rule.allOf || rule.const !== undefined) fail('unsupported_schema', 'GraphIQ search options need an adapter update.', 422);
  if (typeof value === 'number') {
    if (rule.type !== 'integer' || value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity) || rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum || rule.exclusiveMaximum !== undefined && value >= rule.exclusiveMaximum || rule.multipleOf !== undefined && value % rule.multipleOf !== 0 || rule.enum && !rule.enum.includes(value)) fail('unsupported_schema', 'GraphIQ search limits are incompatible with this view.', 422);
  } else {
    if (rule.type !== 'string' || !Array.isArray(rule.enum) || !rule.enum.includes(value)) return;
    if (rule.pattern || value.length < (rule.minLength || 0) || value.length > (rule.maxLength ?? 10000)) fail('unsupported_schema', 'GraphIQ search options are incompatible with this view.', 422);
  }
  args[key] = value;
}
// Bind only schema-declared text search shapes. Unknown required fields fail closed.
export function searchArguments(tool, query) {
  if (!tool || !['search_news', 'search_organizations'].includes(tool.name) || tool.annotations?.readOnlyHint === false) fail('unsupported_tool', 'The requested read-only GraphIQ search tool is unavailable.', 422);
  const schema = tool.inputSchema;
  if (schema?.type !== 'object' || !schema.properties || schema.anyOf || schema.oneOf || schema.allOf || schema.$ref) fail('unsupported_schema', 'GraphIQ search input needs an adapter update. Check connection details for the discovered schema.', 422);
  const properties = schema.properties,
    args = {};
  const field = ['query', 'q', 'search', 'search_query'].find(key => properties[key]?.type === 'string');
  if (properties.criteria) {
    const criteria = properties.criteria;
    if (criteria.type !== 'object' || !criteria.properties || criteria.$ref || criteria.anyOf || criteria.oneOf || criteria.allOf) fail('unsupported_schema', 'GraphIQ criteria need an adapter update.', 422);
    const key = tool.name === 'search_news' ? 'text' : 'name';
    if ((criteria.required || []).some(required => required !== key)) fail('unsupported_schema', 'GraphIQ criteria require additional fields not supported by this view.', 422);
    args.criteria = {
      [key]: bindText(criteria.properties[key], query)
    };
    boundedOption(properties, args, 'limit', 20);
    boundedOption(properties, args, 'offset', 0);
    boundedOption(properties, args, 'sort_by', tool.name === 'search_news' ? 'date' : 'relevance');
    if (tool.name === 'search_news') boundedOption(properties, args, 'cluster', 'dedupe');
  } else if (field) {
    const rule = properties[field];
    if (rule.enum || rule.pattern || query.length < (rule.minLength || 0) || query.length > (rule.maxLength || 10000)) fail('unsupported_schema', 'The query is incompatible with the discovered GraphIQ search schema.', 422);
    args[field] = query;
  } else if (tool.name === 'search_organizations' && properties.organization?.type === 'object' && properties.organization.properties?.capabilities?.type === 'array' && properties.organization.properties.capabilities.items?.type === 'string') {
    const nested = properties.organization;
    if ((nested.required || []).some(k => k !== 'capabilities')) fail('unsupported_schema', 'GraphIQ organization search requires additional fields.', 422);
    args.organization = {
      capabilities: [query]
    };
  } else fail('unsupported_schema', 'GraphIQ search input needs an adapter update. No supported text-query field was discovered.', 422);
  if ((schema.required || []).some(key => !(key in args))) fail('unsupported_schema', 'GraphIQ search requires additional fields not supported by this view.', 422);
  return args;
}
export function searchToolStatus(tool) {
  try {
    searchArguments(tool, 'Atlas company research');
    return {
      available: true
    };
  } catch (e) {
    return {
      available: false,
      code: e.code,
      message: e.message
    };
  }
}
export async function withGraphIQMcp(fn, options) {
  const client = new GraphIQMcpClient(options);
  try {
    await client.initialize();
    const tools = await client.tools();
    return await fn(client, tools);
  } catch (e) {
    if (e instanceof GraphIQMcpError) e.diagnostic = {
      stage: client.lastMethod,
      ...e.diagnostic
    };
    throw e;
  } finally {
    await client.close();
  }
}
