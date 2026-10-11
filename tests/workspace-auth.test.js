import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import Organization from "../models/Organization.js";
import Membership from "../models/Membership.js";
import { integrationWorkspace } from "../middleware/integrationWorkspace.js";

const orgId = "507f1f77bcf86cd799439011";
const otherOrg = "507f1f77bcf86cd799439012";
const userId = "507f1f77bcf86cd799439013";

function setup(t, body = {}, membership = { role: "owner", status: "active" }) {
  process.env.JWT_SECRET = "test-only-secret";
  t.mock.method(User, "findById", () => ({ select: () => ({ lean: async () => ({ _id: userId, email: "user@example.test", orgId, status: "active" }) }) }));
  t.mock.method(Membership, "findOne", filter => {
    assert.equal(String(filter.orgId), orgId);
    return { lean: async () => membership };
  });
  t.mock.method(Organization, "findById", () => ({ select: async () => ({ _id: orgId, name: "Customer", plan: "GROWTH", billing: { status: "active" }, accessStatus: "active" }) }));
  const req = { body, query: {}, headers: { authorization: `Bearer ${jwt.sign({ userId, orgId }, process.env.JWT_SECRET)}` } };
  const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  return { req, res };
}

test("legacy provider entry points require authentication", async () => {
  const req = { headers: {}, query: {}, body: {} };
  const res = { code: 200, status(code) { this.code = code; return this; }, json() {} };
  await integrationWorkspace(req, res, () => assert.fail("Unauthenticated request reached importer"));
  assert.equal(res.code, 401);
});

test("body workspace cannot redirect a valid session into another tenant", async t => {
  const { req, res } = setup(t, { orgId: otherOrg });
  await integrationWorkspace(req, res, () => assert.fail("Cross-tenant request reached importer"));
  assert.equal(res.code, 403);
});

test("query workspace cannot redirect a valid session into another tenant", async t => {
  const { req, res } = setup(t); req.query.orgId = otherOrg;
  await integrationWorkspace(req, res, () => assert.fail("Cross-tenant request reached importer"));
  assert.equal(res.code, 403);
});

test("suspended memberships cannot sync", async t => {
  const { req, res } = setup(t, {}, { role: "owner", status: "suspended" });
  await integrationWorkspace(req, res, () => assert.fail("Suspended membership reached importer"));
  assert.equal(res.code, 403);
});

test("authorized workspace is canonicalized for all import handlers", async t => {
  const { req, res } = setup(t); let reached = false;
  await integrationWorkspace(req, res, () => { reached = true; });
  assert.equal(reached, true); assert.equal(res.code, 200);
  assert.equal(req.orgId, orgId); assert.equal(req.headers["x-org-id"], orgId);
});
