require("dotenv").config();
const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");

const { getOrCreateUser } = require("./services/userService");
const { registerCar, getUserCars, setActiveCar } = require("./services/carService");
const { saveLog, getRecentLogs, getLogsThisMonth, deleteLastLog } = require("./services/logService");
const { parseAmount, detectType } = require("./utils/parser");
const { sendReply } = require("./utils/sendReply");

const supabase = require("./config/supabase");

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_PHONE = process.env.ADMIN_PHONE;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Set to true to enforce free vs premium restrictions
const PREMIUM_ENABLED = false;

const app = express();

app.use(express.json());
app.use(bodyParser.urlencoded({ extended: false }));

// ─── HELPER FUNCTIONS ─────────────────────────────────────────────────────────

function isPlateNumber(text) {
  // strip spaces before validating e.g. "T 123 ABC" → "T123ABC"
  return /^T[0-9]{3}[A-Z]{3}$/i.test(text.trim().replace(/\s+/g, ""));
}

function isMileage(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("mileage") ||
    lower.includes("km") ||
    lower.includes("kms") ||
    lower.includes("miles")
  );
}

function extractMileage(text) {
  // FIX: strip commas so 100,000 is parsed as 100000 not 100
  const match = text.match(/[\d,]+/);
  if (!match) return null;
  return parseInt(match[0].replace(/,/g, ""));
}

function isPremium(user) {
  if (!PREMIUM_ENABLED) return true;
  if (!user.is_premium) return false;
  if (!user.premium_until) return true;
  const gracePeriodMs = 3 * 24 * 60 * 60 * 1000;
  return new Date(user.premium_until).getTime() + gracePeriodMs > Date.now();
}

function isActivePremiumUser(user) {
  if (!user.is_premium) return false;
  if (!user.premium_until) return true;
  const gracePeriodMs = 3 * 24 * 60 * 60 * 1000;
  return new Date(user.premium_until).getTime() + gracePeriodMs > Date.now();
}

// Check if message looks like a log (has known keywords)
// Used to prevent SMS dumps and random long messages being parsed as logs
function looksLikeLog(text) {
  const lower = text.toLowerCase();
  const logKeywords = [
    "fuel", "mafuta", "oil", "service", "brake",
    "insurance", "mileage", "km", "kms", "miles",
    "maintenance", "repair", "tyre", "tire", "wash"
  ];
  return logKeywords.some(k => lower.includes(k));
}

// ─── AI FUNCTIONS ─────────────────────────────────────────────────────────────

// Extract transaction ID from any mobile money SMS format
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
            content: `Extract the transaction ID from this mobile money SMS confirmation. Return ONLY the transaction ID, nothing else. If you cannot find a transaction ID, return the word "NONE".

SMS: ${smsText}`
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

// Smart fallback — Claude responds helpfully when bot doesn't understand
async function getAIFallbackReply(userMessage, userName, userCars) {
  try {
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
            
The user's name is ${userName} and they have these cars: ${carList}.

The bot supports these commands: fuel logging (e.g. "fuel 40k"), maintenance (e.g. "oil change 120k"), mileage (e.g. "mileage 30402"), insurance (e.g. "insurance 200k"), history, cars, add car, switch to <car>, undo, upgrade, feedback.

The user sent a message the bot didn't understand. Respond helpfully and conversationally in 2-3 sentences maximum. Guide them toward what they probably meant or show them the right command. Be warm and friendly. Do not use markdown formatting. If the message appears to be in Swahili, respond acknowledging that and guide them in English for now.

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

// ─── WEBHOOK VERIFICATION ─────────────────────────────────────────────────────

app.get("/whatsapp", (req, res) => {
  const verify_token = process.env.VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verify_token) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── CRON: CHECK PREMIUM EXPIRY ───────────────────────────────────────────────

app.get("/cron/check-premium", async (req, res) => {
  const secret = req.headers["x-cron-secret"] || req.query.secret;

  if (secret !== process.env.CRON_SECRET) {
    return res.sendStatus(403);
  }

  const now = new Date();
  const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const in1Day  = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);

  const { data: premiumUsers } = await supabase
    .from("users")
    .select("*")
    .eq("is_premium", true)
    .not("premium_until", "is", null)
    .gte("premium_until", now.toISOString());

  if (!premiumUsers || !premiumUsers.length) {
    return res.status(200).json({ message: "No premium users to process." });
  }

  let warned3 = 0, warned1 = 0, downgraded = 0;

  for (const u of premiumUsers) {
    const expiryDate = new Date(u.premium_until);
    const graceEnd = new Date(expiryDate.getTime() + 3 * 24 * 60 * 60 * 1000);

    if (now > graceEnd) {
      await supabase
        .from("users")
        .update({
          is_premium: false,
          premium_warned_3d: false,
          premium_warned_1d: false
        })
        .eq("id", u.id);

      await sendReply(
        u.phone_number,
        `Your Car Logbook Premium has ended.

You're now on the free plan:
• 1 car
• Basic logging
• Last 5 logs history

To get Premium back, type: upgrade

We hope to see you back! 🙏`
      );
      downgraded++;
      continue;
    }

    if (
      expiryDate.toDateString() === in3Days.toDateString() &&
      !u.premium_warned_3d
    ) {
      await sendReply(
        u.phone_number,
        `⭐ Your Car Logbook Premium expires in 3 days.

To keep your premium features, renew now:

Type: upgrade

Questions? contact@carlogbook.app`
      );

      await supabase
        .from("users")
        .update({ premium_warned_3d: true })
        .eq("id", u.id);

      warned3++;
      continue;
    }

    if (
      expiryDate.toDateString() === in1Day.toDateString() &&
      !u.premium_warned_1d
    ) {
      await sendReply(
        u.phone_number,
        `⚠️ Your Car Logbook Premium expires tomorrow!

Renew today to avoid losing access to your premium features.

Type: upgrade`
      );

      await supabase
        .from("users")
        .update({ premium_warned_1d: true })
        .eq("id", u.id);

      warned1++;
    }
  }

  console.log(`Cron ran: ${warned3} 3-day warnings, ${warned1} 1-day warnings, ${downgraded} downgraded`);
  return res.status(200).json({ warned3, warned1, downgraded });
});

// ─── INCOMING MESSAGES ────────────────────────────────────────────────────────

app.post("/whatsapp", async (req, res) => {
  try {

    const body = req.body;

    if (!body.entry) return res.sendStatus(200);

    const message = body.entry[0].changes[0].value.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const messageId = message.id;

    // ── DEDUPLICATION ────────────────────────────────────────────────────────
    // Prevents duplicate processing when Render wakes up from sleep
    try {
      const { data: existing } = await supabase
        .from("processed_messages")
        .select("message_id")
        .eq("message_id", messageId)
        .single();

      if (existing) {
        console.log("Duplicate message ignored:", messageId);
        return res.sendStatus(200);
      }

      await supabase
        .from("processed_messages")
        .insert({ message_id: messageId });

    } catch (dedupError) {
      // if dedup check fails, continue processing rather than blocking the message
      console.error("Dedup error:", dedupError.message);
    }

    // Handle photo messages
    if (message.image) {
      await sendReply(
        from,
        `📷 Nice receipt!\n\nSaving photo receipts is a Premium feature coming soon. For now, just type the amount and I'll log it for you.\n\nExample:\nfuel 45k`
      );
      return res.sendStatus(200);
    }

    // Ignore non-text messages
    if (!message.text) return res.sendStatus(200);

    const text = message.text.body.trim();
    console.log("Incoming:", text);
    console.log("From:", from);

    const contactName =
      body.entry[0].changes[0].value.contacts?.[0]?.profile?.name || "Friend";

    const { user, isNewUser } = await getOrCreateUser(from, contactName);
    let reply = "";

    // ── BRAND NEW USER ────────────────────────────────────────────────────
    if (isNewUser) {
      reply = `👋 Welcome to Car Logbook, ${user.name}!

I help you track fuel, maintenance, mileage, and car expenses — right here on WhatsApp. No app needed.

Let's get your car added first.

What's your car's plate number?

Example: T123ABC`;

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── CANCEL COMMAND ────────────────────────────────────────────────────
    if (text.toLowerCase() === "cancel") {
      await supabase
        .from("users")
        .update({ pending_plate: null })
        .eq("id", user.id);

      reply = `Okay, cancelled. What would you like to do?\n\nType "help" to see all commands.`;
      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── CANCEL PAYMENT ────────────────────────────────────────────────────
    if (text.toLowerCase() === "cancel payment") {
      const { data: pendingPayment } = await supabase
        .from("payments")
        .select("*")
        .eq("user_id", user.id)
        .eq("status", "pending")
        .single();

      if (!pendingPayment) {
        reply = `You don't have any pending payments to cancel.`;
        await sendReply(from, reply);
        return res.sendStatus(200);
      }

      await supabase
        .from("payments")
        .delete()
        .eq("id", pendingPayment.id);

      reply = `✅ Your pending payment (${pendingPayment.transaction_id}) has been cancelled.\n\nIf you'd like to try again, type: upgrade`;
      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── ADMIN COMMANDS ────────────────────────────────────────────────────
    if (from === ADMIN_PHONE) {

      if (text.toLowerCase().startsWith("approve ")) {
        const targetPhone = text.split(" ")[1]?.trim();

        if (!targetPhone) {
          await sendReply(from, `Usage: approve 255XXXXXXXXX`);
          return res.sendStatus(200);
        }

        const { data: targetUser } = await supabase
          .from("users")
          .select("*")
          .eq("phone_number", targetPhone)
          .single();

        if (!targetUser) {
          await sendReply(from, `❌ No user found with phone: ${targetPhone}`);
          return res.sendStatus(200);
        }

        await supabase
          .from("users")
          .update({
            is_premium: true,
            premium_until: new Date(
              new Date().setMonth(new Date().getMonth() + 1)
            ).toISOString(),
            premium_warned_3d: false,
            premium_warned_1d: false
          })
          .eq("phone_number", targetPhone);

        await supabase
          .from("payments")
          .update({ status: "approved" })
          .eq("user_id", targetUser.id)
          .eq("status", "pending");

        await sendReply(
          targetPhone,
          `🎉 You're now a Premium user!

You can now:

• Add multiple cars
• View history per car
• Access all future premium features

Try:
add car
cars
history rav4`
        );

        await sendReply(from, `✅ ${targetUser.name} (${targetPhone}) has been upgraded to Premium.`);
        return res.sendStatus(200);
      }

      if (text.toLowerCase().startsWith("reject ")) {
        const targetPhone = text.split(" ")[1]?.trim();

        if (!targetPhone) {
          await sendReply(from, `Usage: reject 255XXXXXXXXX`);
          return res.sendStatus(200);
        }

        const { data: targetUser } = await supabase
          .from("users")
          .select("*")
          .eq("phone_number", targetPhone)
          .single();

        if (!targetUser) {
          await sendReply(from, `❌ No user found with phone: ${targetPhone}`);
          return res.sendStatus(200);
        }

        await supabase
          .from("payments")
          .update({ status: "rejected" })
          .eq("user_id", targetUser.id)
          .eq("status", "pending");

        await sendReply(
          targetPhone,
          `Sorry, we couldn't verify your payment.

Please double-check your transaction ID and try again:

paid <transaction_id>

Example:
paid QHG72K3

Or contact us at contact@carlogbook.app for help.`
        );

        await sendReply(from, `❌ Payment rejected for ${targetUser.name} (${targetPhone}). User has been notified.`);
        return res.sendStatus(200);
      }
    }

    const userCars = await getUserCars(user.id);

    // ── RESOLVE ACTIVE CAR ────────────────────────────────────────────────
    let carId = null;

    if (user.active_car_id) {
      carId = user.active_car_id;
    } else {
      const { data: carLink } = await supabase
        .from("car_users")
        .select("car_id")
        .eq("user_id", user.id)
        .limit(1)
        .single();
      carId = carLink?.car_id || null;
    }

    // ── DETECT CAR NAME IN MESSAGE ────────────────────────────────────────
    let detectedCars = [];
    userCars.forEach(car => {
      if (text.toLowerCase().includes(car.car_name)) {
        detectedCars.push(car);
      }
    });

    if (detectedCars.length > 1) {
      let options = detectedCars.map(car => `• ${car.car_name}`).join("\n");
      reply = `I found a few cars in your message — which one did you mean?\n\n${options}\n\nTip: Include the car name clearly, e.g:\nfuel 40k rav4`;
      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    if (detectedCars.length === 1) {
      carId = detectedCars[0].id;
    }

    // ── START ─────────────────────────────────────────────────────────────
    if (text.toLowerCase() === "start") {
      reply = `🚗 Car Logbook

Hey ${user.name}! Here's what you can do:

⛽ Log fuel → fuel 40k
🔧 Log maintenance → oil change 120k
📏 Log mileage → mileage 30402
📒 View history → history
🚗 View your cars → cars
➕ Add a new car → add car

Type "help" anytime you need a reminder.
💬 Have feedback? feedback <your message>`;

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── GREETINGS ─────────────────────────────────────────────────────────
    const greetings = ["hi", "hello", "hey", "mambo"];

    if (greetings.includes(text.toLowerCase())) {
      const hasCars = userCars.length > 0;

      if (!hasCars) {
        reply = `👋 Hey ${user.name}! Good to have you here.

It looks like you haven't added a car yet. Let's fix that!

What's your car's plate number?

Example: T123ABC`;
      } else {
        reply = `👋 Hey ${user.name}! Ready to log something?

⛽ fuel 40k
🔧 oil change 120k
📏 mileage 30402
📒 history

Type "help" to see all commands.`;
      }

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── HELP ──────────────────────────────────────────────────────────────
    if (text.toLowerCase() === "help") {
      reply = `🚗 Car Logbook — Quick Guide

Logging:
⛽ fuel 40k
⛽ fuel 40k rav4
🔧 oil change 120k
🔧 service 80k
📏 mileage 30402
💰 insurance 200k

History:
📒 history
📒 history 10 ${PREMIUM_ENABLED ? "(Premium)" : ""}
📒 history month ${PREMIUM_ENABLED ? "(Premium)" : ""}
📒 history rav4 ${PREMIUM_ENABLED ? "(Premium)" : ""}

Cars:
🚗 cars → your registered cars
➕ add car → register a new car ${PREMIUM_ENABLED ? "(Premium after 1st car)" : ""}
🔄 switch to rav4 → change active car

Other:
↩️ undo → remove last log
⭐ upgrade → go Premium
💬 feedback <message> → send us feedback

Tip: If you have multiple cars, include the car name in your message so I know which one to log against.`;

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── FEEDBACK COMMAND ──────────────────────────────────────────────────
    if (text.toLowerCase().startsWith("feedback ")) {
      const feedbackMessage = text.slice(9).trim();

      if (!feedbackMessage) {
        reply = `Please include your message after "feedback".\n\nExample:\nfeedback the bot didn't understand my message`;
        await sendReply(from, reply);
        return res.sendStatus(200);
      }

      await supabase.from("feedback").insert({
        user_id: user.id,
        message: feedbackMessage
      });

      await sendReply(
        ADMIN_PHONE,
        `💬 User Feedback

User: ${user.name}
Phone: ${from}

Message:
${feedbackMessage}`
      );

      reply = `Thanks for the feedback, ${user.name}! 🙏

We read every message and use it to make Car Logbook better.`;

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── UPGRADE COMMAND ───────────────────────────────────────────────────
    if (text.toLowerCase() === "upgrade") {

      if (isActivePremiumUser(user)) {
        const expiryDate = user.premium_until
          ? new Date(user.premium_until).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric"
            })
          : null;

        reply = `⭐ You're already a Premium user!

Your Premium features are active:
• Multiple cars
• Full history access
• More coming soon
${expiryDate ? `\nYour plan renews on: ${expiryDate}` : ""}
Thank you for supporting Car Logbook! 🙏`;
      } else {
        reply = `⭐ Car Logbook Premium

Unlock more features for just 5,000 TZS/month:

✅ Multiple cars
✅ History per car
✅ Extended history (last 10, monthly)
✅ Photo receipts (coming soon)
✅ Analytics & exports (coming soon)

─────────────────
How to upgrade:

1. Send payment via M-Pesa:

   Number: ${process.env.MPESA_NUMBER || "XXXXXXX"}
   Name: Car Logbook

2. After paying, send:
   paid <transaction_id>

   Or paste your full SMS confirmation and I'll find the ID automatically.

   Example:
   paid QHG72K3
─────────────────

Questions? Contact us:
contact@carlogbook.app`;
      }

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── PAID COMMAND ──────────────────────────────────────────────────────
    if (text.toLowerCase().startsWith("paid ")) {
      const rawText = text.slice(5).trim();

      // FIX: AI extracts TID from any SMS format, fallback to first word
      let txnId = null;

      const words = rawText.split(" ");
      if (words.length <= 2) {
        // short message — user typed ID manually
        txnId = words[0].trim().toUpperCase();
      } else {
        // long message — likely a pasted SMS, use AI to extract
        console.log("Extracting TID from SMS via AI...");
        const extracted = await extractTransactionId(rawText);
        if (extracted) {
          txnId = extracted.toUpperCase();
          console.log("AI extracted TID:", txnId);
        } else {
          // AI couldn't find it — ask user to type manually
          reply = `I couldn't find a transaction ID in that message.

Please send just the transaction ID:

paid QHG72K3

Or contact us at contact@carlogbook.app if you need help.`;
          await sendReply(from, reply);
          return res.sendStatus(200);
        }
      }

      if (!txnId) {
        reply = `Please include your transaction ID.\n\nExample:\npaid QHG72K3`;
        await sendReply(from, reply);
        return res.sendStatus(200);
      }

      const { data: existingPending } = await supabase
        .from("payments")
        .select("*")
        .eq("user_id", user.id)
        .eq("status", "pending")
        .single();

      if (existingPending) {
        reply = `You already have a pending payment (${existingPending.transaction_id}).

We'll notify you once it's verified. This usually takes a few hours.

Made a mistake? Type: cancel payment

Questions? contact@carlogbook.app`;
        await sendReply(from, reply);
        return res.sendStatus(200);
      }

      const { data: duplicateTxn } = await supabase
        .from("payments")
        .select("*")
        .eq("transaction_id", txnId)
        .single();

      if (duplicateTxn) {
        reply = `⚠️ That transaction ID has already been submitted.

If you think this is a mistake, contact us at:
contact@carlogbook.app`;
        await sendReply(from, reply);

        await sendReply(
          ADMIN_PHONE,
          `⚠️ Duplicate Transaction ID Alert

User: ${user.name}
Phone: ${from}
Transaction ID: ${txnId}

This ID was already used. Do NOT approve without verifying.`
        );
        return res.sendStatus(200);
      }

      await supabase.from("payments").insert({
        user_id: user.id,
        transaction_id: txnId,
        status: "pending"
      });

      reply = `✅ Got it! Your payment is being verified.

Transaction ID: ${txnId}

You'll receive a confirmation message shortly.

Made a mistake? Type: cancel payment

Questions? contact@carlogbook.app`;
      await sendReply(from, reply);

      await sendReply(
        ADMIN_PHONE,
        `💰 Premium Payment Request

User: ${user.name}
Phone: ${from}
Transaction ID: ${txnId}

To approve:
approve ${from}

To reject:
reject ${from}`
      );

      return res.sendStatus(200);
    }

    // ── CARS ──────────────────────────────────────────────────────────────
    if (text.toLowerCase() === "cars") {
      const cars = await getUserCars(user.id);

      if (!cars.length) {
        reply = `🚗 You haven't added any cars yet.\n\nSend your plate number to get started.\n\nExample: T123ABC`;
      } else {
        let messageText = "🚗 Your Cars\n\n";

        for (const car of cars) {
          const isActive = car.id === carId;

          // fetch last fuel log
          const { data: lastFuel } = await supabase
            .from("logs")
            .select("amount, created_at")
            .eq("car_id", car.id)
            .eq("type", "fuel")
            .order("created_at", { ascending: false })
            .limit(1)
            .single();

          // fetch last mileage log
          const { data: lastMileage } = await supabase
            .from("logs")
            .select("mileage, created_at")
            .eq("car_id", car.id)
            .eq("type", "mileage")
            .order("created_at", { ascending: false })
            .limit(1)
            .single();

          // fetch total log count
          const { count: totalLogs } = await supabase
            .from("logs")
            .select("*", { count: "exact", head: true })
            .eq("car_id", car.id);

          messageText += `${isActive ? "▶" : "•"} ${car.car_name} — ${car.plate_number}${isActive ? " (active)" : ""}\n`;

          if (lastMileage) {
            messageText += `   📏 ${lastMileage.mileage?.toLocaleString()} km\n`;
          }

          if (lastFuel) {
            const fuelDate = new Date(lastFuel.created_at).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short"
            });
            messageText += `   ⛽ ${lastFuel.amount?.toLocaleString()} TZS (${fuelDate})\n`;
          }

          if (totalLogs > 0) {
            messageText += `   📋 ${totalLogs} log${totalLogs === 1 ? "" : "s"} total\n`;
          }

          messageText += "\n";
        }

        messageText += `To log against a specific car:\nfuel 40k rav4\n\n`;
        messageText += `To switch active car:\nswitch to rav4\n\n`;
        messageText += `➕ Add another car: add car`;
        reply = messageText;
      }

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── ADD CAR ───────────────────────────────────────────────────────────
    if (text.toLowerCase() === "add car") {

      if (PREMIUM_ENABLED && userCars.length >= 1 && !isPremium(user)) {
        reply = `⭐ Adding multiple cars is a Premium feature.

You're currently on the free plan which includes 1 car.

Upgrade for 5,000 TZS/month to add unlimited cars.

Type: upgrade`;
        await sendReply(from, reply);
        return res.sendStatus(200);
      }

      await supabase
        .from("users")
        .update({ pending_plate: "AWAITING" })
        .eq("id", user.id);

      reply = `➕ Let's add a new car.

What's the plate number?

Example: T456DEF`;

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── SWITCH ACTIVE CAR ─────────────────────────────────────────────────
    const switchPhrases = ["switch to ", "use ", "change to "];
    const switchMatch = switchPhrases.find(p => text.toLowerCase().startsWith(p));

    if (switchMatch) {

      if (PREMIUM_ENABLED && !isPremium(user)) {
        reply = `⭐ Switching between cars is a Premium feature.\n\nType: upgrade`;
        await sendReply(from, reply);
        return res.sendStatus(200);
      }

      const carName = text.toLowerCase().replace(switchMatch, "").trim();
      const matchedCar = userCars.find(car => car.car_name === carName);

      if (!matchedCar) {
        reply = `I couldn't find a car named "${carName}".\n\nYour cars:\n`;
        userCars.forEach(car => { reply += `• ${car.car_name}\n`; });
        reply += `\nExample:\nswitch to rav4`;
        await sendReply(from, reply);
        return res.sendStatus(200);
      }

      await setActiveCar(user.id, matchedCar.id);

      reply = `✅ Active car switched to ${matchedCar.car_name}.

Logs will now go to ${matchedCar.car_name} by default.

To log:
fuel 40k
mileage 30402`;

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── UNDO ──────────────────────────────────────────────────────────────
    if (text.toLowerCase() === "undo") {
      if (!carId) {
        reply = `Hmm, I couldn't find a car to undo a log for.\n\nMake sure you have a car registered:\ncars`;
        await sendReply(from, reply);
        return res.sendStatus(200);
      }

      const deleted = await deleteLastLog(carId);
      reply = deleted
        ? `↩️ Done! Your last log has been removed.`
        : `Nothing to undo — there are no logs yet for this car.`;

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── HISTORY ───────────────────────────────────────────────────────────
    if (text.toLowerCase().startsWith("history")) {
      const parts = text.toLowerCase().split(" ");

      let historyCarName = null;
      let command = null;

      if (parts.length > 1 && parts[1] !== "10" && parts[1] !== "month") {
        historyCarName = parts[1];
        command = parts[2];
      } else {
        command = parts[1];
      }

      if (PREMIUM_ENABLED && !isPremium(user)) {
        if (command === "10" || command === "month" || historyCarName) {
          reply = `⭐ This is a Premium feature.

Extended history and per-car history are available on Premium.

Type: upgrade`;
          await sendReply(from, reply);
          return res.sendStatus(200);
        }
      }

      if (historyCarName) {
        const matchedCar = userCars.find(car => car.car_name === historyCarName);

        if (!matchedCar) {
          reply = `I couldn't find a car named "${historyCarName}".\n\nYour cars:\n`;
          userCars.forEach(car => { reply += `• ${car.car_name}\n`; });
          reply += `\nTry: history ${userCars[0]?.car_name || "rav4"}`;
          await sendReply(from, reply);
          return res.sendStatus(200);
        }
        carId = matchedCar.id;
      }

      let logs;
      if (command === "10") {
        logs = await getRecentLogs(carId, 10);
      } else if (command === "month") {
        logs = await getLogsThisMonth(carId);
      } else {
        logs = await getRecentLogs(carId, 5);
      }

      const activeCar = userCars.find(car => car.id === carId);
      const activeCarName = activeCar ? activeCar.car_name : "your car";

      if (!logs.length) {
        reply = `📒 No logs found for ${activeCarName}${command === "month" ? " this month" : ""}.\n\nStart logging:\nfuel 40k`;
      } else {
        let messageText = `📒 ${activeCarName} — Recent Logs\n\n`;

        logs.forEach(log => {
          const date = new Date(log.created_at);
          const formattedDate = date.toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short"
          });

          let line = "";
          if (log.type === "fuel") {
            line = `⛽ Fuel — ${log.amount?.toLocaleString()} TZS`;
          } else if (log.type === "maintenance") {
            line = `🔧 ${log.description}`;
          } else if (log.type === "mileage") {
            line = `📏 Mileage — ${log.mileage?.toLocaleString()} km`;
          } else if (log.type === "insurance") {
            line = `💰 Insurance — ${log.amount?.toLocaleString()} TZS`;
          } else {
            line = `💸 ${log.description}`;
          }

          messageText += `${formattedDate}\n${line}\n\n`;
        });

        messageText += `See more:\n`;
        if (historyCarName) {
          messageText += `history ${historyCarName} 10 → last 10 logs\n`;
          messageText += `history ${historyCarName} month → this month\n`;
        } else {
          if (command !== "10") messageText += `history 10 → last 10 logs\n`;
          if (command !== "month") messageText += `history month → this month\n`;
          if (!command) {
            messageText += `history 10 → last 10 logs\n`;
            messageText += `history month → this month\n`;
          }
        }

        const otherCars = userCars.filter(car => car.id !== carId);
        if (otherCars.length > 0) {
          messageText += `\nOther cars:\n`;
          otherCars.forEach(car => {
            messageText += `history ${car.car_name} → ${car.car_name} logs\n`;
          });
        }

        reply = messageText;
      }

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── PLATE NUMBER DETECTED ─────────────────────────────────────────────
    if (isPlateNumber(text)) {
      // FIX: strip spaces from plate before saving e.g. "T 123 ABC" → "T123ABC"
      const plate = text.trim().replace(/\s+/g, "").toUpperCase();

      await supabase
        .from("users")
        .update({ pending_plate: plate })
        .eq("id", user.id);

      reply = `Got it — ${plate} ✅\n\nWhat would you like to call this car?\n\nExamples:\nRav4\nDad's car\nWork car`;

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── MILEAGE LOG ───────────────────────────────────────────────────────
    if (isMileage(text) && carId) {
      const mileage = extractMileage(text);

      if (mileage) {
        await saveLog(carId, "mileage", null, `Mileage ${mileage}`, mileage);
        reply = `📏 Mileage logged — ${mileage.toLocaleString()} km`;
      }

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── CAR NAME STEP (after plate) ───────────────────────────────────────
    if (user.pending_plate && user.pending_plate !== "AWAITING") {
      const carName = text.trim().toLowerCase();
      const plate = user.pending_plate;

      const { data: existingName } = await supabase
        .from("car_users")
        .select(`car_id, cars (car_name)`)
        .eq("user_id", user.id);

      const nameExists = existingName?.some(row => row.cars.car_name === carName);

      if (nameExists) {
        reply = `You already have a car named "${carName}".\n\nPlease choose a different name.\n\nExamples:\n${carName} 2\nwork ${carName}`;
        await sendReply(from, reply);
        return res.sendStatus(200);
      }

      const { data: existingPlate } = await supabase
        .from("cars")
        .select("plate_number")
        .eq("plate_number", plate)
        .single();

      if (existingPlate) {
        reply = `⚠️ That plate number is already registered in the system.\n\nIf this is your car, contact us at contact@carlogbook.app to claim ownership.`;
        await sendReply(from, reply);
        await supabase.from("users").update({ pending_plate: null }).eq("id", user.id);
        return res.sendStatus(200);
      }

      const car = await registerCar(user.id, plate, carName);

      if (userCars.length === 0) {
        await setActiveCar(user.id, car.id);
      }

      await supabase.from("users").update({ pending_plate: null }).eq("id", user.id);

      const isFirstCar = userCars.length === 0;

      reply = `🎉 You're all set, ${user.name}!

${carName} (${plate}) has been added to your logbook.

Now you can start tracking:

⛽ fuel 40k
🔧 oil change 120k
📏 mileage 30402

Type "help" anytime you need a reminder.${isFirstCar ? "\n\nTip: You can add more cars anytime with: add car" : ""}

💬 Got thoughts or suggestions? feedback <your message>`;

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── AWAITING PLATE (after "add car" command) ──────────────────────────
    if (user.pending_plate === "AWAITING") {
      if (!isPlateNumber(text)) {
        reply = `That doesn't look like a valid plate number.

Tanzanian plates look like: T123ABC

Please try again or type "cancel" to go back.`;
        await sendReply(from, reply);
        return res.sendStatus(200);
      }

      // FIX: strip spaces from plate
      const plate = text.trim().replace(/\s+/g, "").toUpperCase();

      await supabase
        .from("users")
        .update({ pending_plate: plate })
        .eq("id", user.id);

      reply = `Got it — ${plate} ✅\n\nWhat would you like to call this car?\n\nExamples:\nPremio\nWork car\nDad's car`;

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── EXPENSE LOG ───────────────────────────────────────────────────────
    const amount = parseAmount(text);
    const type = detectType(text);

    // FIX: only try to log if message looks like a log
    // Prevents SMS dumps and random long messages being saved as logs
    if (amount && carId && looksLikeLog(text)) {
      const { count } = await supabase
        .from("logs")
        .select("*", { count: "exact", head: true })
        .eq("car_id", carId);

      await saveLog(carId, type, amount, text);

      const isFirstLog = count === 0;

      if (isFirstLog) {
        reply = `🎉 First log saved — you're off to a great start!

Keep going:
⛽ fuel 40k
🔧 oil change 120k
📏 mileage 30402
📒 history`;
      } else {
        const carUsed = userCars.find(car => car.id === carId);
        const carName = carUsed ? carUsed.car_name : "your car";

        let typeLabel = "Expense";
        if (type === "fuel") typeLabel = "Fuel";
        else if (type === "maintenance") typeLabel = "Maintenance";
        else if (type === "insurance") typeLabel = "Insurance";

        const isMilestone = count > 0 && (count + 1) % 10 === 0;

        if (isMilestone) {
          reply = `✅ Log saved

Car: ${carName}
${typeLabel}: ${amount.toLocaleString()} TZS

🙌 ${count + 1} logs and counting — great job staying on top of your car expenses!

💬 Enjoying Car Logbook? We'd love to hear from you:
feedback <your message>`;
        } else {
          reply = `✅ Log saved

Car: ${carName}
${typeLabel}: ${amount.toLocaleString()} TZS`;
        }
      }

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── AI SMART FALLBACK ─────────────────────────────────────────────────
    // When bot doesn't understand, Claude tries to help
    const aiReply = await getAIFallbackReply(text, user.name, userCars);

    if (aiReply) {
      reply = aiReply;
    } else {
      // AI failed — use static fallback
      reply = `Hmm, I didn't quite get that. 🤔

Here are some things you can try:

⛽ fuel 40k
🔧 oil change 120k
📏 mileage 30402
📒 history
🚗 cars

Or type "help" for the full guide.

💬 Something not working as expected?
feedback <your message>`;
    }

    await sendReply(from, reply);
    res.sendStatus(200);

  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(200);
  }
});

// ─── START SERVER ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});