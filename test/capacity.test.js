import assert from "node:assert/strict";
import { test } from "node:test";
import { CapacityExceededError, CapacityGate } from "../src/capacity.js";

test("borne le travail actif et la file d'attente", async () => {
  const gate = new CapacityGate({ maxActive: 1, maxQueued: 1, waitTimeoutMs: 1000 });
  const firstRelease = await gate.acquire();
  const second = gate.acquire();
  await assert.rejects(gate.acquire(), CapacityExceededError);
  assert.deepEqual(gate.stats(), { active: 1, queued: 1, maxActive: 1, maxQueued: 1 });
  firstRelease();
  const secondRelease = await second;
  assert.equal(gate.stats().active, 1);
  secondRelease();
  assert.equal(gate.stats().active, 0);
});
