import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateKnowledgeBase } from "../scripts/validate-knowledge.mjs";

const fixtureUrl = new URL("../knowledge/maestro.draft.json", import.meta.url);

async function fixture() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

test("current owner-supplied catalog is structurally valid", async () => {
  const result = validateKnowledgeBase(await fixture());
  assert.deepEqual(result.errors, []);
  assert.ok(result.blockers.some((item) => item.includes("promotion duration")));
  assert.ok(!result.blockers.some((item) => item.includes("opening hours")));
  assert.ok(!result.blockers.some((item) => item.includes("no confirmed services")));
});

test("duplicate service ids are rejected", async () => {
  const data = await fixture();
  data.services.push({ ...data.services[0] });
  const result = validateKnowledgeBase(data);
  assert.ok(result.errors.some((item) => item.includes("duplicated")));
});

test("approved status cannot hide unresolved operational gaps", async () => {
  const data = await fixture();
  data.status = "approved";
  data.unresolved = [];
  const result = validateKnowledgeBase(data);
  assert.ok(result.blockers.some((item) => item.includes("promotion duration")));
  assert.ok(result.blockers.some((item) => item.includes("Uzbek")));
});
