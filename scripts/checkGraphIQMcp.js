import 'dotenv/config';
import { withGraphIQMcp, searchToolStatus } from '../services/graphiqMcp.js';
try {
  const result = await withGraphIQMcp(async (client, tools) => ({
    protocolVersion: client.version,
    toolCount: tools.length,
    tools: tools.map(t => ({
      name: t.name,
      ...(['search_news', 'search_organizations'].includes(t.name) ? {
        ...searchToolStatus(t),
        inputSchema: t.inputSchema
      } : {
        enabledInAtlas: false
      })
    }))
  }));
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(JSON.stringify({
    code: e.code || 'check_failed',
    message: e.code ? e.message : 'GraphIQ MCP check failed'
  }, null, 2));
  process.exitCode = 1;
}
