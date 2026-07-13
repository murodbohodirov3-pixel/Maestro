export type InstagramContentType = "reel" | "post" | "carousel" | "stories";
export type InstagramGoal = "views" | "clients" | "revenue" | "retention";

export interface InstagramBriefInput {
  contentType: InstagramContentType;
  goal: InstagramGoal;
  topic: string;
  offer: string;
  audience: string;
  days: number;
}

export function buildInstagramProductionBrief(input: InstagramBriefInput) {
  const isVideo = input.contentType === "reel" || input.contentType === "stories";
  return {
    status: "draft_waiting_for_owner_approval",
    provider: isVideo ? "Higgsfield" : "Higgsfield or approved design tool",
    objective: input.goal,
    contentType: input.contentType,
    topic: input.topic.trim(),
    offer: input.offer.trim(),
    audience: input.audience.trim(),
    testPeriodDays: clamp(input.days, 1, 30),
    productionRules: {
      aspectRatio: isVideo ? "9:16" : "4:5",
      durationSeconds: isVideo ? "8-15" : null,
      language: "Russian; Uzbek only when requested by owner",
      hookDeadlineSeconds: isVideo ? 2 : null,
      brand: "Maestro Barberia — premium but authentic barbershop atmosphere",
      prohibitedClaims: [
        "invented prices or discounts",
        "guaranteed business results",
        "fake customer testimonials",
        "claiming generation or publication already happened"
      ]
    },
    requiredDeliverables: [
      "one-sentence concept tied to the business goal",
      "hook and frame-by-frame script",
      "spoken lines and on-screen text",
      "detailed English Higgsfield prompt and negative prompt",
      "cover headline",
      "Russian caption with CTA",
      "supporting Stories sequence",
      "publication time hypothesis",
      "KPI, measurement window and stop/scale rule"
    ],
    approval: {
      required: true,
      reason: "Higgsfield generation spends account credits",
      nextStep: "Owner reviews the package, references and offer, then explicitly confirms generation"
    },
    missingDataWarning: "Instagram reach, retention, ad spend and profile conversion are not connected yet; treat targets as hypotheses until those metrics are supplied."
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Math.trunc(value) || minimum, minimum), maximum);
}
