const express = require("express");
const router = express.Router();

const supabase = require("../config/supabase");
const { getOrCreateUser } = require("../services/userService");
const { registerCar, getUserCars, setActiveCar } = require("../services/carService");
const { saveLog, getRecentLogs, getLogsThisMonth, deleteLastLog } = require("../services/logService");
const { parseAmount, detectType, looksLikeLog } = require("../utils/parser");
const { sendReply } = require("../utils/sendReply");
const { checkLimit, incrementUsage } = require("../services/usageService");
const { extractTransactionId, getAIFallbackReply } = require("../utils/ai");
const { handleAdminCommand } = require("./admin");
const {
  isPremium, isActivePremiumUser, subtypeLabel,
  isPlateNumber, isMileage, extractMileage
} = require("../utils/helpers");
const { ADMIN_PHONE, PREMIUM_ENABLED, MPESA_NUMBER } = require("../config/constants");

// ─── WEBHOOK VERIFICATION ─────────────────────────────────────────────────────

router.get("/", (req, res) => {
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

// ─── INCOMING MESSAGES ────────────────────────────────────────────────────────

router.post("/", async (req, res) => {
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
      const handled = await handleAdminCommand(from, text);
      if (handled) return res.sendStatus(200);
      // If not handled, fall through to user commands (admin is also a user)
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

    // ── REMINDERS COMMAND ─────────────────────────────────────────────────
    if (text.toLowerCase().startsWith("reminders ")) {
      const option = text.toLowerCase().split(" ")[1]?.trim();
      const validOptions = {
        "weekly":      "7days",
        "fortnightly": "14days",
        "monthly":     "30days",
        "off":         "off"
      };

      if (!validOptions[option]) {
        await sendReply(from,
          `To set your reminder frequency, reply with one of:\n\nreminders weekly\nreminders fortnightly\nreminders monthly\nreminders off`
        );
        return res.sendStatus(200);
      }

      await supabase.from("users").update({ reminder_frequency: validOptions[option] }).eq("id", user.id);

      const confirmMsg = option === "off"
        ? `🔕 Got it — no more logging reminders.\n\nYou can turn them back on anytime:\nreminders weekly`
        : `✅ Reminders set to ${option}.\n\nI'll nudge you if you haven't logged anything in ${option === "weekly" ? "7 days" : option === "fortnightly" ? "14 days" : "30 days"}.`;

      await sendReply(from, confirmMsg);
      return res.sendStatus(200);
    }

    // ── MY CITY ───────────────────────────────────────────────────────────
    if (text.toLowerCase().startsWith("my city ")) {
      const newCity = text.slice(8).trim();

      if (!newCity) {
        await sendReply(from, `Please include your city name.\n\nExample:\nmy city Arusha`);
        return res.sendStatus(200);
      }

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
🔔 reminders weekly / monthly / off → logging reminders

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

   Number: ${MPESA_NUMBER}
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

        const { count: mileageCount } = await supabase
          .from("logs").select("*", { count: "exact", head: true })
          .eq("car_id", carId).eq("type", "mileage");

        await saveLog(carId, "mileage", null, `Mileage ${mileage}`, mileage);
        await supabase.from("users").update({ last_log_at: new Date().toISOString() }).eq("id", user.id);

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
      await supabase.from("users").update({ last_log_at: new Date().toISOString() }).eq("id", user.id);

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
    const aiReply = await getAIFallbackReply(text, userCars, user.id);

    await sendReply(from, aiReply ||
      `Hmm, I didn't quite get that. 🤔\n\nHere are some things you can try:\n\n⛽ fuel 40k\n🔧 oil change 120k\n📏 mileage 30402\n📒 history\n🚗 cars\n\nOr type "help" for the full guide.\n\n💬 Something not working as expected?\nfeedback <your message>`
    );
    res.sendStatus(200);

  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(200);
  }
});

module.exports = router;