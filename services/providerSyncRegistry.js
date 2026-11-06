const handlers = new Map();
const running = new Set();

export function registerProviderSync(provider, handler) {
  handlers.set(provider, handler);
}

// Existing import handlers are shared by manual requests and scheduled jobs.
// No network request to Atlas itself or synthetic user session is needed.
export async function runRegisteredSync(provider, orgId) {
  const handler = handlers.get(provider);
  if (!handler) throw new Error(`No sync implementation for ${provider}`);
  const key = `${orgId}:${provider}`;
  if (running.has(key)) throw Object.assign(new Error("Sync already running"), {code: "SYNC_IN_PROGRESS", status: 409});
  running.add(key);
  try {
    let result;
    let statusCode = 200;
    const response = {
      status(code) { statusCode = code; return this; },
      json(body) { result = body; return body; },
    };
    await handler({ orgId, headers: { "x-org-id": String(orgId) }, query: {}, body: {} }, response);
    if (statusCode >= 400 || result?.ok !== true) {
      const error = new Error(result?.error || result?.message || `${provider} sync did not complete`);
      error.status = statusCode >= 400 ? statusCode : 500;
      if (result?.code) error.code = result.code;
      if (result?.reconnectRequired) error.reconnectRequired = true;
      throw error;
    }
    return result;
  } finally {
    running.delete(key);
  }
}
