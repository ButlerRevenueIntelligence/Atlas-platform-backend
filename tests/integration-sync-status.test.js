import test from "node:test";
import assert from "node:assert/strict";
import IntegrationConnection from "../models/IntegrationConnection.js";
import { markSyncSuccess } from "../jobs/integrationAutoSync.js";

test("successful scheduled sync clears stale failure fields from a separate provider document", async t => {
  const stored = {
    status: "error", lastSyncStatus: "success",
    lastError: "INTEGRATION_TOKEN_ENCRYPTION_KEY is not configured",
    metadata: { importedAccounts: 12 }, accessToken: "encrypted-token",
  };
  const snapshot = {
    _id: "connection-a", orgId: "workspace-a", provider: "salesforce",
    status: "connected", lastSyncStatus: "running", lastError: null,
    save() { throw new Error("A stale document save cannot clear unchanged fields"); },
  };
  t.mock.method(IntegrationConnection, "updateOne", async (filter, update) => {
    assert.deepEqual(filter, { _id: "connection-a", orgId: "workspace-a", provider: "salesforce" });
    Object.assign(stored, update.$set);
    return { matchedCount: 1, modifiedCount: 1 };
  });
  await markSyncSuccess(snapshot);
  assert.equal(stored.status, "connected");
  assert.equal(stored.lastSyncStatus, "success");
  assert.equal(stored.lastError, null);
  assert.ok(stored.lastSyncAt instanceof Date);
  assert.deepEqual(stored.metadata, { importedAccounts: 12 });
  assert.equal(stored.accessToken, "encrypted-token");
});

test("failed status persistence rejects rather than reporting recovery", async t => {
  t.mock.method(IntegrationConnection, "updateOne", async () => {
    throw new Error("Database unavailable");
  });
  await assert.rejects(markSyncSuccess({ _id: "connection-a", orgId: "workspace-a", provider: "salesforce" }), /Database unavailable/);
});
