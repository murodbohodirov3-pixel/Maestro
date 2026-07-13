import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const knowledgeUrl = new URL("../knowledge/maestro.approved.json", import.meta.url);
const casesUrl = new URL("../knowledge/faq-cases.json", import.meta.url);

test("FAQ set covers at least 20 bilingual owner-approved scenarios", async () => {
  const knowledge = JSON.parse(await readFile(knowledgeUrl, "utf8"));
  const cases = JSON.parse(await readFile(casesUrl, "utf8"));
  const ids = new Set(cases.map((item) => item.id));
  const languages = new Set(cases.map((item) => item.language));

  assert.ok(cases.length >= 20);
  assert.equal(ids.size, cases.length);
  assert.deepEqual(languages, new Set(["ru", "uz"]));

  const services = new Map(knowledge.services.map((service) => [service.id, service]));
  const promotions = new Map(knowledge.promotions.map((promotion) => [promotion.id, promotion]));
  for (const item of cases) {
    assert.ok(["answer", "handoff"].includes(item.expected.action));
    if (item.expected.serviceId) {
      const service = services.get(item.expected.serviceId);
      assert.ok(service, `${item.id} references an unknown service`);
      assert.equal(item.expected.priceUzs, service.priceUzs);
      assert.equal(item.expected.durationMinutes, service.durationMinutes);
    }
    if (item.expected.promotionId) {
      const promotion = promotions.get(item.expected.promotionId);
      assert.ok(promotion, `${item.id} references an unknown promotion`);
      assert.equal(item.expected.priceUzs, promotion.priceUzs);
      assert.equal(item.expected.durationMinutes, promotion.durationMinutes);
    }
  }
});
