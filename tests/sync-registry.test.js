import test from "node:test";
import assert from "node:assert/strict";
import { registerProviderSync, runRegisteredSync } from "../services/providerSyncRegistry.js";

test("scheduled imports use their own workspace and require confirmed success", async () => {
  registerProviderSync("test", async (req, res) => {
    assert.equal(req.headers["x-org-id"], "workspace-a");
    res.json({ ok: true, imported: 3 });
  });
  assert.equal((await runRegisteredSync("test", "workspace-a")).imported, 3);
  registerProviderSync("test-fail", async (_req, res) => res.status(401).json({ ok: false, message: "Expired token" }));
  await assert.rejects(runRegisteredSync("test-fail", "workspace-a"), error => error.status === 401);
  await assert.rejects(runRegisteredSync("not-implemented", "workspace-a"), /No sync implementation/);
});

test("manual and automatic sync cannot overlap for the same workspace and provider", async () => {
  let finish;
  registerProviderSync("slow", async (_req, res) => { await new Promise(resolve => { finish = resolve; }); res.json({ ok: true }); });
  const first = runRegisteredSync("slow", "workspace-a");
  await assert.rejects(runRegisteredSync("slow", "workspace-a"), /already running/);
  finish(); await first;
});
