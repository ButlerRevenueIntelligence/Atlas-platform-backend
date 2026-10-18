import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphIQMcpClient } from '../services/graphiqMcp.js';
import { networkFailureCode, graphIQDiagnostic, logGraphIQEvent } from '../services/graphiqDiagnostics.js';
const failure = code => Object.assign(new Error('secret token and customer query'), {
  cause: {
    code,
    message: 'secret upstream detail'
  }
});
test('network diagnostics allow known causes and exclude arbitrary error contents', () => {
  assert.equal(networkFailureCode(failure('ENOTFOUND')), 'ENOTFOUND');
  assert.equal(networkFailureCode(failure('UND_ERR_CONNECT_TIMEOUT')), 'UND_ERR_CONNECT_TIMEOUT');
  assert.equal(networkFailureCode({
    name: 'TimeoutError'
  }), 'TIMEOUT');
  assert.equal(networkFailureCode(failure('secret-key')), 'UNKNOWN');
  assert.deepEqual(graphIQDiagnostic({
    code: 'secret',
    diagnostic: {
      stage: 'secret',
      networkCode: 'secret',
      httpStatus: 'secret'
    }
  }), {
    code: 'internal_error'
  });
});
test('MCP fetch failure reports safe network cause and failing method without raw messages', async () => {
  const client = new GraphIQMcpClient({
    apiKey: 'secret-key',
    fetchImpl: async () => {
      throw failure('ENOTFOUND');
    }
  });
  await assert.rejects(() => client.initialize(), e => {
    assert.equal(e.code, 'network_error');
    assert.deepEqual(graphIQDiagnostic(e), {
      code: 'network_error',
      stage: 'initialize',
      networkCode: 'ENOTFOUND'
    });
    assert.ok(e.message.includes('ENOTFOUND'));
    assert.equal(JSON.stringify(e).includes('secret'), false);
    return true;
  });
});
test('HTTP failures retain safe status and stage without response body', async () => {
  const client = new GraphIQMcpClient({
    apiKey: 'secret-key',
    fetchImpl: async () => new Response('secret upstream detail', {
      status: 403
    })
  });
  await assert.rejects(() => client.initialize(), e => {
    assert.deepEqual(graphIQDiagnostic(e), {
      code: 'access_denied',
      stage: 'initialize',
      httpStatus: 403
    });
    assert.equal(JSON.stringify(e).includes('secret'), false);
    return true;
  });
});
test('structured Render logs omit queries, credentials, messages and foreign diagnostic fields', t => {
  let line;
  t.mock.method(console, 'info', (...values) => {
    line = values.join(' ');
  });
  logGraphIQEvent('monitor_query_failed', {
    orgId: '507f1f77bcf86cd799439011',
    code: 'network_error',
    networkCode: 'ECONNRESET',
    stage: 'initialize',
    query: 'secret',
    apiKey: 'secret',
    message: 'secret',
    state: 'error'
  });
  assert.ok(line.startsWith('[GraphIQ]'));
  assert.ok(line.includes('ECONNRESET'));
  assert.equal(line.includes('secret'), false);
});
