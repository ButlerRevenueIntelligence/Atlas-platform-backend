import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphIQMcpClient, GRAPHIQ_MCP_URL } from '../services/graphiqMcp.js';
const rpc = (id, result, headers = {}) => new Response(JSON.stringify({
  jsonrpc: '2.0',
  id,
  result
}), {
  headers: {
    'content-type': 'application/json',
    ...headers
  }
});
for (const status of [307, 308]) test(`canonical ${status} redirect preserves credentials, body, timeout and resolved session endpoint`, async () => {
  const seen = [];
  const client = new GraphIQMcpClient({
    apiKey: 'test-secret',
    fetchImpl: async (url, options) => {
      seen.push({
        url,
        options
      });
      assert.equal(options.headers['X-API-Key'], 'test-secret');
      if (seen.length === 1) {
        assert.equal(url, GRAPHIQ_MCP_URL);
        assert.equal(options.redirect, 'manual');
        return new Response(null, {
          status,
          headers: {
            location: '/mcp/'
          }
        });
      }
      assert.equal(url, GRAPHIQ_MCP_URL + '/');
      if (options.method === 'DELETE') {
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers['Mcp-Session-Id'], 'session');
        return new Response(null, {
          status: 204
        });
      }
      const request = JSON.parse(options.body);
      if (request.method === 'initialize') {
        assert.equal(options.body, seen[0].options.body);
        assert.equal(options.signal, seen[0].options.signal);
        return rpc(request.id, {
          protocolVersion: '2025-03-26',
          capabilities: {
            tools: {}
          }
        }, {
          'mcp-session-id': 'session'
        });
      }
      assert.equal(options.headers['Mcp-Session-Id'], 'session');
      if (request.method === 'notifications/initialized') return new Response(null, {
        status: 202
      });
      if (request.method === 'tools/list') return rpc(request.id, {
        tools: []
      });
      if (request.method === 'tools/call') return rpc(request.id, {
        structuredContent: {
          articles: []
        }
      });
      assert.fail(request.method);
    }
  });
  await client.initialize();
  await client.tools();
  await client.call('search_news', {
    query: 'Acme'
  });
  await client.close();
  assert.equal(seen.length, 6);
});
test('unsupported redirect destinations never receive the API key', async t => {
  for (const location of ['https://evil.example/mcp/', 'http://app.graphiq.ai/mcp/', 'https://app.graphiq.ai:444/mcp/', 'https://user:pass@app.graphiq.ai/mcp/', '/login', '/mcp/?key=secret', '/mcp/#fragment', '/mcp', '//evil.example/mcp/', '/mcp/%2e%2e/login', '']) await t.test(location || 'missing', async () => {
    let calls = 0;
    const c = new GraphIQMcpClient({
      apiKey: 'secret',
      fetchImpl: async () => {
        calls++;
        return new Response(null, {
          status: 307,
          headers: location ? {
            location
          } : {}
        });
      }
    });
    await assert.rejects(() => c.initialize(), e => e.code === 'redirect_rejected');
    assert.equal(calls, 1);
  });
});
test('method-changing redirects and redirect chains are rejected', async t => {
  for (const status of [301, 302, 303]) await t.test(String(status), async () => {
    let calls = 0;
    const c = new GraphIQMcpClient({
      apiKey: 'secret',
      fetchImpl: async () => {
        calls++;
        return new Response(null, {
          status,
          headers: {
            location: '/mcp/'
          }
        });
      }
    });
    await assert.rejects(() => c.initialize(), e => e.code === 'redirect_rejected');
    assert.equal(calls, 1);
  });
  let calls = 0;
  const c = new GraphIQMcpClient({
    apiKey: 'secret',
    fetchImpl: async () => {
      calls++;
      return new Response(null, {
        status: 307,
        headers: {
          location: calls === 1 ? '/mcp/' : '/mcp'
        }
      });
    }
  });
  await assert.rejects(() => c.initialize(), e => e.code === 'redirect_rejected');
  assert.equal(calls, 2);
});
test('access denial at canonical endpoint is preserved without further retries', async () => {
  let calls = 0;
  const c = new GraphIQMcpClient({
    apiKey: 'secret',
    fetchImpl: async () => {
      calls++;
      return calls === 1 ? new Response(null, {
        status: 307,
        headers: {
          location: '/mcp/'
        }
      }) : new Response('do not expose', {
        status: 403
      });
    }
  });
  await assert.rejects(() => c.initialize(), e => {
    assert.equal(e.code, 'access_denied');
    assert.equal(e.diagnostic.httpStatus, 403);
    assert.ok(!JSON.stringify(e).includes('do not expose'));
    return true;
  });
  assert.equal(calls, 2);
});
