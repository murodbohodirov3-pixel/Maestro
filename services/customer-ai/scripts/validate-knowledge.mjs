import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const CATEGORIES = new Set(["haircut", "beard", "combo", "coloring", "face_care", "massage"]);

export function validateKnowledgeBase(data) {
  const errors = [];
  const blockers = [];
  const add = (condition, message) => { if (!condition) errors.push(message); };

  add(data?.schemaVersion === 1, "schemaVersion must equal 1");
  add(["draft", "approved"].includes(data?.status), "status must be draft or approved");
  add(data?.business?.name === "Maestro Barberia", "business.name must be Maestro Barberia");
  add(data?.business?.timezone === "Asia/Tashkent", "business.timezone must be Asia/Tashkent");
  add(data?.business?.languages?.includes("ru") && data?.business?.languages?.includes("uz"), "languages must include ru and uz");
  add(/^\+998\d{9}$/.test(data?.business?.phone || ""), "phone must use +998XXXXXXXXX format");
  add(/^https:\/\/www\.instagram\.com\/[a-z0-9._]+\/$/i.test(data?.business?.instagram || ""), "instagram must be a canonical profile URL");

  for (const day of DAYS) {
    const hours = data?.business?.openingHours?.[day];
    add(validTime(hours?.opens), `${day}.opens must be HH:MM`);
    add(validTime(hours?.closes), `${day}.closes must be HH:MM`);
    if (validTime(hours?.opens) && validTime(hours?.closes)) {
      add(toMinutes(hours.opens) < toMinutes(hours.closes), `${day} closing time must be after opening time`);
    }
  }

  const serviceIds = new Set();
  for (const [index, service] of (data?.services || []).entries()) {
    const path = `services[${index}]`;
    add(typeof service.id === "string" && /^[a-z0-9_]+$/.test(service.id), `${path}.id is invalid`);
    add(!serviceIds.has(service.id), `${path}.id is duplicated`);
    serviceIds.add(service.id);
    add(CATEGORIES.has(service.category), `${path}.category is invalid`);
    add(Boolean(service.nameRu?.trim()), `${path}.nameRu is required`);
    add(Boolean(service.nameUz?.trim()), `${path}.nameUz is required`);
    add(Number.isInteger(service.priceUzs) && service.priceUzs > 0, `${path}.priceUzs must be a positive integer`);
    add(Number.isInteger(service.durationMinutes) && service.durationMinutes >= 5 && service.durationMinutes <= 360, `${path}.durationMinutes must be 5..360`);
  }
  add(serviceIds.size > 0, "at least one service is required");

  const masterIds = new Set();
  for (const [index, master] of (data?.masters || []).entries()) {
    const path = `masters[${index}]`;
    add(Number.isInteger(master.id) && master.id > 0, `${path}.id is invalid`);
    add(!masterIds.has(master.id), `${path}.id is duplicated`);
    masterIds.add(master.id);
    add(Boolean(master.nameRu?.trim()) && Boolean(master.nameUz?.trim()), `${path} requires RU and UZ names`);
    add(Array.isArray(master.serviceIds), `${path}.serviceIds must be an array`);
    for (const serviceId of master.serviceIds || []) {
      add(serviceIds.has(serviceId), `${path} references unknown service ${serviceId}`);
    }
  }

  for (const [index, promotion] of (data?.promotions || []).entries()) {
    const path = `promotions[${index}]`;
    add(Boolean(promotion.id && promotion.nameRu && promotion.nameUz), `${path} requires id and names`);
    add(Number.isInteger(promotion.priceUzs) && promotion.priceUzs > 0, `${path}.priceUzs must be a positive integer`);
    if (promotion.durationMinutes != null) {
      add(Number.isInteger(promotion.durationMinutes) && promotion.durationMinutes >= 5, `${path}.durationMinutes is invalid`);
    }
    if (promotion.active && promotion.durationMinutes == null) blockers.push(`${path}: active promotion duration is not confirmed`);
  }

  add(data?.policies?.lateArrival?.penalty === "none", "late-arrival penalty must be none");
  add(data?.policies?.cancellation?.penalty === "none", "cancellation penalty must be none");
  add(Array.isArray(data?.payments) && data.payments.length > 0, "at least one payment method is required");

  if (data?.business?.openingHours?.scope !== "confirmed_daily") {
    blockers.push("opening hours are not confirmed as daily");
  }
  for (const master of data?.masters || []) {
    if (master.active && master.serviceIds.length === 0) blockers.push(`master ${master.nameRu} has no confirmed services`);
  }
  if (data?.translationStatus !== "approved") blockers.push("Uzbek names and policy texts are not approved");
  for (const item of data?.unresolved || []) blockers.push(`unresolved: ${item}`);
  if (data?.status !== "approved") blockers.push("knowledge base status is not approved");

  return { errors: [...new Set(errors)], blockers: [...new Set(blockers)] };
}

function validTime(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function toMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: node validate-knowledge.mjs <knowledge.json>");
  const data = JSON.parse(await readFile(path, "utf8"));
  const result = validateKnowledgeBase(data);
  if (result.errors.length) {
    console.error("Knowledge base is structurally invalid:");
    result.errors.forEach((item) => console.error(`- ${item}`));
    process.exitCode = 1;
    return;
  }
  console.log("Knowledge base structure: valid");
  console.log(`Approval blockers: ${result.blockers.length}`);
  result.blockers.forEach((item) => console.log(`- ${item}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
