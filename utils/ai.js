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
            content: `You are a helpful WhatsApp support assistant for Car Logbook, a car expense tracking bot built for drivers in Tanzania. You know every feature of the bot in detail and can answer questions about how to use it.

The user's registered cars: ${carList}.

FULL FEATURE REFERENCE — know all of these:

LOGGING:
- Fuel: "fuel 40k" or "fuel 45,000"
- Maintenance: "oil change 120k", "air cleaner 30k", "battery 80k", "tyre 150k", "brake 200k", "coolant 50k", "wiper 20k", "gearbox oil 80k", "service 300k"
- Mileage: "mileage 30402" or "30402 km"
- Insurance: "insurance 1.2M"
- Undo last log: "undo"

HISTORY:
- "history" — last 5 logs
- "history 10" — last 10 logs (Premium)
- "history month" — this month's logs (Premium)
- "history rav4" — logs for a specific car (Premium)

CARS:
- "cars" — see all your cars
- "add car" — register a new car
- "switch to rav4" — change active car
- "use rav4" or "change to rav4" also work

CITY:
- "my city Arusha" — set your city to receive local EWURA fuel prices each month
- Free to set initially, Premium to change

SERVICE REMINDERS (Premium):
- "remind oil change every 5000km" — get reminded when due
- "remind service every 90 days" — day-based reminder
- "reminders list" — see all active service reminders
- "reminders clear oil change" — remove a reminder
- Reminder resets automatically when you log the matching maintenance

LOGGING REMINDERS:
- "reminders weekly" — nudge if no log in 7 days
- "reminders fortnightly" — nudge every 14 days
- "reminders monthly" — nudge every 30 days
- "reminders off" — turn off nudges

INSURANCE:
- "insurance expiry 15 Aug 2026" — set expiry date for reminders
- Reminders sent 30, 7, and 1 day before expiry (Premium)

PREMIUM:
- "upgrade" — see plans and pricing (5,000 TZS/month or 50,000 TZS/year)
- "paid QHG72K3" — submit M-Pesa transaction ID after paying
- "cancel payment" — cancel a pending payment

OTHER:
- "help" — quick command guide
- "feedback <message>" — send feedback to the team
- "cancel" — cancel any pending action

RULES FOR YOUR REPLY:
- Be warm, conversational, and helpful — like a knowledgeable friend
- Keep replies SHORT — 1 to 2 sentences maximum, never more
- If the user asks how to do something, give them the exact command and nothing else
- Never use markdown formatting (no bold, no bullet points, no headers)
- Never write multiple paragraphs — one short answer only
- If the message looks like a log attempt that didn't parse, show them the correct format
- If the message is in Swahili, acknowledge it warmly and respond in English for now
- Do not greet the user by name
- Do not make up features that don't exist
- Do not over-explain — short and direct is always better

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

// ─── ANALYZE PHOTO ────────────────────────────────────────────────────────────
// Downloads image from WhatsApp, sends to Claude Vision, returns structured result

async function analyzePhoto(imageId, mimeType) {
  try {
    // Step 1: Get image download URL from WhatsApp
    const mediaResponse = await axios.get(
      `https://graph.facebook.com/v18.0/${imageId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
        }
      }
    );

    const imageUrl = mediaResponse.data.url;

    // Step 2: Download the image as base64
    const imageResponse = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
      }
    });

    const base64Image = Buffer.from(imageResponse.data).toString("base64");
    const mediaType = mimeType || "image/jpeg";

    // Step 3: Send to Claude Vision
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: base64Image
                }
              },
              {
                type: "text",
                text: `You are analyzing a photo sent by a car owner in Tanzania. They are trying to log a car expense.

Look at this image and identify what car-related service or product it shows.

Respond ONLY with a valid JSON object in this exact format (no extra text):
{
  "identified": true,
  "service_type": "oil_change",
  "subtype": "engine_oil",
  "description": "Engine oil (Castrol GTX)",
  "confidence": "high",
  "prompt": "Looks like an engine oil change! How much did you pay?"
}

service_type must be one of: fuel, oil_change, oil_filter, fuel_filter, air_filter, coolant, gearbox_oil, battery, tyre, brake, wiper, service, insurance, unknown
subtype should match the maintenance subtype if applicable (engine_oil, oil_filter, fuel_filter, air_filter, coolant, gearbox_oil, battery, tyre, brake, wiper, service) or null for fuel/insurance/unknown
confidence must be: high, medium, or low
prompt should be a friendly 1-sentence question asking how much they paid

If you cannot identify a car-related expense, set identified to false, service_type to "unknown", and prompt to "Got your photo! What was this for and how much did it cost? (e.g. oil change 120k)"`
              }
            ]
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

    const raw = response.data.content[0].text.trim();
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);

  } catch (error) {
    console.error("Photo analysis error:", error.message);
    return {
      identified: false,
      service_type: "unknown",
      subtype: null,
      description: null,
      confidence: "low",
      prompt: "Got your photo! What was this for and how much did it cost? (e.g. oil change 120k)"
    };
  }
}

module.exports = { extractTransactionId, getAIFallbackReply, analyzePhoto };