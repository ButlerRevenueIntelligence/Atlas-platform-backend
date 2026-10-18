# GraphIQ MCP in Atlas

## What is added

A server-side Streamable HTTP MCP client for the fixed endpoint `https://app.graphiq.ai/mcp`, authenticated with the existing backend `GRAPHIQ_API_KEY` (`X-API-Key`). The browser never receives a provider key or session ID. No client dependency or new credential is required.

The client performs initialize → initialized notification → tools/list → tools/call, supports JSON and bounded SSE responses, propagates negotiated protocol/session headers, and closes its per-operation session. It supports protocol versions 2025-03-26 and 2025-06-18. The inventory is discovered at runtime; Atlas does not assume that the key exposes all 17 announced tools. Only `search_organizations` and `search_news` may execute. People, arbitrary web fetches, mutations and other tools are not enabled by this change.

The shared Company Research & News panel is added to Market Signals, Account Intelligence and AI Operator. Searches are explicit user actions. The panel includes a deployed-backend connection check, latest workspace research, publication/retrieval timestamps, publisher/source URLs where supplied, and inspectable text when a provider result shape is not recognized. The first 20 normalized records are displayed, or at most 20,000 characters of unstructured response. Results expire after 24 hours and are never fabricated when a request fails.

MCP company results update the existing shared company-profile context contract. Existing REST profile searches remain unchanged and do not silently masquerade as MCP calls. The AI Operator can use explicitly selected news/company snapshots; the backend reloads them from the authenticated workspace and checks expiration. Caller-supplied article contents are not trusted. Selected valid news goes through the grounded LLM path rather than the internal-only deterministic briefing engines. Command Center's account-context tab shows the latest permitted live-workspace news search separately from company/account matches. Search results are not automatically associated with CRM accounts.

Automatic monitoring, scheduled alerts, Slack delivery, GraphIQ's future news subscriptions, and all-tool autonomous agents are outside this change.

## Deployment and live verification

1. Merge/deploy backend first, then frontend. The existing backend `GRAPHIQ_API_KEY` must have MCP access. Do not put the key in frontend variables or send it in chat.
2. From Market Signals, choose **Check connection**. This runs initialization and discovery from Render, not from the user's phone or ChatGPT runtime. The UI reports actual tool count and supported search availability.
3. Run one company search and one news search. Inspect source links, publication dates, empty/unstructured results, and the workspace-owned snapshot in the Operator. Verify workspace switching and browser/mobile interactions.
4. If GraphIQ returns `authentication_failed`, check API-key MCP entitlement. If it returns `access_denied`, ask GraphIQ to verify entitlement and whether their edge firewall blocks Render's outbound traffic. Do not repeatedly retry 403s or change signatures to bypass access controls.
5. If discovery works but a search reports `unsupported_schema`, run `node scripts/checkGraphIQMcp.js` in the backend environment. It prints tool names, supported-search checks and their discovered input schemas; never credentials. Review the schema and update the explicit adapter before claiming search support.

Live verification was blocked in this development environment: no local GraphIQ API key was available, and one unauthenticated initialization attempt received GraphIQ/Cloudflare HTTP 403 Error 1010. No retries or signature changes were attempted. GraphIQ's public documentation currently shows the older four-tool examples, while its newer index and supplied release email describe 17 tools. Runtime discovery is the authority for the deployed account. The actual deployed tool schemas and account entitlement still need verification.

## Schema and request boundaries

Atlas binds only schema-declared string fields named query/q/search/search_query, or an organization object explicitly declaring a string-array capabilities field. Unknown top-level required fields, composed root schemas and explicit non-read-only tool hints fail closed. Arguments, tool names, upstream URLs, provider headers and org IDs cannot be supplied through the search API. No speculative filter syntax is inserted. Provider validation errors are sanitized rather than returned verbatim.

Requests use the fixed HTTPS origin with redirects disabled so credentials cannot follow a redirect. Each operation has a 30-second budget, a 12-second per-request maximum and a 3-second best-effort session-close timeout. Responses are capped at 2 MiB, inventory at 100 tools/four pages, query length at 500 characters, and stored records at 20. The per-process workspace lock rejects concurrent upstream requests; it is not a distributed quota or cross-instance rate limiter. Provider 429s are surfaced without automatic retries. 401/403s never retry automatically.

Parent routes enforce authentication, canonical workspace and CORE billing. MCP routes additionally require an explicit active membership and an existing company/market/AI read permission. All reads/writes use the canonical org ID. No raw MCP sessions, secrets, upstream error bodies or card/contact payloads are persisted. GraphIQ's provider tool results are untrusted data, never instructions.

Collection `graphiq_research` stores bounded normalized company/news searches and unstructured text fallback with workspace/kind/time indexes and TTL expiry. No seed/migration command is required. Existing `company_intelligence` remains the shared profile contract. Historical data retention depends on database TTL processing; expired records are excluded in every read regardless of TTL timing.

## Validation

Tests mock the documented MCP transport boundaries and database queries: negotiation, JSON/SSE, split frames, account headers, key confidentiality, failures/cleanup, discovery limits, adapter rejection, provenance, membership/permissions and workspace/expiry isolation. They do not establish that GraphIQ accepts Atlas's deployed key or that its latest schema uses one of the supported bindings. A production frontend build and populated render checks cover the UI; deployed browser and real-provider checks are still required.

Primary references: [GraphIQ MCP authentication guide](https://graphiq.ai/resources/mcp-server/), [GraphIQ current capability index](https://graphiq.ai/llms.txt), [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports), [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle), [MCP tool discovery/calls](https://modelcontextprotocol.io/specification/2025-03-26/server/tools).
