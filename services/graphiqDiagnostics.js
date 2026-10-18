const CODES = new Set(['redirect_rejected', 'not_configured', 'missing_graphiq_key', 'network_error', 'authentication_failed', 'access_denied', 'rate_limited', 'provider_unavailable', 'provider_error', 'tool_error', 'unsupported_schema', 'unsupported_tool', 'unsupported_protocol', 'invalid_response', 'missing_response', 'response_too_large', 'invalid_session', 'invalid_tools']);
const NETWORK = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'TIMEOUT']);
const STAGES = new Set(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
export function networkFailureCode(error) {
  if (['TimeoutError', 'AbortError'].includes(error?.name)) return 'TIMEOUT';
  const candidates = [error?.code, error?.cause?.code, ...(Array.isArray(error?.cause?.errors) ? error.cause.errors.map(e => e?.code) : [])];
  return candidates.find(c => NETWORK.has(c)) || 'UNKNOWN';
}
export function graphIQDiagnostic(error) {
  const d = error?.diagnostic || {};
  return {
    code: CODES.has(error?.code) ? error.code : 'internal_error',
    ...(STAGES.has(d.stage) ? {
      stage: d.stage
    } : {}),
    ...(NETWORK.has(d.networkCode) || d.networkCode === 'UNKNOWN' ? {
      networkCode: d.networkCode
    } : {}),
    ...(Number.isInteger(d.httpStatus) && d.httpStatus >= 100 && d.httpStatus <= 599 ? {
      httpStatus: d.httpStatus
    } : {})
  };
}
export function logGraphIQEvent(event, details = {}) {
  const value = {
    event
  };
  if (/^[a-f0-9]{24}$/i.test(String(details.orgId || ''))) value.orgId = String(details.orgId);
  for (const key of ['code', 'stage', 'networkCode', 'httpStatus']) if (details[key] !== undefined) {
    const safe = graphIQDiagnostic({
      code: details.code,
      diagnostic: details
    });
    if (safe[key] !== undefined) value[key] = safe[key];
  }
  for (const key of ['claimed', 'completed', 'results']) if (Number.isInteger(details[key]) && details[key] >= 0) value[key] = details[key];
  if (['success', 'error', 'paused', 'superseded'].includes(details.state)) value.state = details.state;
  console.info('[GraphIQ]', JSON.stringify(value));
}
