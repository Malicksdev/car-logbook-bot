const axios = require("axios");
const { PREMIUM_ENABLED } = require("../config/constants");
const { checkLimit, incrementUsage } = require("../services/usageService");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ─── EXTRACT TRANSACTION ID FROM SMS ─────────────────────────────────────────

async function extractTransactionId(smsText) {
  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [
          {
            role: "user",
            content: `Extract the transaction ID from this mobile money SMS confirmation. Return ONLY the transaction ID, nothing else. If you cannot find a transaction ID, return the word "NONE".\n\nSMS: ${smsText}`
          }
        ]
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json"
        }
      }
    );
    const result = response.data.content[0].text.trim();
    return result === "NONE" ? null : result;
  } catch (error) {
    console.error("AI TID extraction error:", error.message);
    return null;
  }
}

// ─── AI FALLBACK REPLY ────────────────────────────────────────────────────────
// When PREMIUM_ENABLED: only premium users get AI fallback
// Rate-limited to AI_FALLBACK_DAILY_LIMIT calls/day via daily_usage.ai_fallback_count

async function getAIFallbackReply(userMessage, userCars, userId) {
  try {
    if (PREMIUM_ENABLED) {
      const allowed = await checkLimit(userId, "ai_fallback_count");
      if (!allowed) return null;
      await incrementUsage(userId, "ai_fallback_count");
    }

    const carList = userCars.length
      ? userCars.map(c => c.car_name).join(", ")
      : "no cars registered yet";

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: `You are a helpful WhatsApp assistant for Car Logbook, a car expense tracking bot in Tanzania.

The user has these cars: ${carList}.

The bot supports these commands: fuel logging (e.g. "fuel 40k"), maintenance (e.g. "oil change 120k", "air cleaner 30k", "battery 80k", "tyre 150k"), mileage (e.g. "mileage 30402"), insurance (e.g. "insurance 200k"), history, cars, add car, switch to <car>, undo, upgrade, feedback.

The user sent a message the bot didn't understand. Respond helpfully and conversationally. Keep your response under 3 sentences. Do not greet the user by name. Guide them toward what they probably meant or show them the right command. Be warm and friendly. Do not use markdown formatting. If the message appears to be in Swahili, respond acknowledging that and guide them in English for now.

User message: "${userMessage}"`
          }
        ]
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json"
        }
      }
    );
    return response.data.content[0].text.trim();
  } catch (error) {
    console.error("AI fallback error:", error.message);
    return null;
  }
}

module.exports = { extractTransactionId, getAIFallbackReply };