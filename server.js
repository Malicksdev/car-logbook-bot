require("dotenv").config();
const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");

const { getOrCreateUser } = require("./services/userService");
const { registerCar, getUserCars, setActiveCar } = require("./services/carService");
const { saveLog, getRecentLogs, getLogsThisMonth, deleteLastLog } = require("./services/logService");
const { parseAmount, detectType, looksLikeLog } = require("./utils/parser");
const { sendReply } = require("./utils/sendReply");
const { checkLimit, incrementUsage } = require("./services/usageService");

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
  const match = text.match(/[\d,]+/);
  if (!match) return null;
  return parseInt(match[0].replace(/,/g, ""));
}

function isPremium(user) {
  if (!PREMIUM_ENABLED) return true;
  if (user.is_lifetime) return true;
  if (!user.is_premium) return false;
  if (!user.premium_until) return true;
  const gracePeriodMs = 3 * 24 * 60 * 60 * 1000;
  return new Date(user.premium_until).getTime() + gracePeriodMs > Date.now();
}

function isActivePremiumUser(user) {
  if (user.is_lifetime) return true;
  if (!user.is_premium) return false;
  if (!user.premium_until) return true;
  const gracePeriodMs = 3 * 24 * 60 * 60 * 1000;
  return new Date(user.premium_until).getTime() + gracePeriodMs > Date.now();
}

function subtypeLabel(subtype) {
  const labels = {
    engine_oil:  "Engine Oil",
    oil_filter:  "Oil Filter",
    fuel_filter: "Fuel Filter",
    air_filter:  "Air Cleaner/Filter",
    coolant:     "Coolant",
    gearbox_oil: "Gearbox Oil",
    hydraulic:   "Hydraulic Fluid",
    battery:     "Battery",
    tyre:        "Tyres",
    wiper:       "Wiper Blades",
    brake:       "Brakes",
    wash:        "Car Wash",
    service:     "Service"
  };
  return labels[subtype] || null;
}

// ─── AI FUNCTIONS ─────────────────────────────────────────────────────────────

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

async function getAIFallbackReply(userMessage, userCars) {
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
  if (secret !== process.env.CRON_SECRET) return res.sendStatus(403);

  const now = new Date();
  const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const in1Day  = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);

  const { data: premiumUsers } = await supabase
    .from("users")
    .select("*")
    .eq("is_premium", true)
    .eq("is_lifetime", false)
    .not("premium_until", "is", null)
    .gte("premium_until", now.toISOString());

  let warned3 = 0, warned1 = 0, downgraded = 0;

  for (const u of premiumUsers || []) {
    const expiryDate = new Date(u.premium_until);
    const graceEnd = new Date(expiryDate.getTime() + 3 * 24 * 60 * 60 * 1000);

    if (now > graceEnd) {
      await supabase.from("users").update({
        is_premium: false, premium_warned_3d: false, premium_warned_1d: false
      }).eq("id", u.id);

      await sendReply(u.phone_number,
        `Your Car Logbook Premium has ended.\n\nYou're now on the free plan:\n• 1 car\n• Basic logging\n• Last 5 logs history\n\nTo get Premium back, type: upgrade\n\nWe hope to see you back! 🙏`
      );
      downgraded++;
      continue;
    }

    if (expiryDate.toDateString() === in3Days.toDateString() && !u.premium_warned_3d) {
      await sendReply(u.phone_number,
        `⭐ Your Car Logbook Premium expires in 3 days.\n\nTo keep your premium features, renew now:\n\nType: upgrade\n\nQuestions? contact@carlogbook.app`
      );
      await supabase.from("users").update({ premium_warned_3d: true }).eq("id", u.id);
      warned3++;
      continue;
    }

    if (expiryDate.toDateString() === in1Day.toDateString() && !u.premium_warned_1d) {
      await sendReply(u.phone_number,
        `⚠️ Your Car Logbook Premium expires tomorrow!\n\nRenew today to avoid losing access to your premium features.\n\nType: upgrade`
      );
      await supabase.from("users").update({ premium_warned_1d: true }).eq("id", u.id);
      warned1++;
    }
  }

  console.log(`Cron ran: ${warned3} 3-day warnings, ${warned1} 1-day warnings, ${downgraded} downgraded`);

  // ── INSURANCE EXPIRY REMINDERS ─────────────────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const in30Days   = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const in7DaysIns = new Date(today.getTime() + 7  * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const in1DayIns  = new Date(today.getTime() + 1  * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const { data: insuranceRecords } = await supabase
    .from("car_insurance")
    .select("*, cars (id, car_name, plate_number, car_users (users (phone_number, is_premium, is_lifetime, premium_until)))")
    .gte("expiry_date", today.toISOString().split("T")[0]);

  let insuranceReminders = 0;

  for (const record of insuranceRecords || []) {
    const expiry = record.expiry_date;
    const car = record.cars;
    if (!car) continue;

    for (const link of car.car_users || []) {
      const u = link.users;
      if (!u) continue;

      const userIsPremium = u.is_lifetime || (u.is_premium && u.premium_until &&
        new Date(u.premium_until).getTime() + 3 * 24 * 60 * 60 * 1000 > Date.now());
      if (!userIsPremium) continue;

      if (expiry === in30Days && !record.notified_30d) {
        await sendReply(u.phone_number,
          `🔔 Insurance Reminder — ${car.car_name}\n\nYour insurance expires in 30 days (${expiry}).\n\nMake sure to renew on time to stay covered.`
        );
        await supabase.from("car_insurance").update({ notified_30d: true }).eq("id", record.id);
        insuranceReminders++;
      } else if (expiry === in7DaysIns && !record.notified_7d) {
        await sendReply(u.phone_number,
          `⚠️ Insurance Reminder — ${car.car_name}\n\nYour insurance expires in 7 days (${expiry}).\n\nTime to renew if you haven't already.`
        );
        await supabase.from("car_insurance").update({ notified_7d: true }).eq("id", record.id);
        insuranceReminders++;
      } else if (expiry === in1DayIns && !record.notified_1d) {
        await sendReply(u.phone_number,
          `🚨 Insurance Expires Tomorrow — ${car.car_name}\n\nYour insurance expires tomorrow (${expiry}).\n\nPlease renew today to avoid driving uninsured.`
        );
        await supabase.from("car_insurance").update({ notified_1d: true }).eq("id", record.id);
        insuranceReminders++;
      }
    }
  }

  // ── EWURA REMINDER: nudge admin on 3rd if prices not entered ──────────
  const todayDate = new Date();
  if (todayDate.getDate() === 3) {
    const monthKey = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, "0")}`;
    const { data: existingPrices } = await supabase
      .from("fuel_prices").select("id").eq("month", monthKey).limit(1);

    if (!existingPrices || existingPrices.length === 0) {
      const monthLabel = todayDate.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
      await sendReply(ADMIN_PHONE,
`⛽ EWURA Reminder

Fuel prices for ${monthLabel} haven't been entered yet.

Check https://ewura.go.tz and enter prices per city:

ewura dar 2864 2858 2932
ewura arusha 2973 2967 3042
ewura dodoma 2942 2937 3011
ewura mwanza 3049 3043 3118
ewura mbeya 2996 2990 3064
ewura moshi 2957 2952 3026
ewura tanga 2925 2919 2993

Then broadcast:
ewura broadcast`
      );
    }
  }

  console.log(`Insurance reminders sent: ${insuranceReminders}`);
  return res.status(200).json({ warned3, warned1, downgraded, insuranceReminders });
});

// ─── CRON: MONTHLY SUMMARY ────────────────────────────────────────────────────

app.get("/cron/monthly", async (req, res) => {
  const secret = req.headers["x-cron-secret"] || req.query.secret;
  if (secret !== process.env.CRON_SECRET) return res.sendStatus(403);

  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStart = new Date(lastMonth.getFullYear(), lastMonth.getMonth(), 1).toISOString();
  const lastMonthEnd   = new Date(lastMonth.getFullYear(), lastMonth.getMonth() + 1, 0, 23, 59, 59).toISOString();
  const monthLabel = lastMonth.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  const { data: allUsers } = await supabase.from("users").select("*");
  let summariesSent = 0;

  for (const u of allUsers || []) {
    try {
      const { data: carLinks } = await supabase
        .from("car_users")
        .select("car_id, cars (id, car_name, plate_number, fuel_type)")
        .eq("user_id", u.id);

      if (!carLinks || carLinks.length === 0) continue;

      const userIsPremium = isPremium(u);
      let summaryMsg = `📊 Monthly Summary — ${monthLabel}\n\n`;
      let hasData = false;

      for (const link of carLinks) {
        const car = link.cars;
        if (!car) continue;

        const { data: logs } = await supabase
          .from("logs")
          .select("*")
          .eq("car_id", car.id)
          .gte("created_at", lastMonthStart)
          .lte("created_at", lastMonthEnd);

        if (!logs || logs.length === 0) continue;
        hasData = true;

        let totalFuel = 0, totalMaintenance = 0, totalInsurance = 0, totalSpend = 0;
        let maintenanceByType = {};
        let startMileage = null, endMileage = null;

        for (const log of logs) {
          if (log.type === "fuel") {
            totalFuel += log.amount || 0;
            totalSpend += log.amount || 0;
          } else if (log.type === "maintenance") {
            totalMaintenance += log.amount || 0;
            totalSpend += log.amount || 0;
            const label = subtypeLabel(log.subtype) || "Other";
            maintenanceByType[label] = (maintenanceByType[label] || 0) + (log.amount || 0);
          } else if (log.type === "insurance") {
            totalInsurance += log.amount || 0;
            totalSpend += log.amount || 0;
          } else if (log.type === "mileage" && log.mileage) {
            if (!startMileage || log.mileage < startMileage) startMileage = log.mileage;
            if (!endMileage   || log.mileage > endMileage)   endMileage   = log.mileage;
          }
        }

        const kmDriven = (startMileage && endMileage && endMileage > startMileage)
          ? endMileage - startMileage : null;

        summaryMsg += `🚗 ${car.car_name} (${car.plate_number})\n`;

        if (userIsPremium) {
          if (totalFuel > 0)
            summaryMsg += `⛽ Fuel: ${totalFuel.toLocaleString()} TZS\n`;
          if (Object.keys(maintenanceByType).length > 0) {
            summaryMsg += `🔧 Maintenance: ${totalMaintenance.toLocaleString()} TZS\n`;
            for (const [label, amt] of Object.entries(maintenanceByType)) {
              summaryMsg += `   • ${label}: ${amt.toLocaleString()} TZS\n`;
            }
          }
          if (totalInsurance > 0)
            summaryMsg += `💰 Insurance: ${totalInsurance.toLocaleString()} TZS\n`;
          if (kmDriven)
            summaryMsg += `📏 Distance: ${kmDriven.toLocaleString()} km\n`;
          summaryMsg += `━━━━━━━━━━━━\n`;
          summaryMsg += `Total: ${totalSpend.toLocaleString()} TZS\n\n`;
        } else {
          summaryMsg += `Total spend: ${totalSpend.toLocaleString()} TZS\n\n`;
        }
      }

      if (!hasData) continue;

      if (!userIsPremium) {
        summaryMsg += `─────────────────\n⭐ Want a full breakdown — fuel, maintenance, km driven?\n\nUpgrade to Premium: upgrade`;
      }

      await sendReply(u.phone_number, summaryMsg);
      summariesSent++;

    } catch (err) {
      console.error(`Monthly summary error for ${u.phone_number}:`, err.message);
    }
  }

  console.log(`Monthly summaries sent: ${summariesSent}`);
  return res.status(200).json({ summariesSent, month: monthLabel });
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

    // ── DEDUPLICATION ──────────────────────────────────────────────────────
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
      await supabase.from("processed_messages").insert({ message_id: messageId });
    } catch (dedupError) {
      console.error("Dedup error:", dedupError.message);
    }

    if (message.image) {
      await sendReply(from,
        `📷 Nice receipt!\n\nSaving photo receipts is a Premium feature coming soon. For now, just type the amount and I'll log it for you.\n\nExample:\nfuel 45k`
      );
      return res.sendStatus(200);
    }

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
      await sendReply(from,
        `👋 Welcome to Car Logbook, ${user.name}!\n\nI help you track fuel, maintenance, mileage, and car expenses — right here on WhatsApp. No app needed.\n\nLet's get your car added first.\n\nWhat's your car's plate number?\n\nExample: T123ABC`
      );
      return res.sendStatus(200);
    }

    // ── CANCEL ────────────────────────────────────────────────────────────
    if (text.toLowerCase() === "cancel") {
      await supabase.from("users").update({ pending_plate: null, onboarding_step: null }).eq("id", user.id);
      await sendReply(from, `Okay, cancelled. What would you like to do?\n\nType "help" to see all commands.`);
      return res.sendStatus(200);
    }

    // ── CANCEL PAYMENT ────────────────────────────────────────────────────
    if (text.toLowerCase() === "cancel payment") {
      const { data: pendingPayment } = await supabase
        .from("payments").select("*")
        .eq("user_id", user.id).eq("status", "pending").single();

      if (!pendingPayment) {
        await sendReply(from, `You don't have any pending payments to cancel.`);
        return res.sendStatus(200);
      }

      await supabase.from("payments").delete().eq("id", pendingPayment.id);
      await sendReply(from, `✅ Your pending payment (${pendingPayment.transaction_id}) has been cancelled.\n\nIf you'd like to try again, type: upgrade`);
      return res.sendStatus(200);
    }

    // ── ADMIN COMMANDS ────────────────────────────────────────────────────
    if (from === ADMIN_PHONE) {

      // APPROVE
      if (text.toLowerCase().startsWith("approve ")) {
        const parts = text.split(" ");
        const targetPhone = parts[1]?.trim();
        const plan = parts[2]?.toLowerCase().trim() || "monthly";

        if (!targetPhone) {
          await sendReply(from, `Usage:\napprove 255XXXXXXXXX\napprove 255XXXXXXXXX annual`);
          return res.sendStatus(200);
        }
        if (!["monthly", "annual"].includes(plan)) {
          await sendReply(from, `❌ Unknown plan: "${plan}"\n\nValid plans: monthly, annual`);
          return res.sendStatus(200);
        }

        const { data: targetUser } = await supabase.from("users").select("*").eq("phone_number", targetPhone).single();
        if (!targetUser) { await sendReply(from, `❌ No user found: ${targetPhone}`); return res.sendStatus(200); }

        const now = new Date();
        const premiumUntil = plan === "annual"
          ? new Date(now.setFullYear(now.getFullYear() + 1)).toISOString()
          : new Date(now.setMonth(now.getMonth() + 1)).toISOString();
        const amount = plan === "annual" ? 50000 : 5000;

        await supabase.from("users").update({
          is_premium: true, premium_until: premiumUntil, premium_plan: plan,
          premium_warned_3d: false, premium_warned_1d: false
        }).eq("phone_number", targetPhone);

        await supabase.from("payments").update({ status: "approved", plan, amount })
          .eq("user_id", targetUser.id).eq("status", "pending");

        const planLabel = plan === "annual" ? "Annual (1 year)" : "Monthly (1 month)";
        const expiryLabel = new Date(premiumUntil).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

        await sendReply(targetPhone,
`🎉 You're now a Premium user!

Plan: ${planLabel}
Expires: ${expiryLabel}

You can now:
• Add multiple cars
• View full history
• Get insurance reminders
• Monthly expense summaries

Try:
add car
history month
upgrade`
        );
        await sendReply(from, `✅ ${targetUser.name} (${targetPhone}) approved on ${plan} plan. Expires: ${expiryLabel}`);
        return res.sendStatus(200);
      }

      // REJECT
      if (text.toLowerCase().startsWith("reject ")) {
        const targetPhone = text.split(" ")[1]?.trim();
        if (!targetPhone) { await sendReply(from, `Usage: reject 255XXXXXXXXX`); return res.sendStatus(200); }

        const { data: targetUser } = await supabase.from("users").select("*").eq("phone_number", targetPhone).single();
        if (!targetUser) { await sendReply(from, `❌ No user found: ${targetPhone}`); return res.sendStatus(200); }

        await supabase.from("payments").update({ status: "rejected" }).eq("user_id", targetUser.id).eq("status", "pending");
        await sendReply(targetPhone,
          `Sorry, we couldn't verify your payment.\n\nPlease double-check your transaction ID and try again:\n\npaid <transaction_id>\n\nOr contact us at contact@carlogbook.app for help.`
        );
        await sendReply(from, `❌ Payment rejected for ${targetUser.name} (${targetPhone}).`);
        return res.sendStatus(200);
      }

      // DOWNGRADE
      if (text.toLowerCase().startsWith("downgrade ")) {
        const targetPhone = text.split(" ")[1]?.trim();
        if (!targetPhone) { await sendReply(from, `Usage: downgrade 255XXXXXXXXX`); return res.sendStatus(200); }

        const { data: targetUser } = await supabase.from("users").select("*").eq("phone_number", targetPhone).single();
        if (!targetUser) { await sendReply(from, `❌ No user found: ${targetPhone}`); return res.sendStatus(200); }

        await supabase.from("users").update({
          is_premium: false, is_lifetime: false, premium_until: null, premium_plan: null,
          premium_warned_3d: false, premium_warned_1d: false
        }).eq("phone_number", targetPhone);

        await sendReply(from, `✅ ${targetUser.name} (${targetPhone}) downgraded to free.`);
        return res.sendStatus(200);
      }

      // EXTEND
      if (text.toLowerCase().startsWith("extend ")) {
        const targetPhone = text.split(" ")[1]?.trim();
        if (!targetPhone) { await sendReply(from, `Usage: extend 255XXXXXXXXX`); return res.sendStatus(200); }

        const { data: targetUser } = await supabase.from("users").select("*").eq("phone_number", targetPhone).single();
        if (!targetUser) { await sendReply(from, `❌ No user found: ${targetPhone}`); return res.sendStatus(200); }
        if (!targetUser.is_premium) { await sendReply(from, `⚠️ ${targetUser.name} is not premium. Use approve instead.`); return res.sendStatus(200); }

        const base = targetUser.premium_until ? new Date(targetUser.premium_until) : new Date();
        const newExpiry = new Date(base.setMonth(base.getMonth() + 1)).toISOString();

        await supabase.from("users").update({
          premium_until: newExpiry, premium_warned_3d: false, premium_warned_1d: false
        }).eq("phone_number", targetPhone);

        const expiryLabel = new Date(newExpiry).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
        await sendReply(targetPhone, `⭐ Good news! Your Car Logbook Premium has been extended.\n\nNew expiry: ${expiryLabel}\n\nThank you for being a valued member! 🙏`);
        await sendReply(from, `✅ ${targetUser.name} extended by 1 month. New expiry: ${expiryLabel}`);
        return res.sendStatus(200);
      }

      // USER LOOKUP
      if (text.toLowerCase().startsWith("user ")) {
        const targetPhone = text.split(" ")[1]?.trim();
        if (!targetPhone) { await sendReply(from, `Usage: user 255XXXXXXXXX`); return res.sendStatus(200); }

        const { data: targetUser } = await supabase.from("users").select("*").eq("phone_number", targetPhone).single();
        if (!targetUser) { await sendReply(from, `❌ No user found: ${targetPhone}`); return res.sendStatus(200); }

        const { data: userCarLinks } = await supabase
          .from("car_users").select("car_id, cars (car_name, plate_number)").eq("user_id", targetUser.id);

        const { count: totalLogs } = await supabase.from("logs")
          .select("*", { count: "exact", head: true })
          .in("car_id", (userCarLinks || []).map(l => l.car_id));

        const joined = new Date(targetUser.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

        let planStatus = "Free";
        if (targetUser.is_lifetime) planStatus = "Lifetime ⭐";
        else if (targetUser.is_premium && targetUser.premium_until) {
          const expiry = new Date(targetUser.premium_until).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
          planStatus = `Premium (${targetUser.premium_plan || "monthly"}) — expires ${expiry}`;
        }

        const carList = (userCarLinks || []).map(l => `  • ${l.cars.car_name} (${l.cars.plate_number})`).join("\n") || "  None";

        await sendReply(from,
`👤 User Lookup

Name: ${targetUser.name}
Phone: ${targetPhone}
Joined: ${joined}
Plan: ${planStatus}
City: ${targetUser.city || "Not set"}
Cars: ${userCarLinks?.length || 0}
${carList}
Total logs: ${totalLogs || 0}`
        );
        return res.sendStatus(200);
      }

      // CAR LOOKUP
      if (text.toLowerCase().startsWith("car ")) {
        const plateRaw = text.split(" ")[1]?.trim().toUpperCase().replace(/\s+/g, "");
        if (!plateRaw) { await sendReply(from, `Usage: car T123ABC`); return res.sendStatus(200); }

        const { data: carData } = await supabase.from("cars").select("*").eq("plate_number", plateRaw).single();
        if (!carData) { await sendReply(from, `❌ No car found: ${plateRaw}`); return res.sendStatus(200); }

        const { data: owners } = await supabase.from("car_users").select("user_id, users (name, phone_number)").eq("car_id", carData.id);
        const { count: totalLogs } = await supabase.from("logs").select("*", { count: "exact", head: true }).eq("car_id", carData.id);

        const { data: lastMileage } = await supabase.from("logs").select("mileage, created_at")
          .eq("car_id", carData.id).eq("type", "mileage").order("created_at", { ascending: false }).limit(1).single();
        const { data: lastFuel } = await supabase.from("logs").select("amount, created_at")
          .eq("car_id", carData.id).eq("type", "fuel").order("created_at", { ascending: false }).limit(1).single();

        const ownerList = (owners || []).map(o => `  • ${o.users.name} (${o.users.phone_number})`).join("\n") || "  None";

        await sendReply(from,
`🚗 Car Lookup

Plate: ${carData.plate_number}
Name: ${carData.car_name}
Fuel type: ${carData.fuel_type || "Not set"}
Registered: ${new Date(carData.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}

Owners:
${ownerList}

Total logs: ${totalLogs || 0}
Last mileage: ${lastMileage ? `${lastMileage.mileage?.toLocaleString()} km` : "No mileage logged"}
Last fuel: ${lastFuel ? `${lastFuel.amount?.toLocaleString()} TZS on ${new Date(lastFuel.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "No fuel logged"}`
        );
        return res.sendStatus(200);
      }

      // PENDING
      if (text.toLowerCase() === "pending") {
        const { data: pendingPayments } = await supabase
          .from("payments").select("*, users (name, phone_number)")
          .eq("status", "pending").order("created_at", { ascending: false });

        if (!pendingPayments || !pendingPayments.length) {
          await sendReply(from, `✅ No pending payments right now.`);
          return res.sendStatus(200);
        }

        let msg = `💰 Pending Payments (${pendingPayments.length})\n\n`;
        pendingPayments.forEach((p, i) => {
          const date = new Date(p.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
          msg += `${i + 1}. ${p.users.name} (${p.users.phone_number})\n   TID: ${p.transaction_id}\n   Submitted: ${date}\n\n`;
        });
        msg += `To approve:\napprove 255XXXXXXXXX\napprove 255XXXXXXXXX annual`;
        await sendReply(from, msg);
        return res.sendStatus(200);
      }

      // PAYMENTS
      if (text.toLowerCase() === "payments") {
        const { data: recentPayments } = await supabase
          .from("payments").select("*, users (name, phone_number)")
          .eq("status", "approved").order("created_at", { ascending: false }).limit(10);

        if (!recentPayments || !recentPayments.length) {
          await sendReply(from, `No approved payments yet.`);
          return res.sendStatus(200);
        }

        let msg = `✅ Recent Payments (last ${recentPayments.length})\n\n`;
        recentPayments.forEach((p, i) => {
          const date = new Date(p.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
          const planStr = p.plan ? ` — ${p.plan}` : "";
          const amountStr = p.amount ? ` (${p.amount.toLocaleString()} TZS)` : "";
          msg += `${i + 1}. ${p.users.name} (${p.users.phone_number})\n   ${date}${planStr}${amountStr}\n\n`;
        });
        await sendReply(from, msg);
        return res.sendStatus(200);
      }

      // STATS
      if (text.toLowerCase() === "stats") {
        const { count: totalUsers }      = await supabase.from("users").select("*", { count: "exact", head: true });
        const { count: premiumUsers }    = await supabase.from("users").select("*", { count: "exact", head: true }).eq("is_premium", true);
        const { count: totalLogs }       = await supabase.from("logs").select("*", { count: "exact", head: true });
        const { count: usersWithCity }   = await supabase.from("users").select("*", { count: "exact", head: true }).not("city", "is", null);
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { count: newUsersThisWeek } = await supabase.from("users").select("*", { count: "exact", head: true }).gte("created_at", oneWeekAgo);
        const { count: pendingCount }    = await supabase.from("payments").select("*", { count: "exact", head: true }).eq("status", "pending");

        await sendReply(from,
`📊 Car Logbook Stats

👥 Total users: ${totalUsers || 0}
⭐ Premium users: ${premiumUsers || 0}
🆕 New this week: ${newUsersThisWeek || 0}
📋 Total logs: ${totalLogs || 0}
💰 Pending payments: ${pendingCount || 0}
📍 Users with city: ${usersWithCity || 0}`
        );
        return res.sendStatus(200);
      }

      // BROADCAST
      if (text.toLowerCase().startsWith("broadcast ")) {
        const broadcastMessage = text.slice(10).trim();
        if (!broadcastMessage) { await sendReply(from, `Usage: broadcast <your message>`); return res.sendStatus(200); }

        const { data: allUsers } = await supabase.from("users").select("phone_number, name");
        if (!allUsers || !allUsers.length) { await sendReply(from, `No users to broadcast to.`); return res.sendStatus(200); }

        await sendReply(from, `📡 Sending broadcast to ${allUsers.length} users...`);
        let sent = 0, failed = 0;
        for (const u of allUsers) {
          try { await sendReply(u.phone_number, broadcastMessage); sent++; }
          catch (e) { console.error(`Broadcast failed for ${u.phone_number}:`, e.message); failed++; }
        }
        await sendReply(from, `✅ Broadcast complete.\nSent: ${sent}\nFailed: ${failed}`);
        return res.sendStatus(200);
      }

      // ── ADMIN: EWURA SET PRICES ─────────────────────────────────────────
      // Usage: ewura arusha 2973 2967 3042  |  ewura dar 2864 2858 2932
      if (text.toLowerCase().startsWith("ewura ") &&
          !text.toLowerCase().startsWith("ewura broadcast") &&
          !text.toLowerCase().startsWith("ewura status")) {

        const parts = text.trim().split(/\s+/);
        if (parts.length < 5) {
          await sendReply(from, `Usage: ewura <city> <petrol> <diesel> <kerosene>\n\nExamples:\newura arusha 2973 2967 3042\newura dar 2864 2858 2932`);
          return res.sendStatus(200);
        }

        const kerosene = parseInt(parts[parts.length - 1]);
        const diesel   = parseInt(parts[parts.length - 2]);
        const petrol   = parseInt(parts[parts.length - 3]);
        const cityRaw  = parts.slice(1, parts.length - 3).join(" ").toLowerCase().trim();

        const cityAliases = {
          "dar": "dar es salaam",
          "dares salaam": "dar es salaam",
          "dar es salaam": "dar es salaam",
          "arusha": "arusha",
          "dodoma": "dodoma",
          "mwanza": "mwanza",
          "mbeya": "mbeya",
          "moshi": "moshi",
          "tanga": "tanga"
        };
        const city = cityAliases[cityRaw] || cityRaw;

        if (isNaN(petrol) || isNaN(diesel) || isNaN(kerosene)) {
          await sendReply(from, `❌ Invalid prices. Last 3 values must be numbers.\n\nExample:\newura arusha 2973 2967 3042`);
          return res.sendStatus(200);
        }

        const nowDate = new Date();
        const monthKey = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, "0")}`;

        const { data: existing } = await supabase.from("fuel_prices").select("id").eq("month", monthKey).eq("city", city).single();

        if (existing) {
          await supabase.from("fuel_prices").update({ petrol, diesel, kerosene }).eq("id", existing.id);
        } else {
          await supabase.from("fuel_prices").insert({ month: monthKey, city, petrol, diesel, kerosene });
        }

        await sendReply(from,
          `✅ EWURA prices saved — ${city} (${monthKey})\n\nPetrol: ${petrol.toLocaleString()} TZS/L\nDiesel: ${diesel.toLocaleString()} TZS/L\nKerosene: ${kerosene.toLocaleString()} TZS/L\n\nWhen ready to send:\newura broadcast`
        );
        return res.sendStatus(200);
      }

      // ── ADMIN: EWURA STATUS ─────────────────────────────────────────────
      if (text.toLowerCase() === "ewura status") {
        const nowDate = new Date();
        const monthKey = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, "0")}`;
        const monthLabel = nowDate.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

        const { data: prices } = await supabase.from("fuel_prices").select("*").eq("month", monthKey).order("city");

        if (!prices || prices.length === 0) {
          await sendReply(from, `⛽ EWURA Status — ${monthLabel}\n\nNo prices entered yet.\n\nEnter prices:\newura arusha 2973 2967 3042`);
          return res.sendStatus(200);
        }

        let msg = `⛽ EWURA Prices — ${monthLabel}\n\n`;
        for (const p of prices) {
          msg += `📍 ${p.city.charAt(0).toUpperCase() + p.city.slice(1)}\n`;
          msg += `   Petrol: ${p.petrol?.toLocaleString()}\n`;
          msg += `   Diesel: ${p.diesel?.toLocaleString()}\n`;
          msg += `   Kerosene: ${p.kerosene?.toLocaleString()}\n\n`;
        }
        msg += `To broadcast:\newura broadcast`;
        await sendReply(from, msg);
        return res.sendStatus(200);
      }

      // ── ADMIN: EWURA BROADCAST ──────────────────────────────────────────
      if (text.toLowerCase() === "ewura broadcast") {
        const nowDate = new Date();
        const monthKey = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, "0")}`;
        const monthLabel = nowDate.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

        const { data: prices } = await supabase.from("fuel_prices").select("*").eq("month", monthKey);

        if (!prices || prices.length === 0) {
          await sendReply(from, `❌ No EWURA prices entered for ${monthLabel}.\n\nEnter prices first:\newura arusha 2973 2967 3042`);
          return res.sendStatus(200);
        }

        // Build price map
        const priceMap = {};
        for (const p of prices) priceMap[p.city.toLowerCase().trim()] = p;

        // National highlights (first 5 cities entered)
        const highlights = prices.slice(0, 5).map(p =>
          `📍 ${p.city.charAt(0).toUpperCase() + p.city.slice(1)}: Petrol ${p.petrol?.toLocaleString()} | Diesel ${p.diesel?.toLocaleString()}`
        ).join("\n");

        const { data: allUsers } = await supabase.from("users").select("*");
        await sendReply(from, `📡 Sending EWURA broadcast to ${allUsers?.length || 0} users...`);

        let sent = 0, failed = 0;

        for (const u of allUsers || []) {
          try {
            const userCity = u.city ? u.city.toLowerCase().trim() : null;
            const cityPrice = userCity ? priceMap[userCity] : null;

            let msg = `⛽ EWURA Fuel Prices — ${monthLabel}\n\n`;

            if (cityPrice) {
              msg += `📍 ${u.city}\n`;
              msg += `Petrol: ${cityPrice.petrol?.toLocaleString()} TZS/L\n`;
              msg += `Diesel: ${cityPrice.diesel?.toLocaleString()} TZS/L\n`;
              msg += `Kerosene: ${cityPrice.kerosene?.toLocaleString()} TZS/L\n`;
            } else {
              msg += `${highlights}\n`;
              if (!userCity) {
                msg += `\n📍 Set your city for local prices:\nmy city Arusha`;
              }
            }

            msg += `\n─────────────────\nSource: EWURA Tanzania\nEffective: ${monthLabel}`;

            await sendReply(u.phone_number, msg);
            sent++;
          } catch (e) {
            console.error(`EWURA broadcast failed for ${u.phone_number}:`, e.message);
            failed++;
          }
        }

        await sendReply(from, `✅ EWURA broadcast complete.\nSent: ${sent}\nFailed: ${failed}`);
        return res.sendStatus(200);
      }

      // ── ADMIN: HELP ─────────────────────────────────────────────────────
      if (text.toLowerCase() === "admin help") {
        await sendReply(from,
`🛠 Admin Commands

Payments:
• approve 255X — monthly premium
• approve 255X annual — annual premium
• reject 255X — reject payment
• pending — list pending payments
• payments — last 10 approved

Users:
• user 255X — full user status
• downgrade 255X — remove premium
• extend 255X — add 1 month

Lookups:
• car T123ABC — car info + owner

Stats:
• stats — platform snapshot

Broadcast:
• broadcast <msg> — send to all users

EWURA:
• ewura <city> <p> <d> <k> — enter prices
• ewura status — see entered prices
• ewura broadcast — send to all users

Monthly cron:
• GET /cron/monthly?secret=... — send summaries`
        );
        return res.sendStatus(200);
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // USER COMMANDS
    // ─────────────────────────────────────────────────────────────────────

    const userCars = await getUserCars(user.id);

    // ── RESOLVE ACTIVE CAR ────────────────────────────────────────────────
    let carId = null;

    if (user.active_car_id) {
      carId = user.active_car_id;
    } else {
      const { data: carLink } = await supabase
        .from("car_users").select("car_id").eq("user_id", user.id).limit(1).single();
      carId = carLink?.car_id || null;
    }

    // ── DETECT CAR NAME IN MESSAGE ────────────────────────────────────────
    let detectedCars = [];
    userCars.forEach(car => {
      if (text.toLowerCase().includes(car.car_name)) detectedCars.push(car);
    });

    if (detectedCars.length > 1) {
      const options = detectedCars.map(car => `• ${car.car_name}`).join("\n");
      await sendReply(from, `I found a few cars in your message — which one did you mean?\n\n${options}\n\nTip: Include the car name clearly, e.g:\nfuel 40k rav4`);
      return res.sendStatus(200);
    }

    if (detectedCars.length === 1) carId = detectedCars[0].id;

    // ── MY CITY ───────────────────────────────────────────────────────────
    if (text.toLowerCase().startsWith("my city ")) {
      const newCity = text.slice(8).trim();

      if (!newCity) {
        await sendReply(from, `Please include your city name.\n\nExample:\nmy city Arusha`);
        return res.sendStatus(200);
      }

      // Already has a city → premium to change
      if (user.city && PREMIUM_ENABLED && !isPremium(user)) {
        await sendReply(from,
          `⭐ Changing your city is a Premium feature.\n\nYour current city: ${user.city}\n\nUpgrade to update it: upgrade`
        );
        return res.sendStatus(200);
      }

      await supabase.from("users").update({ city: newCity }).eq("id", user.id);
      await sendReply(from, `✅ City updated to ${newCity}.\n\nI'll now show you local fuel prices and city-specific updates.`);
      return res.sendStatus(200);
    }

    // ── ONBOARDING: CITY STEP ─────────────────────────────────────────────
    if (user.onboarding_step === "awaiting_city") {
      const lower = text.toLowerCase().trim();

      if (lower === "skip") {
        await supabase.from("users").update({ onboarding_step: "awaiting_fuel_type" }).eq("id", user.id);
        await sendReply(from,
          `No problem!\n\nOne more quick question:\n\n⛽ What fuel does your car use?\n\nReply: petrol or diesel\n\n(or "skip" to skip)`
        );
        return res.sendStatus(200);
      }

      await supabase.from("users").update({ city: text.trim(), onboarding_step: "awaiting_fuel_type" }).eq("id", user.id);
      await sendReply(from,
        `✅ Got it — ${text.trim()}!\n\nOne more quick question:\n\n⛽ What fuel does your car use?\n\nReply: petrol or diesel\n\n(or "skip" to skip)`
      );
      return res.sendStatus(200);
    }

    // ── ONBOARDING: FUEL TYPE STEP ────────────────────────────────────────
    if (user.onboarding_step === "awaiting_fuel_type") {
      const lower = text.toLowerCase().trim();
      const fuelType = (lower === "petrol" || lower === "diesel") ? lower : null;

      await supabase.from("users").update({ onboarding_step: null }).eq("id", user.id);

      if (fuelType && carId) {
        await supabase.from("cars").update({ fuel_type: fuelType }).eq("id", carId);
      }

      const fuelMsg = fuelType ? `Fuel type saved: ${fuelType}.` : `No problem, you can always update this later.`;

      await sendReply(from,
        `✅ ${fuelMsg}\n\nYou're all set! Here's how to get started:\n\n⛽ fuel 40k\n🔧 oil change 120k\n📏 mileage 30402\n📒 history\n\nType "help" anytime.`
      );
      return res.sendStatus(200);
    }

    // ── START ─────────────────────────────────────────────────────────────
    if (text.toLowerCase() === "start") {
      await sendReply(from,
        `🚗 Car Logbook\n\nHey ${user.name}! Here's what you can do:\n\n⛽ Log fuel → fuel 40k\n🔧 Log maintenance → oil change 120k\n📏 Log mileage → mileage 30402\n📒 View history → history\n🚗 View your cars → cars\n➕ Add a new car → add car\n\nType "help" anytime you need a reminder.\n💬 Have feedback? feedback <your message>`
      );
      return res.sendStatus(200);
    }

    // ── GREETINGS ─────────────────────────────────────────────────────────
    const greetings = ["hi", "hello", "hey", "mambo"];

    if (greetings.includes(text.toLowerCase())) {
      const hasCars = userCars.length > 0;
      if (!hasCars) {
        await sendReply(from,
          `👋 Hey ${user.name}! Good to have you here.\n\nIt looks like you haven't added a car yet. Let's fix that!\n\nWhat's your car's plate number?\n\nExample: T123ABC`
        );
      } else {
        await sendReply(from,
          `👋 Hey ${user.name}! Ready to log something?\n\n⛽ fuel 40k\n🔧 oil change 120k\n📏 mileage 30402\n📒 history\n\nType "help" to see all commands.`
        );
      }
      return res.sendStatus(200);
    }

    // ── HELP ──────────────────────────────────────────────────────────────
    if (text.toLowerCase() === "help") {
      await sendReply(from,
`🚗 Car Logbook — Quick Guide

Logging:
⛽ fuel 40k
🔧 oil change 120k
🔧 air cleaner 30k
🔧 battery 80k
🔧 tyre 150k
📏 mileage 30402
💰 insurance 1.2M

History:
📒 history
📒 history 10 ${PREMIUM_ENABLED ? "(Premium)" : ""}
📒 history month ${PREMIUM_ENABLED ? "(Premium)" : ""}
📒 history rav4 ${PREMIUM_ENABLED ? "(Premium)" : ""}

Cars:
🚗 cars → your registered cars
➕ add car → register a new car ${PREMIUM_ENABLED ? "(Premium after 1st car)" : ""}
🔄 switch to rav4 → change active car

Settings:
📍 my city Arusha → local fuel prices ${PREMIUM_ENABLED ? "(free to set, Premium to change)" : ""}

Other:
↩️ undo → remove last log
⭐ upgrade → go Premium
💬 feedback <message> → send us feedback

Tip: Just type what you did naturally — I'll figure out the rest!`
      );
      return res.sendStatus(200);
    }

    // ── FEEDBACK ──────────────────────────────────────────────────────────
    if (text.toLowerCase().startsWith("feedback ")) {
      const feedbackMessage = text.slice(9).trim();

      if (!feedbackMessage) {
        await sendReply(from, `Please include your message after "feedback".\n\nExample:\nfeedback the bot didn't understand my message`);
        return res.sendStatus(200);
      }

      await supabase.from("feedback").insert({ user_id: user.id, message: feedbackMessage });
      await sendReply(ADMIN_PHONE,
        `💬 User Feedback\n\nUser: ${user.name}\nPhone: ${from}\n\nMessage:\n${feedbackMessage}`
      );
      await sendReply(from, `Thanks for the feedback, ${user.name}! 🙏\n\nWe read every message and use it to make Car Logbook better.`);
      return res.sendStatus(200);
    }

    // ── UPGRADE ───────────────────────────────────────────────────────────
    if (text.toLowerCase() === "upgrade") {
      if (isActivePremiumUser(user)) {
        const expiryDate = user.premium_until
          ? new Date(user.premium_until).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
          : null;
        const planLabel = user.premium_plan === "annual" ? "Annual" : "Monthly";

        await sendReply(from,
          `⭐ You're already a Premium user!\n\nYour Premium features are active:\n• Multiple cars\n• Full history access\n• More coming soon\n${expiryDate ? `\nPlan: ${planLabel}\nRenews on: ${expiryDate}` : ""}\nThank you for supporting Car Logbook! 🙏`
        );
      } else {
        await sendReply(from,
`⭐ Car Logbook Premium

Monthly: 5,000 TZS/month
Annual: 50,000 TZS/year (save 10,000 TZS)

What you get:
✅ Multiple cars
✅ Full history (last 10, monthly, per car)
✅ Insurance expiry reminders
✅ Monthly expense summary
✅ City-specific fuel prices
✅ More features coming soon

─────────────────
How to upgrade:

1. Send payment via M-Pesa:

   Number: ${process.env.MPESA_NUMBER || "XXXXXXX"}
   Name: Car Logbook

2. After paying, send:
   paid <transaction_id>

   Or paste your full SMS and I'll find the ID.

   Example:
   paid QHG72K3
─────────────────

Questions? contact@carlogbook.app`
        );
      }
      return res.sendStatus(200);
    }

    // ── PAID ──────────────────────────────────────────────────────────────
    if (text.toLowerCase().startsWith("paid ")) {
      const rawText = text.slice(5).trim();
      let txnId = null;
      const words = rawText.split(" ");

      if (words.length <= 2) {
        txnId = words[0].trim().toUpperCase();
      } else {
        const extracted = await extractTransactionId(rawText);
        if (extracted) {
          txnId = extracted.toUpperCase();
        } else {
          await sendReply(from,
            `I couldn't find a transaction ID in that message.\n\nPlease send just the transaction ID:\n\npaid QHG72K3\n\nOr contact us at contact@carlogbook.app if you need help.`
          );
          return res.sendStatus(200);
        }
      }

      if (!txnId) {
        await sendReply(from, `Please include your transaction ID.\n\nExample:\npaid QHG72K3`);
        return res.sendStatus(200);
      }

      const { data: existingPending } = await supabase
        .from("payments").select("*").eq("user_id", user.id).eq("status", "pending").single();

      if (existingPending) {
        await sendReply(from,
          `You already have a pending payment (${existingPending.transaction_id}).\n\nWe'll notify you once it's verified. This usually takes a few hours.\n\nMade a mistake? Type: cancel payment\n\nQuestions? contact@carlogbook.app`
        );
        return res.sendStatus(200);
      }

      const { data: duplicateTxn } = await supabase.from("payments").select("*").eq("transaction_id", txnId).single();

      if (duplicateTxn) {
        await sendReply(from, `⚠️ That transaction ID has already been submitted.\n\nIf you think this is a mistake, contact us at:\ncontact@carlogbook.app`);
        await sendReply(ADMIN_PHONE,
          `⚠️ Duplicate Transaction ID Alert\n\nUser: ${user.name}\nPhone: ${from}\nTransaction ID: ${txnId}\n\nThis ID was already used. Do NOT approve without verifying.`
        );
        return res.sendStatus(200);
      }

      await supabase.from("payments").insert({ user_id: user.id, transaction_id: txnId, status: "pending" });
      await sendReply(from,
        `✅ Got it! Your payment is being verified.\n\nTransaction ID: ${txnId}\n\nYou'll receive a confirmation message shortly.\n\nMade a mistake? Type: cancel payment\n\nQuestions? contact@carlogbook.app`
      );
      await sendReply(ADMIN_PHONE,
        `💰 Premium Payment Request\n\nUser: ${user.name}\nPhone: ${from}\nTransaction ID: ${txnId}\n\nTo approve:\napprove ${from}\n\nTo reject:\nreject ${from}`
      );
      return res.sendStatus(200);
    }

    // ── CARS ──────────────────────────────────────────────────────────────
    if (text.toLowerCase() === "cars") {
      const cars = await getUserCars(user.id);

      if (!cars.length) {
        await sendReply(from, `🚗 You haven't added any cars yet.\n\nSend your plate number to get started.\n\nExample: T123ABC`);
      } else {
        let messageText = "🚗 Your Cars\n\n";

        for (const car of cars) {
          const isActive = car.id === carId;

          const { data: lastFuel } = await supabase.from("logs").select("amount, created_at")
            .eq("car_id", car.id).eq("type", "fuel").order("created_at", { ascending: false }).limit(1).single();
          const { data: lastMileage } = await supabase.from("logs").select("mileage, created_at")
            .eq("car_id", car.id).eq("type", "mileage").order("created_at", { ascending: false }).limit(1).single();
          const { count: totalLogs } = await supabase.from("logs")
            .select("*", { count: "exact", head: true }).eq("car_id", car.id);

          messageText += `${isActive ? "▶" : "•"} ${car.car_name} — ${car.plate_number}${isActive ? " (active)" : ""}\n`;
          if (lastMileage) messageText += `   📏 ${lastMileage.mileage?.toLocaleString()} km\n`;
          if (lastFuel) {
            const fuelDate = new Date(lastFuel.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
            messageText += `   ⛽ ${lastFuel.amount?.toLocaleString()} TZS (${fuelDate})\n`;
          }
          if (totalLogs > 0) messageText += `   📋 ${totalLogs} log${totalLogs === 1 ? "" : "s"} total\n`;
          messageText += "\n";
        }

        messageText += `To log against a specific car:\nfuel 40k rav4\n\nTo switch active car:\nswitch to rav4\n\n➕ Add another car: add car`;
        await sendReply(from, messageText);
      }
      return res.sendStatus(200);
    }

    // ── ADD CAR ───────────────────────────────────────────────────────────
    if (text.toLowerCase() === "add car") {
      if (PREMIUM_ENABLED && userCars.length >= 1 && !isPremium(user)) {
        await sendReply(from,
          `⭐ Adding multiple cars is a Premium feature.\n\nYou're currently on the free plan which includes 1 car.\n\nUpgrade for 5,000 TZS/month to add unlimited cars.\n\nType: upgrade`
        );
        return res.sendStatus(200);
      }

      await supabase.from("users").update({ pending_plate: "AWAITING" }).eq("id", user.id);
      await sendReply(from, `➕ Let's add a new car.\n\nWhat's the plate number?\n\nExample: T456DEF`);
      return res.sendStatus(200);
    }

    // ── SWITCH ACTIVE CAR ─────────────────────────────────────────────────
    const switchPhrases = ["switch to ", "use ", "change to "];
    const switchMatch = switchPhrases.find(p => text.toLowerCase().startsWith(p));

    if (switchMatch) {
      if (PREMIUM_ENABLED && !isPremium(user)) {
        await sendReply(from, `⭐ Switching between cars is a Premium feature.\n\nType: upgrade`);
        return res.sendStatus(200);
      }

      const carName = text.toLowerCase().replace(switchMatch, "").trim();
      const matchedCar = userCars.find(car => car.car_name === carName);

      if (!matchedCar) {
        let notFoundReply = `I couldn't find a car named "${carName}".\n\nYour cars:\n`;
        userCars.forEach(car => { notFoundReply += `• ${car.car_name}\n`; });
        notFoundReply += `\nExample:\nswitch to rav4`;
        await sendReply(from, notFoundReply);
        return res.sendStatus(200);
      }

      await setActiveCar(user.id, matchedCar.id);
      await sendReply(from,
        `✅ Active car switched to ${matchedCar.car_name}.\n\nLogs will now go to ${matchedCar.car_name} by default.\n\nTo log:\nfuel 40k\nmileage 30402`
      );
      return res.sendStatus(200);
    }

    // ── UNDO ──────────────────────────────────────────────────────────────
    if (text.toLowerCase() === "undo") {
      if (!carId) {
        await sendReply(from, `Hmm, I couldn't find a car to undo a log for.\n\nMake sure you have a car registered:\ncars`);
        return res.sendStatus(200);
      }

      if (PREMIUM_ENABLED && !isPremium(user)) {
        const allowed = await checkLimit(user.id, "undo_count");
        if (!allowed) {
          await sendReply(from, `You've used your 3 undos for today — the limit resets tomorrow.\n\nUpgrade for unlimited undos:\nupgrade`);
          return res.sendStatus(200);
        }
        await incrementUsage(user.id, "undo_count");
      }

      const deleted = await deleteLastLog(carId);
      await sendReply(from, deleted
        ? `↩️ Done! Your last log has been removed.`
        : `Nothing to undo — there are no logs yet for this car.`
      );
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
          await sendReply(from,
            `⭐ This is a Premium feature.\n\nExtended history and per-car history are available on Premium.\n\nType: upgrade`
          );
          return res.sendStatus(200);
        }
      }

      if (PREMIUM_ENABLED && !isPremium(user)) {
        const allowed = await checkLimit(user.id, "history_count");
        if (!allowed) {
          await sendReply(from,
            `You've checked your history 3 times today — the limit resets tomorrow.\n\nUpgrade for unlimited history access:\nupgrade`
          );
          return res.sendStatus(200);
        }
        await incrementUsage(user.id, "history_count");
      }

      if (historyCarName) {
        const matchedCar = userCars.find(car => car.car_name === historyCarName);
        if (!matchedCar) {
          let notFoundReply = `I couldn't find a car named "${historyCarName}".\n\nYour cars:\n`;
          userCars.forEach(car => { notFoundReply += `• ${car.car_name}\n`; });
          notFoundReply += `\nTry: history ${userCars[0]?.car_name || "rav4"}`;
          await sendReply(from, notFoundReply);
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
        const historyLimit = (PREMIUM_ENABLED && !isPremium(user)) ? 3 : 5;
        logs = await getRecentLogs(carId, historyLimit);
      }

      const activeCar = userCars.find(car => car.id === carId);
      const activeCarName = activeCar ? activeCar.car_name : "your car";

      if (!logs.length) {
        await sendReply(from, `📒 No logs found for ${activeCarName}${command === "month" ? " this month" : ""}.\n\nStart logging:\nfuel 40k`);
      } else {
        let messageText = `📒 ${activeCarName} — Recent Logs\n\n`;

        logs.forEach(log => {
          const formattedDate = new Date(log.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
          let line = "";
          if (log.type === "fuel") line = `⛽ Fuel — ${log.amount?.toLocaleString()} TZS`;
          else if (log.type === "maintenance") {
            const label = log.subtype ? subtypeLabel(log.subtype) : null;
            line = `🔧 ${label || "Maintenance"} — ${log.amount?.toLocaleString()} TZS`;
          } else if (log.type === "mileage") line = `📏 Mileage — ${log.mileage?.toLocaleString()} km`;
          else if (log.type === "insurance") line = `💰 Insurance — ${log.amount?.toLocaleString()} TZS`;
          else line = `💸 ${log.description}`;

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
          otherCars.forEach(car => { messageText += `history ${car.car_name} → ${car.car_name} logs\n`; });
        }

        await sendReply(from, messageText);
      }
      return res.sendStatus(200);
    }

    // ── INSURANCE EXPIRY ──────────────────────────────────────────────────
    if (text.toLowerCase().startsWith("insurance expiry ")) {
      if (!carId) {
        await sendReply(from, `You need to have a car registered to set an insurance expiry date.\n\nType: cars`);
        return res.sendStatus(200);
      }

      const datePart = text.slice(17).trim();
      const parsed = new Date(datePart);

      if (isNaN(parsed.getTime())) {
        await sendReply(from, `I couldn't read that date. Please use a clear format.\n\nExamples:\ninsurance expiry 15 Aug 2026\ninsurance expiry 2026-08-15`);
        return res.sendStatus(200);
      }

      const expiryDate = parsed.toISOString().split("T")[0];
      const { data: existing } = await supabase.from("car_insurance").select("id").eq("car_id", carId).single();

      if (existing) {
        await supabase.from("car_insurance").update({
          expiry_date: expiryDate, notified_30d: false, notified_7d: false, notified_1d: false
        }).eq("car_id", carId);
      } else {
        await supabase.from("car_insurance").insert({ car_id: carId, expiry_date: expiryDate });
      }

      const activeCar = userCars.find(car => car.id === carId);
      const carName = activeCar ? activeCar.car_name : "your car";
      const displayDate = parsed.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

      await sendReply(from,
        `✅ Insurance expiry saved for ${carName}.\n\nExpiry date: ${displayDate}${PREMIUM_ENABLED && !isPremium(user)
          ? "\n\nReminders at 30, 7, and 1 day before expiry are a Premium feature.\n\nType: upgrade"
          : "\n\nI'll remind you 30 days, 7 days, and 1 day before it expires."}`
      );
      return res.sendStatus(200);
    }

    // ── PLATE NUMBER DETECTED ─────────────────────────────────────────────
    if (isPlateNumber(text)) {
      const plate = text.trim().replace(/\s+/g, "").toUpperCase();
      await supabase.from("users").update({ pending_plate: plate }).eq("id", user.id);
      await sendReply(from, `Got it — ${plate} ✅\n\nWhat would you like to call this car?\n\nExamples:\nRav4\nDad's car\nWork car`);
      return res.sendStatus(200);
    }

    // ── MILEAGE LOG ───────────────────────────────────────────────────────
    if (isMileage(text) && carId) {
      const mileage = extractMileage(text);

      if (mileage) {
        if (PREMIUM_ENABLED && !isPremium(user)) {
          const allowed = await checkLimit(user.id, "log_count");
          if (!allowed) {
            await sendReply(from, `You've reached today's free limit of 10 logs — the limit resets tomorrow.\n\nUpgrade for unlimited logging:\nupgrade`);
            return res.sendStatus(200);
          }
          await incrementUsage(user.id, "log_count");
        }

        // Check if first mileage log for baseline prompt
        const { count: mileageCount } = await supabase
          .from("logs").select("*", { count: "exact", head: true })
          .eq("car_id", carId).eq("type", "mileage");

        await saveLog(carId, "mileage", null, `Mileage ${mileage}`, mileage);
        reply = `📏 Mileage logged — ${mileage.toLocaleString()} km`;

        if (mileageCount === 0) {
          reply += `\n\n📌 Tip: Keep logging mileage regularly and I'll track your total km driven each month in your monthly summary.`;
        }
      }

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── CAR NAME STEP (after plate number entered) ────────────────────────
    if (user.pending_plate && user.pending_plate !== "AWAITING") {
      const carName = text.trim().toLowerCase();
      const plate = user.pending_plate;

      const { data: existingName } = await supabase
        .from("car_users").select(`car_id, cars (car_name)`).eq("user_id", user.id);

      const nameExists = existingName?.some(row => row.cars.car_name === carName);

      if (nameExists) {
        await sendReply(from,
          `You already have a car named "${carName}".\n\nPlease choose a different name.\n\nExamples:\n${carName} 2\nwork ${carName}`
        );
        return res.sendStatus(200);
      }

      const { data: existingPlate } = await supabase.from("cars").select("plate_number").eq("plate_number", plate).single();

      if (existingPlate) {
        await sendReply(from, `⚠️ That plate number is already registered in the system.\n\nIf this is your car, contact us at contact@carlogbook.app to claim ownership.`);
        await supabase.from("users").update({ pending_plate: null }).eq("id", user.id);
        return res.sendStatus(200);
      }

      const car = await registerCar(user.id, plate, carName);

      if (userCars.length === 0) await setActiveCar(user.id, car.id);

      await supabase.from("users").update({ pending_plate: null }).eq("id", user.id);

      const isFirstCar = userCars.length === 0;

      if (isFirstCar) {
        // Start city onboarding
        await supabase.from("users").update({ onboarding_step: "awaiting_city" }).eq("id", user.id);

        await sendReply(from,
`🎉 ${carName} (${plate}) added!

Quick setup — which city are you in?

This helps me show you local fuel prices each month.

Reply with your city (e.g. Arusha, Dar es Salaam, Mwanza)

Or type "skip" to skip.`
        );
      } else {
        await sendReply(from,
          `✅ ${carName} (${plate}) has been added to your logbook.\n\nTo switch to this car:\nswitch to ${carName}`
        );
      }
      return res.sendStatus(200);
    }

    // ── AWAITING PLATE ────────────────────────────────────────────────────
    if (user.pending_plate === "AWAITING") {
      if (!isPlateNumber(text)) {
        await sendReply(from,
          `That doesn't look like a valid plate number.\n\nTanzanian plates look like: T123ABC\n\nPlease try again or type "cancel" to go back.`
        );
        return res.sendStatus(200);
      }

      const plate = text.trim().replace(/\s+/g, "").toUpperCase();
      await supabase.from("users").update({ pending_plate: plate }).eq("id", user.id);
      await sendReply(from, `Got it — ${plate} ✅\n\nWhat would you like to call this car?\n\nExamples:\nPremio\nWork car\nDad's car`);
      return res.sendStatus(200);
    }

    // ── EXPENSE LOG ───────────────────────────────────────────────────────
    const amount = parseAmount(text);
    const { type, subtype } = detectType(text);

    if (amount && carId && looksLikeLog(text)) {
      if (PREMIUM_ENABLED && !isPremium(user)) {
        const allowed = await checkLimit(user.id, "log_count");
        if (!allowed) {
          await sendReply(from, `You've reached today's free limit of 10 logs — the limit resets tomorrow.\n\nUpgrade for unlimited logging:\nupgrade`);
          return res.sendStatus(200);
        }
        await incrementUsage(user.id, "log_count");
      }

      const { count } = await supabase.from("logs").select("*", { count: "exact", head: true }).eq("car_id", carId);

      await saveLog(carId, type, amount, text, null, subtype);

      const isFirstLog = count === 0;

      if (isFirstLog) {
        reply = `🎉 First log saved — you're off to a great start!\n\nKeep going:\n⛽ fuel 40k\n🔧 oil change 120k\n📏 mileage 30402\n📒 history`;
      } else {
        const carUsed = userCars.find(car => car.id === carId);
        const carName = carUsed ? carUsed.car_name : "your car";

        let typeLabel = "Expense";
        if (type === "fuel") typeLabel = "Fuel";
        else if (type === "insurance") typeLabel = "Insurance";
        else if (type === "maintenance") {
          typeLabel = subtype ? (subtypeLabel(subtype) || "Maintenance") : "Maintenance";
        }

        const isMilestone = count > 0 && (count + 1) % 10 === 0;

        if (isMilestone) {
          reply = `✅ Log saved\n\nCar: ${carName}\n${typeLabel}: ${amount.toLocaleString()} TZS\n\n🙌 ${count + 1} logs and counting — great job staying on top of your car expenses!\n\n💬 Enjoying Car Logbook? We'd love to hear from you:\nfeedback <your message>`;
        } else {
          reply = `✅ Log saved\n\nCar: ${carName}\n${typeLabel}: ${amount.toLocaleString()} TZS`;
        }

        // Post-insurance expiry prompt
        if (type === "insurance") {
          const { data: existingInsurance } = await supabase.from("car_insurance").select("id").eq("car_id", carId).single();
          if (!existingInsurance) {
            reply += `\n\nWould you like to set a reminder for when it expires?\n\nJust send the date:\ninsurance expiry 15 Aug 2026`;
          }
        }
      }

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── AI SMART FALLBACK ─────────────────────────────────────────────────
    const aiReply = await getAIFallbackReply(text, userCars);

    await sendReply(from, aiReply ||
      `Hmm, I didn't quite get that. 🤔\n\nHere are some things you can try:\n\n⛽ fuel 40k\n🔧 oil change 120k\n📏 mileage 30402\n📒 history\n🚗 cars\n\nOr type "help" for the full guide.\n\n💬 Something not working as expected?\nfeedback <your message>`
    );
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