import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Acceptance from "../models/DataAccessAcceptance.js";
import Attempt from "../models/DataAccessOAuthAttempt.js";
import Membership from "../models/Membership.js";
import User from "../models/User.js";
import router from "../routes/dataAccess.js";
import {
  policySnapshot,
  dataAccessMode,
} from "../services/dataAccessPolicy.js";
import {
  requireDataAccess,
  requireAIDataAccess,
  signedState,
  verifiedState,
  validateOAuthReview,
  prepareOAuthReview,
} from "../services/dataAccess.js";
import {
  integrationDataAccess,
  spreadsheetDataAccess,
} from "../middleware/dataAccess.js";
import {
  registerProviderSync,
  runRegisteredSync,
} from "../services/providerSyncRegistry.js";
function env(t, key, value) {
  const old = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  });
}
const orgId = "507f1f77bcf86cd799439011",
  userId = "507f1f77bcf86cd799439012",
  id = "507f1f77bcf86cd799439013";
const query = (v) => ({
  sort() {
    return this;
  },
  select() {
    return this;
  },
  limit() {
    return this;
  },
  lean: async () => v,
});
const response = () => ({
  code: 200,
  status(c) {
    this.code = c;
    return this;
  },
  json(b) {
    this.body = b;
    return this;
  },
});
const req = () => ({
  user: { orgId, userId, email: "admin@example.test" },
  orgId,
  body: {},
  params: { provider: "hubspot" },
  headers: {},
  query: {},
});
const invoke = async (p, method, r) => {
  const res = response();
  await router.stack
    .find((l) => l.route?.path === p && l.route.methods[method])
    .route.stack.at(-1)
    .handle(r, res);
  return res;
};
function fixture(t) {
  env(t, "DATA_ACCESS_MODE", "enforce");
  env(t, "OAUTH_STATE_SECRET", "test-only-data-access-secret");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-data-access-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const policy = JSON.parse(
    fs.readFileSync(
      new URL("../config/dataAccessPolicy.json", import.meta.url),
    ),
  );
  policy.approved = true;
  policy.legalEntity = "Example Test Entity";
  policy.reviewedAt = "2026-11-10T00:00:00Z";
  policy.version = "test-1";
  for (const key of Object.keys(policy.common))
    policy.common[key] = `Verified test disclosure for ${key}.`;
  for (const doc of Object.values(policy.documents))
    doc.text = `Test final document: ${doc.title}`;
  for (const provider of ["hubspot", "excel_csv", "slack"])
    policy.connectors[provider] = {
      approved: true,
      version: "test-1",
      imports: "Explicit reviewed imported fields.",
      access: "Explicit reviewed permissions.",
    };
  const file = path.join(dir, "policy.json");
  fs.writeFileSync(file, JSON.stringify(policy));
  env(t, "DATA_ACCESS_POLICY_FILE", file);
  return {
    policy,
    write() {
      fs.writeFileSync(file, JSON.stringify(policy));
    },
    p: () => policySnapshot("hubspot"),
  };
}
test("default mode is off; invalid mode cannot silently bypass a gate", (t) => {
  env(t, "DATA_ACCESS_MODE", "off");
  assert.equal(dataAccessMode(), "off");
  env(t, "DATA_ACCESS_MODE", "typo");
  assert.throws(() => dataAccessMode());
});
test("draft and placeholder policies cannot be accepted as published", (t) => {
  const f = fixture(t);
  assert.equal(f.p().ready, true);
  f.policy.approved = false;
  f.write();
  assert.equal(f.p().ready, false);
  f.policy.approved = true;
  f.policy.common.aiProcessing = "[provider]";
  f.write();
  assert.equal(f.p().ready, false);
});
test("editing disclosure text invalidates the content digest even without a version bump", (t) => {
  const f = fixture(t),
    a = f.p();
  f.policy.common.aiProcessing += " Changed.";
  f.write();
  assert.notEqual(f.p().digest, a.digest);
});
test("unpublished connector fails closed before querying acceptance", async (t) => {
  fixture(t);
  t.mock.method(Acceptance, "findOne", () =>
    assert.fail("No database lookup expected"),
  );
  await assert.rejects(
    requireDataAccess(orgId, "salesforce"),
    (e) => e.code === "DATA_ACCESS_NOT_PUBLISHED",
  );
});
test("acceptance lookup binds workspace, provider, digest and initiating user", async (t) => {
  const f = fixture(t);
  t.mock.method(Acceptance, "findOne", (filter) => {
    assert.deepEqual(filter, {
      orgId,
      provider: "hubspot",
      digest: f.p().digest,
      userId,
    });
    return query({ _id: id });
  });
  assert.equal((await requireDataAccess(orgId, "hubspot", { userId }))._id, id);
});
test("raw sync and spreadsheet requests cannot bypass acceptance", async (t) => {
  fixture(t);
  t.mock.method(Acceptance, "findOne", () => query(null));
  let called = false;
  registerProviderSync("hubspot", () => {
    called = true;
  });
  await assert.rejects(
    runRegisteredSync("hubspot", orgId),
    (e) => e.code === "DATA_ACCESS_REQUIRED",
  );
  assert.equal(called, false);
  const r = response();
  await spreadsheetDataAccess(req(), r, () => assert.fail("Must block"));
  assert.equal(r.code, 428);
});
test("member role and admin override do not substitute for active customer admin membership", async (t) => {
  fixture(t);
  t.mock.method(Membership, "findOne", (filter) => {
    assert.deepEqual(filter.role, { $in: ["owner", "admin"] });
    assert.equal(filter.status, "active");
    return query(null);
  });
  const r = req(),
    res = response();
  r.path = "/hubspot/auth-url";
  r.method = "GET";
  await integrationDataAccess(r, res, () => assert.fail("Must block"));
  assert.equal(res.code, 403);
});
test("acceptance requires strict true acknowledgments and current digest", async (t) => {
  const f = fixture(t);
  t.mock.method(Membership, "findOne", () => query({ role: "owner" }));
  t.mock.method(Acceptance, "findOne", () => query(null));
  t.mock.method(Acceptance, "create", () => assert.fail("No receipt expected"));
  const r = req();
  r.body = { digest: "old", acknowledgments: {} };
  assert.equal((await invoke("/:provider/accept", "post", r)).code, 409);
  r.body = {
    digest: f.p().digest,
    acknowledgments: { authority: "true", processing: true, agreement: true },
  };
  assert.equal((await invoke("/:provider/accept", "post", r)).code, 400);
});
test("accepted receipt stores server-owned text, identity, checkbox labels and digest", async (t) => {
  const f = fixture(t);
  t.mock.method(Membership, "findOne", () => query({ role: "admin" }));
  t.mock.method(Acceptance, "findOne", () => query(null));
  t.mock.method(Acceptance, "create", async (value) => {
    assert.equal(value.orgId, orgId);
    assert.equal(value.userId, userId);
    assert.deepEqual(value.snapshot, f.p().snapshot);
    assert.equal(value.email, "admin@example.test");
    assert.equal(value.acknowledgments.agreement, true);
    return { _id: id, ...value };
  });
  const r = req();
  r.body = {
    orgId: "attacker",
    snapshot: {},
    digest: f.p().digest,
    acknowledgments: { authority: true, processing: true, agreement: true },
  };
  assert.equal((await invoke("/:provider/accept", "post", r)).code, 201);
});
test("receipt download is scoped to authenticated workspace", async (t) => {
  fixture(t);
  t.mock.method(Acceptance, "findOne", (filter) => {
    assert.deepEqual(filter, { _id: id, orgId });
    return query(null);
  });
  const r = req();
  r.params = { id };
  assert.equal((await invoke("/receipts/:id", "get", r)).code, 404);
});
test("OAuth signatures reject tampering, wrong provider, expiration and excessive duration", (t) => {
  fixture(t);
  const p = {
    orgId,
    provider: "hubspot",
    iat: Date.now(),
    exp: Date.now() + 60000,
  };
  const token = signedState(p);
  assert.equal(verifiedState(token, "hubspot").orgId, orgId);
  assert.throws(() => verifiedState(token + "x", "hubspot"));
  assert.throws(() => verifiedState(token, "stripe"));
  assert.throws(() => verifiedState(token, "hubspot", p.exp + 1));
  assert.throws(() =>
    verifiedState(signedState({ ...p, exp: p.iat + 600001 }), "hubspot"),
  );
});
test("OAuth auth-url binds a one-time attempt to the accepting user and preserves PKCE", async (t) => {
  const f = fixture(t);
  t.mock.method(Acceptance, "findOne", () =>
    query({ _id: id, digest: f.p().digest }),
  );
  t.mock.method(Attempt, "create", async (value) => {
    assert.equal(value.orgId, orgId);
    assert.equal(value.userId, userId);
    assert.equal(value.acceptanceId, id);
    return { _id: id, ...value };
  });
  const r = req();
  r.res = response();
  await prepareOAuthReview(r, "hubspot");
  const state = signedState({
    orgId,
    provider: "hubspot",
    codeVerifier: "private-pkce",
    iat: Date.now(),
    exp: Date.now() + 60000,
  });
  r.res.json({
    authUrl: `https://example.test/authorize?state=${encodeURIComponent(state)}`,
  });
  const p = verifiedState(
    new URL(r.res.body.authUrl).searchParams.get("state"),
    "hubspot",
  );
  assert.equal(p.dataAccessAttempt, id);
  assert.equal(p.dataAccessUser, userId);
  assert.equal(p.codeVerifier, "private-pkce");
});
test("OAuth callback atomically consumes matching attempt and rejects replay", async (t) => {
  const f = fixture(t);
  t.mock.method(Acceptance, "findOne", () =>
    query({ _id: id, digest: f.p().digest }),
  );
  t.mock.method(Membership, "findOne", () => query({ role: "owner" }));
  t.mock.method(User, "findById", () =>
    query({ _id: userId, status: "active" }),
  );
  let consumed = false;
  t.mock.method(Attempt, "findOneAndUpdate", (filter) => {
    assert.equal(filter.orgId, orgId);
    assert.equal(filter.userId, userId);
    assert.equal(filter.acceptanceId, id);
    assert.equal(filter.consumedAt, null);
    const value = consumed ? null : { _id: id };
    consumed = true;
    return query(value);
  });
  const r = req();
  r.path = "/hubspot/callback";
  r.query.state = signedState({
    orgId,
    provider: "hubspot",
    dataAccessAttempt: id,
    dataAccessUser: userId,
    iat: Date.now(),
    exp: Date.now() + 60000,
  });
  let next = 0;
  await validateOAuthReview(r, response(), () => next++);
  assert.equal(next, 1);
  const res = response();
  await validateOAuthReview(r, res, () => assert.fail("No replay"));
  assert.equal(res.code, 400);
});
test("OAuth callback rejects removed customer administrator before contacting provider", async (t) => {
  const f = fixture(t);
  t.mock.method(Acceptance, "findOne", () =>
    query({ _id: id, digest: f.p().digest }),
  );
  t.mock.method(Membership, "findOne", () => query(null));
  t.mock.method(User, "findById", () =>
    query({ _id: userId, status: "active" }),
  );
  t.mock.method(Attempt, "findOneAndUpdate", () =>
    assert.fail("No attempt consumed"),
  );
  const r = req();
  r.path = "/hubspot/callback";
  r.query.state = signedState({
    orgId,
    provider: "hubspot",
    dataAccessAttempt: id,
    dataAccessUser: userId,
    iat: Date.now(),
    exp: Date.now() + 60000,
  });
  const res = response();
  await validateOAuthReview(r, res, () => assert.fail("Must block"));
  assert.equal(res.code, 403);
});
test("AI processing requires a currently published exact disclosure", async (t) => {
  const f = fixture(t),
    digest = f.p().digest;
  t.mock.method(Acceptance, "find", () =>
    query([{ provider: "hubspot", digest }]),
  );
  await requireAIDataAccess(orgId);
  f.policy.common.aiProcessing += " New purpose.";
  f.write();
  await assert.rejects(
    requireAIDataAccess(orgId),
    (e) => e.code === "DATA_ACCESS_REQUIRED",
  );
});

test('an error parameter cannot bypass review when a callback also supplies a code', async t => {
  fixture(t);
  const r = req(), res = response();
  r.path = '/hubspot/callback'; r.query = {error:'access_denied',code:'unexpected-code'};
  await validateOAuthReview(r,res,()=>assert.fail('Callback with a code must validate state'));
  assert.equal(res.code,400);
});

test('a previously signed common agreement needs source acknowledgment without a duplicate signature', async t => {
  const f=fixture(t);
  t.mock.method(Membership,'findOne',()=>query({role:'owner'}));
  t.mock.method(Acceptance,'findOne',()=>query({_id:id}));
  t.mock.method(Acceptance,'create',async value=>{
    assert.equal(value.acknowledgments.agreement,false);
    assert.equal(value.acknowledgments.priorAgreementReceiptId,id);
    return {_id:id,...value};
  });
  const r=req(); r.body={digest:f.p().digest,acknowledgments:{authority:true,processing:true}};
  assert.equal((await invoke('/:provider/accept','post',r)).code,201);
});
