const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Set OPENAI_API_KEY before running this script");

const response = await fetch("https://api.openai.com/v1/conversations", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ metadata: { product: "maestro-telegram-agents" } })
});

if (!response.ok) throw new Error(`OpenAI conversation create failed (${response.status})`);
const conversation = await response.json();
console.log(conversation.id);
