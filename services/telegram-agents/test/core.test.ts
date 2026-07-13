import assert from "node:assert/strict";
import test from "node:test";
import { formatBusinessSummary, normalizeUserRequest } from "../src/commands.ts";
import { buildInstagramProductionBrief } from "../src/instagram.ts";
import { secureEqual, splitText } from "../src/telegram.ts";

test("secureEqual compares secrets without accepting prefixes", () => {
  assert.equal(secureEqual("correct-secret", "correct-secret"), true);
  assert.equal(secureEqual("correct", "correct-secret"), false);
  assert.equal(secureEqual("wrong-secret", "correct-secret"), false);
});

test("splitText preserves all message content", () => {
  const source = `${"a".repeat(80)}\n${"b".repeat(80)}`;
  const chunks = splitText(source, 100);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.join("\n"), source);
});

test("business summary formats verified metrics", () => {
  const result = formatBusinessSummary({
    report: "business_summary",
    period: { from: "2026-07-01", to: "2026-07-07", days: 7 },
    previousPeriod: { from: "2026-06-24", to: "2026-06-30", days: 7 },
    current: {
      revenue: 1_500_000, clients: 10, newClients: 4, returningClients: 6,
      unknownClientType: 0, transactions: 8, averagePerClient: 150_000,
      averagePerTransaction: 187_500, cash: 500_000, card: 700_000, qr: 300_000
    },
    previous: {
      revenue: 1_000_000, clients: 8, newClients: 3, returningClients: 5,
      unknownClientType: 0, transactions: 7, averagePerClient: 125_000,
      averagePerTransaction: 142_857, cash: 400_000, card: 400_000, qr: 200_000
    },
    changePercent: { revenue: 50, clients: 25, averagePerClient: 20 },
    caveats: []
  });
  assert.match(result, /1\s500\s000 сум \(\+50\.0%\)/);
  assert.match(result, /Клиенты: 10 \(\+25\.0%\)/);
});

test("reel command asks for a production-ready Higgsfield package", () => {
  const request = normalizeUserRequest("/reel преображение клиента до и после");
  assert.match(request, /преображение клиента/);
  assert.match(request, /Higgsfield/);
  assert.match(request, /не считать запущенной/);
});

test("Instagram brief requires owner approval before spending credits", () => {
  const brief = buildInstagramProductionBrief({
    contentType: "reel",
    goal: "clients",
    topic: "до и после",
    offer: "без акции",
    audience: "мужчины рядом с Maestro",
    days: 7
  });
  assert.equal(brief.status, "draft_waiting_for_owner_approval");
  assert.equal(brief.productionRules.aspectRatio, "9:16");
  assert.equal(brief.approval.required, true);
});
