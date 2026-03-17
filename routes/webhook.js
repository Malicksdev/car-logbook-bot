const express = require("express");
const router = express.Router();

const supabase = require("../config/supabase");
const { getOrCreateUser } = require("../services/userService");
const { registerCar, getUserCars, setActiveCar } = require("../services/carService");
const { saveLog, getRecentLogs, getLogsThisMonth, deleteLastLog } = require("../services/logService");
const { parseAmount, detectType, looksLikeLog } = require("../utils/parser");
const { sendReply } = require("../utils/sendReply");
const { checkLimit, incrementUsage } = require("../services/usageService");
const { extractTransactionId, getAIFallbackReply, analyzePhoto } = require("../utils/ai");
const { handleAdminCommand } = require("./admin");
const {
  isPremium, isActivePremiumUser, subtypeLabel,
  normalizeServiceType, serviceTypeLabel,
  isPlateNumber, isMileage, extractMileage,
  looksLikeSwahili, t
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

    // ── PHOTO MESSAGES ─────────────────────────────────────────────────────
    if (message.image) {
      const { user: photoUser } = await getOrCreateUser(
        from,
        body.entry[0].changes[0].value.contacts?.[0]?.profile?.name || "Friend"
      );

      if (PREMIUM_ENABLED && !isPremium(photoUser)) {
        await sendReply(from, t(photoUser, "photo_premium_required"));
        return res.sendStatus(200);
      }

      let photoCarId = photoUser.active_car_id;
      if (!photoCarId) {
        const { data: carLink } = await supabase
          .from("car_users").select("car_id").eq("user_id", photoUser.id).limit(1).single();
        photoCarId = carLink?.car_id || null;
      }

      if (!photoCarId) {
        await sendReply(from, t(photoUser, "photo_no_car"));
        return res.sendStatus(200);
      }

      await sendReply(from, t(photoUser, "photo_analyzing"));

      const imageId = message.image.id;
      const mimeType = message.image.mime_type || "image/jpeg";
      const analysis = await analyzePhoto(imageId, mimeType);

      await supabase.from("users").update({
        pending_photo: {
          service_type: analysis.service_type,
          subtype: analysis.subtype,
          description: analysis.description,
          confidence: analysis.confidence,
          car_id: photoCarId
        }
      }).eq("id", photoUser.id);

      await sendReply(from, `${analysis.prompt}\n\nOr type "cancel" to skip.`);
      return res.sendStatus(200);
    }

    if (!message.text) return res.sendStatus(200);

    const text = message.text.body.trim();
    const lower = text.toLowerCase();
    console.log("Incoming:", text);
    console.log("From:", from);

    const contactName =
      body.entry[0].changes[0].value.contacts?.[0]?.profile?.name || "Friend";

    const { user, isNewUser } = await getOrCreateUser(from, contactName);
    let reply = "";

    // ── BRAND NEW USER — language selection first ──────────────────────────
    if (isNewUser) {
      await supabase.from("users").update({ onboarding_step: "awaiting_language" }).eq("id", user.id);
      await sendReply(from,
        `👋 Welcome to Car Logbook! / Karibu Car Logbook!\n\nPlease choose your language / Tafadhali chagua lugha yako:\n\n1. English\n2. Kiswahili`
      );
      return res.sendStatus(200);
    }

    // ── ONBOARDING: LANGUAGE STEP ──────────────────────────────────────────
    // Also handles auto-detect for users who type before selecting language
    if (user.onboarding_step === "awaiting_language") {
      if (lower === "1" || lower === "english") {
        await supabase.from("users").update({ language: "en", onboarding_step: null }).eq("id", user.id);
        const updatedUser = { ...user, language: "en" };
        await sendReply(from, t(updatedUser, "language_set_en"));
        return res.sendStatus(200);
      }

      if (lower === "2" || lower === "kiswahili" || lower === "swahili") {
        await supabase.from("users").update({ language: "sw", onboarding_step: null }).eq("id", user.id);
        const updatedUser = { ...user, language: "sw" };
        await sendReply(from, t(updatedUser, "language_set_sw"));
        return res.sendStatus(200);
      }

      // Auto-detect Swahili before language is chosen
      if (looksLikeSwahili(text)) {
        await sendReply(from, t(user, "autodetect_swahili_prompt"));
        return res.sendStatus(200);
      }

      // Unrecognised input — re-prompt
      await sendReply(from, t(user, "language_invalid"));
      return res.sendStatus(200);
    }

    // ── CANCEL ────────────────────────────────────────────────────────────
    if (lower === "cancel" || lower === "ghairi") {
      await supabase.from("users").update({
        pending_plate: null,
        onboarding_step: null,
        pending_photo: null
      }).eq("id", user.id);
      await sendReply(from, t(user, "cancelled"));
      return res.sendStatus(200);
    }

    // ── PENDING PHOTO — awaiting amount confirmation ───────────────────────
    if (user.pending_photo) {
      const pending = user.pending_photo;
      const amount = parseAmount(text);

      if (!amount) {
        await sendReply(from, t(user, "photo_amount_prompt"));
        return res.sendStatus(200);
      }

      const logType = ["fuel", "insurance"].includes(pending.service_type)
        ? pending.service_type
        : "maintenance";

      const logSubtype = logType === "maintenance" ? pending.subtype : null;
      const logDescription = pending.description || text;
      const logCarId = pending.car_id;

      await saveLog(logCarId, logType, amount, logDescription, null, logSubtype);
      await supabase.from("users").update({
        pending_photo: null,
        last_log_at: new Date().toISOString()
      }).eq("id", user.id);

      const photoUserCars = await getUserCars(user.id);
      const carUsed = photoUserCars.find(c => c.id === logCarId);
      const carName = carUsed ? carUsed.car_name : "your car";
      const typeLabel = logType === "fuel" ? "Fuel"
        : logType === "insurance" ? "Insurance"
        : (logSubtype ? (subtypeLabel(logSubtype) || "Maintenance") : "Maintenance");

      await sendReply(from, t(user, "photo_logged", carName, typeLabel, amount, pending.description));
      return res.sendStatus(200);
    }

    // ── CANCEL PAYMENT ────────────────────────────────────────────────────
    if (lower === "cancel payment" || lower === "ghairi malipo") {
      const { data: pendingPayment } = await supabase
        .from("payments").select("*")
        .eq("user_id", user.id).eq("status", "pending").single();

      if (!pendingPayment) {
        await sendReply(from, t(user, "cancel_payment_none"));
        return res.sendStatus(200);
      }

      await supabase.from("payments").delete().eq("id", pendingPayment.id);
      await sendReply(from, t(user, "cancel_payment_success", pendingPayment.transaction_id));
      return res.sendStatus(200);
    }

    // ── ADMIN COMMANDS ────────────────────────────────────────────────────
    if (from === ADMIN_PHONE) {
      const handled = await handleAdminCommand(from, text);
      if (handled) return res.sendStatus(200);
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
      if (lower.includes(car.car_name)) detectedCars.push(car);
    });

    if (detectedCars.length > 1) {
      const options = detectedCars.map(car => `• ${car.car_name}`).join("\n");
      await sendReply(from, `${t(user, "multiple_cars_detected")}\n\n${options}`);
      return res.sendStatus(200);
    }

    if (detectedCars.length === 1) carId = detectedCars[0].id;

    // ── LANGUAGE COMMAND ──────────────────────────────────────────────────
    if (lower === "language" || lower === "lugha") {
      await supabase.from("users").update({ onboarding_step: "awaiting_language_switch" }).eq("id", user.id);
      await sendReply(from, t(user, "language_switch_prompt"));
      return res.sendStatus(200);
    }

    // ── LANGUAGE SWITCH STEP ──────────────────────────────────────────────
    if (user.onboarding_step === "awaiting_language_switch") {
      if (lower === "1" || lower === "english") {
        await supabase.from("users").update({ language: "en", onboarding_step: null }).eq("id", user.id);
        const updatedUser = { ...user, language: "en" };
        await sendReply(from, t(updatedUser, "language_switched_en"));
        return res.sendStatus(200);
      }

      if (lower === "2" || lower === "kiswahili" || lower === "swahili") {
        await supabase.from("users").update({ language: "sw", onboarding_step: null }).eq("id", user.id);
        const updatedUser = { ...user, language: "sw" };
        await sendReply(from, t(updatedUser, "language_switched_sw"));
        return res.sendStatus(200);
      }

      await sendReply(from, t(user, "language_invalid_switch"));
      return res.sendStatus(200);
    }

    // ── REMINDERS COMMAND ─────────────────────────────────────────────────
    // English: reminders weekly / fortnightly / monthly / off
    // Swahili: vikumbusho wiki / wiki mbili / mwezi / zima
    const reminderFreqMatch =
      lower.startsWith("reminders ") ? lower.slice(10).trim() :
      lower.startsWith("vikumbusho ") ? lower.slice(11).trim() :
      null;

    if (reminderFreqMatch !== null) {
      const validOptions = {
        "weekly":      "7days",
        "fortnightly": "14days",
        "monthly":     "30days",
        "off":         "off",
        "wiki":        "7days",
        "wiki mbili":  "14days",
        "mwezi":       "30days",
        "zima":        "off"
      };

      if (!validOptions[reminderFreqMatch]) {
        await sendReply(from, t(user, "reminder_frequency_invalid"));
        return res.sendStatus(200);
      }

      await supabase.from("users").update({ reminder_frequency: validOptions[reminderFreqMatch] }).eq("id", user.id);

      if (reminderFreqMatch === "off" || reminderFreqMatch === "zima") {
        await sendReply(from, t(user, "reminder_frequency_off"));
      } else {
        const dayLabels = {
          "weekly":     "7 days",  "fortnightly": "14 days", "monthly":   "30 days",
          "wiki":       "siku 7",  "wiki mbili":  "siku 14", "mwezi":     "mwezi mmoja"
        };
        await sendReply(from, t(user, "reminder_frequency_set", reminderFreqMatch, dayLabels[reminderFreqMatch]));
      }
      return res.sendStatus(200);
    }

    // ── REMIND (SERVICE INTERVAL) ─────────────────────────────────────────
    // English: remind oil change every 5000km
    // Swahili: kumbuka oil change kila 5000km
    const isRemindCommand = lower.startsWith("remind ") || lower.startsWith("kumbuka ");

    if (isRemindCommand) {
      if (PREMIUM_ENABLED && !isPremium(user)) {
        await sendReply(from, t(user, "service_reminder_premium_required"));
        return res.sendStatus(200);
      }

      if (!carId) {
        await sendReply(from, t(user, "service_reminder_no_car"));
        return res.sendStatus(200);
      }

      const match = text.match(/^(?:remind|kumbuka) (.+?) (?:every|kila) (\d+)\s*(km|days?|siku)$/i);

      if (!match) {
        await sendReply(from, t(user, "service_reminder_invalid_format"));
        return res.sendStatus(200);
      }

      const serviceRaw = match[1].trim();
      const intervalNum = parseInt(match[2]);
      const intervalUnitRaw = match[3].toLowerCase();
      const intervalUnit = (intervalUnitRaw.startsWith("day") || intervalUnitRaw === "siku") ? "days" : "km";
      const serviceKey = normalizeServiceType(serviceRaw);
      const label = serviceTypeLabel(serviceKey);

      const reminderData = {
        car_id: carId,
        service_type: serviceKey,
        interval_km:   intervalUnit === "km"   ? intervalNum : null,
        interval_days: intervalUnit === "days" ? intervalNum : null,
        last_serviced_at: new Date().toISOString(),
        last_serviced_km: null,
        notified_at: null
      };

      const { data: existingReminder } = await supabase
        .from("service_reminders").select("id")
        .eq("car_id", carId).eq("service_type", serviceKey).single();

      if (existingReminder) {
        await supabase.from("service_reminders").update(reminderData).eq("id", existingReminder.id);
      } else {
        await supabase.from("service_reminders").insert(reminderData);
      }

      const activeCar = userCars.find(c => c.id === carId);
      const intervalLabel = intervalUnit === "km"
        ? `every ${intervalNum.toLocaleString()} km`
        : `every ${intervalNum} days`;

      await sendReply(from, t(user, "service_reminder_set",
        label, activeCar?.car_name || "your car", intervalLabel, serviceRaw
      ));
      return res.sendStatus(200);
    }

    // ── REMINDERS LIST ────────────────────────────────────────────────────
    if (lower === "reminders list" || lower === "orodha ya vikumbusho") {
      if (!carId) {
        await sendReply(from, t(user, "reminders_list_no_car"));
        return res.sendStatus(200);
      }

      const { data: reminders } = await supabase
        .from("service_reminders").select("*")
        .eq("car_id", carId).order("created_at");

      const activeCar = userCars.find(c => c.id === carId);

      if (!reminders || reminders.length === 0) {
        await sendReply(from, t(user, "reminders_list_empty", activeCar?.car_name || "your car"));
        return res.sendStatus(200);
      }

      const isSw = user.language === "sw";
      let msg = `🔔 ${isSw ? "Vikumbusho vya Huduma" : "Service Reminders"} — ${activeCar?.car_name || "your car"}\n\n`;

      for (const r of reminders) {
        const label = serviceTypeLabel(r.service_type);
        const interval = r.interval_km
          ? `every ${r.interval_km.toLocaleString()} km`
          : `every ${r.interval_days} days`;
        const lastDone = r.last_serviced_at
          ? new Date(r.last_serviced_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
          : (isSw ? "Haijarekodiwa" : "Not recorded");
        msg += `🔧 ${label}\n   ${isSw ? "Muda" : "Interval"}: ${interval}\n   ${isSw ? "Mara ya mwisho" : "Last done"}: ${lastDone}\n\n`;
      }

      msg += t(user, "reminders_list_footer");
      await sendReply(from, msg);
      return res.sendStatus(200);
    }

    // ── REMINDERS CLEAR ───────────────────────────────────────────────────
    // English: reminders clear oil change
    // Swahili: futa kikumbusho oil change
    const remindersClearMatch =
      lower.startsWith("reminders clear ") ? text.slice(16).trim() :
      lower.startsWith("futa kikumbusho ") ? text.slice(16).trim() :
      null;

    if (remindersClearMatch !== null) {
      if (!carId) {
        await sendReply(from, t(user, "reminders_list_no_car"));
        return res.sendStatus(200);
      }

      const serviceKey = normalizeServiceType(remindersClearMatch);
      const label = serviceTypeLabel(serviceKey);

      const { data: existingReminder } = await supabase
        .from("service_reminders").select("id")
        .eq("car_id", carId).eq("service_type", serviceKey).single();

      if (!existingReminder) {
        await sendReply(from, t(user, "reminders_clear_not_found", label));
        return res.sendStatus(200);
      }

      await supabase.from("service_reminders").delete().eq("id", existingReminder.id);
      await sendReply(from, t(user, "reminders_clear_success", label));
      return res.sendStatus(200);
    }

    // ── MY CITY / JIJI LANGU ──────────────────────────────────────────────
    const isCityCommand = lower.startsWith("my city ") || lower.startsWith("jiji langu ");

    if (isCityCommand) {
      const newCity = lower.startsWith("my city ")
        ? text.slice(8).trim()
        : text.slice(11).trim();

      if (!newCity) {
        await sendReply(from, t(user, "city_missing"));
        return res.sendStatus(200);
      }

      if (user.city && PREMIUM_ENABLED && !isPremium(user)) {
        await sendReply(from, t(user, "city_premium_required", user.city));
        return res.sendStatus(200);
      }

      await supabase.from("users").update({ city: newCity }).eq("id", user.id);
      await sendReply(from, t(user, "city_updated", newCity));
      return res.sendStatus(200);
    }

    // ── ONBOARDING: CITY STEP ─────────────────────────────────────────────
    if (user.onboarding_step === "awaiting_city") {
      const skipWords = ["skip", "ruka"];

      if (skipWords.includes(lower)) {
        await supabase.from("users").update({ onboarding_step: "awaiting_fuel_type" }).eq("id", user.id);
        await sendReply(from, t(user, "onboarding_city_skipped"));
        return res.sendStatus(200);
      }

      await supabase.from("users").update({
        city: text.trim(),
        onboarding_step: "awaiting_fuel_type"
      }).eq("id", user.id);
      await sendReply(from, t(user, "onboarding_city_saved", text.trim()));
      return res.sendStatus(200);
    }

    // ── ONBOARDING: FUEL TYPE STEP ────────────────────────────────────────
    if (user.onboarding_step === "awaiting_fuel_type") {
      const fuelType = (lower === "petrol" || lower === "diesel") ? lower : null;

      await supabase.from("users").update({ onboarding_step: null }).eq("id", user.id);

      if (fuelType && carId) {
        await supabase.from("cars").update({ fuel_type: fuelType }).eq("id", carId);
      }

      const fuelMsg = fuelType
        ? t(user, "fuel_type_saved", fuelType)
        : t(user, "fuel_type_skipped");

      await sendReply(from, t(user, "onboarding_complete", fuelMsg));
      return res.sendStatus(200);
    }

    // ── START ─────────────────────────────────────────────────────────────
    if (lower === "start") {
      await sendReply(from, t(user, "start", user.name));
      return res.sendStatus(200);
    }

    // ── GREETINGS ─────────────────────────────────────────────────────────
    const greetings = ["hi", "hello", "hey", "mambo", "habari", "karibu", "sasa"];

    if (greetings.includes(lower)) {
      await sendReply(from, userCars.length > 0
        ? t(user, "greeting_with_car", user.name)
        : t(user, "greeting_no_car", user.name)
      );
      return res.sendStatus(200);
    }

    // ── HELP ──────────────────────────────────────────────────────────────
    if (lower === "help" || lower === "msaada") {
      await sendReply(from, t(user, "help", PREMIUM_ENABLED));
      return res.sendStatus(200);
    }

    // ── FEEDBACK ──────────────────────────────────────────────────────────
    // English: feedback <message>
    // Swahili: maoni <message>
    const isFeedback = lower.startsWith("feedback ") || lower.startsWith("maoni ");

    if (isFeedback) {
      const feedbackMessage = lower.startsWith("feedback ")
        ? text.slice(9).trim()
        : text.slice(6).trim();

      if (!feedbackMessage) {
        await sendReply(from, t(user, "feedback_missing"));
        return res.sendStatus(200);
      }

      await supabase.from("feedback").insert({ user_id: user.id, message: feedbackMessage });
      await sendReply(ADMIN_PHONE,
        `💬 User Feedback\n\nUser: ${user.name}\nPhone: ${from}\nLanguage: ${user.language || "en"}\n\nMessage:\n${feedbackMessage}`
      );
      await sendReply(from, t(user, "feedback_thanks", user.name));
      return res.sendStatus(200);
    }

    // ── UPGRADE ───────────────────────────────────────────────────────────
    if (lower === "upgrade") {
      if (isActivePremiumUser(user)) {
        const expiryDate = user.premium_until
          ? new Date(user.premium_until).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
          : null;
        const planLabel = user.premium_plan === "annual" ? "Annual" : "Monthly";
        await sendReply(from, t(user, "already_premium", planLabel, expiryDate));
      } else {
        // Upgrade message is bilingual — pricing must be crystal clear regardless of language
        await sendReply(from,
`⭐ Car Logbook Premium

Monthly: 5,000 TZS/month
Annual: 50,000 TZS/year (save 10,000 TZS)

What you get / Utakachopata:
✅ Multiple cars / Magari mengi
✅ Full history / Historia kamili
✅ Insurance expiry reminders / Vikumbusho vya bima
✅ Monthly expense summary / Muhtasari wa gharama
✅ City-specific fuel prices / Bei za mafuta za jiji lako
✅ More features coming soon / Vipengele zaidi vinakuja

─────────────────
How to upgrade / Jinsi ya kupanda daraja:

1. Send payment via M-Pesa / Tuma malipo kupitia M-Pesa:

   Number / Nambari: ${MPESA_NUMBER}
   Name / Jina: Car Logbook

2. After paying, send / Baada ya kulipa, tuma:
   paid <transaction_id>

   Or paste your full SMS and I'll find the ID.
   Au bandika SMS yako yote nami nitapata nambari.

   Example / Mfano:
   paid QHG72K3
─────────────────

Questions? contact@carlogbook.app`
        );
      }
      return res.sendStatus(200);
    }

    // ── PAID ──────────────────────────────────────────────────────────────
    // English: paid <txn>
    // Swahili: limelipwa <txn>
    const isPaidCommand = lower.startsWith("paid ") || lower.startsWith("limelipwa ");

    if (isPaidCommand) {
      const rawText = lower.startsWith("paid ")
        ? text.slice(5).trim()
        : text.slice(10).trim();

      let txnId = null;
      const words = rawText.split(" ");

      if (words.length <= 2) {
        txnId = words[0].trim().toUpperCase();
      } else {
        const extracted = await extractTransactionId(rawText);
        if (extracted) {
          txnId = extracted.toUpperCase();
        } else {
          await sendReply(from, t(user, "paid_txn_not_found"));
          return res.sendStatus(200);
        }
      }

      if (!txnId) {
        await sendReply(from, t(user, "paid_no_txn"));
        return res.sendStatus(200);
      }

      const { data: existingPending } = await supabase
        .from("payments").select("*").eq("user_id", user.id).eq("status", "pending").single();

      if (existingPending) {
        await sendReply(from, t(user, "paid_already_pending", existingPending.transaction_id));
        return res.sendStatus(200);
      }

      const { data: duplicateTxn } = await supabase
        .from("payments").select("*").eq("transaction_id", txnId).single();

      if (duplicateTxn) {
        await sendReply(from, t(user, "paid_duplicate"));
        await sendReply(ADMIN_PHONE,
          `⚠️ Duplicate Transaction ID Alert\n\nUser: ${user.name}\nPhone: ${from}\nTransaction ID: ${txnId}\n\nThis ID was already used. Do NOT approve without verifying.`
        );
        return res.sendStatus(200);
      }

      await supabase.from("payments").insert({ user_id: user.id, transaction_id: txnId, status: "pending" });
      await sendReply(from, t(user, "paid_received", txnId));
      await sendReply(ADMIN_PHONE,
        `💰 Premium Payment Request\n\nUser: ${user.name}\nPhone: ${from}\nLanguage: ${user.language || "en"}\nTransaction ID: ${txnId}\n\nTo approve:\napprove ${from}\n\nTo reject:\nreject ${from}`
      );
      return res.sendStatus(200);
    }

    // ── CARS ──────────────────────────────────────────────────────────────
    if (lower === "cars" || lower === "magari") {
      const cars = await getUserCars(user.id);
      const isSw = user.language === "sw";

      if (!cars.length) {
        await sendReply(from, t(user, "no_cars"));
      } else {
        let messageText = `🚗 ${isSw ? "Magari Yako" : "Your Cars"}\n\n`;

        for (const car of cars) {
          const isActive = car.id === carId;

          const { data: lastFuel } = await supabase.from("logs").select("amount, created_at")
            .eq("car_id", car.id).eq("type", "fuel").order("created_at", { ascending: false }).limit(1).single();
          const { data: lastMileage } = await supabase.from("logs").select("mileage, created_at")
            .eq("car_id", car.id).eq("type", "mileage").order("created_at", { ascending: false }).limit(1).single();
          const { count: totalLogs } = await supabase.from("logs")
            .select("*", { count: "exact", head: true }).eq("car_id", car.id);

          messageText += `${isActive ? "▶" : "•"} ${car.car_name} — ${car.plate_number}${isActive ? (isSw ? " (hai)" : " (active)") : ""}\n`;
          if (lastMileage) messageText += `   📏 ${lastMileage.mileage?.toLocaleString()} km\n`;
          if (lastFuel) {
            const fuelDate = new Date(lastFuel.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
            messageText += `   ⛽ ${lastFuel.amount?.toLocaleString()} TZS (${fuelDate})\n`;
          }
          if (totalLogs > 0) messageText += `   📋 ${totalLogs} ${isSw ? "ingizo" : `log${totalLogs === 1 ? "" : "s"} total`}\n`;
          messageText += "\n";
        }

        messageText += t(user, "cars_footer", userCars[0]?.car_name || "rav4");
        await sendReply(from, messageText);
      }
      return res.sendStatus(200);
    }

    // ── ADD CAR ───────────────────────────────────────────────────────────
    if (lower === "add car" || lower === "ongeza gari") {
      if (PREMIUM_ENABLED && userCars.length >= 1 && !isPremium(user)) {
        await sendReply(from, t(user, "add_car_premium_required"));
        return res.sendStatus(200);
      }

      await supabase.from("users").update({ pending_plate: "AWAITING" }).eq("id", user.id);
      await sendReply(from, t(user, "add_car_prompt"));
      return res.sendStatus(200);
    }

    // ── SWITCH ACTIVE CAR ─────────────────────────────────────────────────
    // English: switch to rav4 / use rav4 / change to rav4
    // Swahili: badili rav4
    const switchPhrases = ["switch to ", "use ", "change to ", "badili "];
    const switchMatch = switchPhrases.find(p => lower.startsWith(p));

    if (switchMatch) {
      if (PREMIUM_ENABLED && !isPremium(user)) {
        await sendReply(from, t(user, "switch_premium_required"));
        return res.sendStatus(200);
      }

      const carName = lower.replace(switchMatch, "").trim();
      const matchedCar = userCars.find(car => car.car_name === carName);

      if (!matchedCar) {
        let notFoundReply = `${t(user, "switch_car_not_found", carName)}\n`;
        userCars.forEach(car => { notFoundReply += `• ${car.car_name}\n`; });
        notFoundReply += `\n${user.language === "sw" ? "Mfano:\nbadili rav4" : "Example:\nswitch to rav4"}`;
        await sendReply(from, notFoundReply);
        return res.sendStatus(200);
      }

      await setActiveCar(user.id, matchedCar.id);
      await sendReply(from, t(user, "switch_car_success", matchedCar.car_name));
      return res.sendStatus(200);
    }

    // ── UNDO ──────────────────────────────────────────────────────────────
    if (lower === "undo" || lower === "futa") {
      if (!carId) {
        await sendReply(from, t(user, "undo_no_car"));
        return res.sendStatus(200);
      }

      if (PREMIUM_ENABLED && !isPremium(user)) {
        const allowed = await checkLimit(user.id, "undo_count");
        if (!allowed) {
          await sendReply(from, t(user, "undo_limit_reached"));
          return res.sendStatus(200);
        }
        await incrementUsage(user.id, "undo_count");
      }

      const deleted = await deleteLastLog(carId);
      await sendReply(from, deleted
        ? t(user, "undo_success")
        : t(user, "undo_nothing")
      );
      return res.sendStatus(200);
    }

    // ── HISTORY ───────────────────────────────────────────────────────────
    // English: history / history 10 / history month / history rav4
    // Swahili: historia / historia 10 / historia mwezi / historia rav4
    const isHistoryCommand = lower.startsWith("history") || lower.startsWith("historia");

    if (isHistoryCommand) {
      const parts = lower.split(" ");
      let historyCarName = null;
      let command = null;

      if (parts.length > 1 && parts[1] !== "10" && parts[1] !== "month" && parts[1] !== "mwezi") {
        historyCarName = parts[1];
        command = parts[2];
      } else {
        command = parts[1];
      }

      // Normalise Swahili month command
      if (command === "mwezi") command = "month";

      if (PREMIUM_ENABLED && !isPremium(user)) {
        if (command === "10" || command === "month" || historyCarName) {
          await sendReply(from, t(user, "history_premium_required"));
          return res.sendStatus(200);
        }
      }

      if (PREMIUM_ENABLED && !isPremium(user)) {
        const allowed = await checkLimit(user.id, "history_count");
        if (!allowed) {
          await sendReply(from, t(user, "history_limit_reached"));
          return res.sendStatus(200);
        }
        await incrementUsage(user.id, "history_count");
      }

      if (historyCarName) {
        const matchedCar = userCars.find(car => car.car_name === historyCarName);
        if (!matchedCar) {
          let notFoundReply = `${t(user, "history_car_not_found", historyCarName)}\n`;
          userCars.forEach(car => { notFoundReply += `• ${car.car_name}\n`; });
          notFoundReply += `\n${user.language === "sw" ? "Jaribu: historia" : "Try: history"} ${userCars[0]?.car_name || "rav4"}`;
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
      const isSw = user.language === "sw";

      if (!logs.length) {
        await sendReply(from, t(user, "history_no_logs", activeCarName, command === "month"));
      } else {
        let messageText = `📒 ${activeCarName} — ${isSw ? "Maingizo ya Hivi Karibuni" : "Recent Logs"}\n\n`;

        logs.forEach(log => {
          const formattedDate = new Date(log.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
          let line = "";
          if (log.type === "fuel") {
            line = `⛽ ${isSw ? "Mafuta" : "Fuel"} — ${log.amount?.toLocaleString()} TZS`;
          } else if (log.type === "maintenance") {
            const label = log.subtype ? subtypeLabel(log.subtype) : null;
            const isPhotoDescription = log.description &&
              log.description !== log.subtype &&
              log.description !== label &&
              !log.description.toLowerCase().startsWith("oil change") &&
              !log.description.toLowerCase().startsWith("fuel") &&
              log.description.length > 5;
            const detail = isPhotoDescription ? ` (${log.description})` : "";
            line = `🔧 ${label || (isSw ? "Matengenezo" : "Maintenance")}${detail} — ${log.amount?.toLocaleString()} TZS`;
          } else if (log.type === "mileage") {
            line = `📏 ${isSw ? "Kilomita" : "Mileage"} — ${log.mileage?.toLocaleString()} km`;
          } else if (log.type === "insurance") {
            line = `💰 ${isSw ? "Bima" : "Insurance"} — ${log.amount?.toLocaleString()} TZS`;
          } else {
            line = `💸 ${log.description}`;
          }
          messageText += `${formattedDate}\n${line}\n\n`;
        });

        messageText += `${isSw ? "Ona zaidi" : "See more"}:\n`;

        if (historyCarName) {
          messageText += `${isSw ? "historia" : "history"} ${historyCarName} 10\n`;
          messageText += `${isSw ? "historia" : "history"} ${historyCarName} ${isSw ? "mwezi" : "month"}\n`;
        } else {
          if (command !== "10")    messageText += `${isSw ? "historia" : "history"} 10\n`;
          if (command !== "month") messageText += `${isSw ? "historia mwezi" : "history month"}\n`;
        }

        const otherCars = userCars.filter(car => car.id !== carId);
        if (otherCars.length > 0) {
          messageText += `\n${isSw ? "Magari mengine" : "Other cars"}:\n`;
          otherCars.forEach(car => {
            messageText += `${isSw ? "historia" : "history"} ${car.car_name}\n`;
          });
        }

        await sendReply(from, messageText);
      }
      return res.sendStatus(200);
    }

    // ── INSURANCE EXPIRY ──────────────────────────────────────────────────
    // English: insurance expiry 15 Aug 2026
    // Swahili: bima kumalizika 15 Aug 2026
    const isInsuranceExpiry =
      lower.startsWith("insurance expiry ") ||
      lower.startsWith("bima kumalizika ");

    if (isInsuranceExpiry) {
      if (!carId) {
        await sendReply(from, t(user, "insurance_expiry_no_car"));
        return res.sendStatus(200);
      }

      const datePart = lower.startsWith("insurance expiry ")
        ? text.slice(17).trim()
        : text.slice(16).trim();

      const parsed = new Date(datePart);

      if (isNaN(parsed.getTime())) {
        await sendReply(from, t(user, "insurance_expiry_invalid_date"));
        return res.sendStatus(200);
      }

      const expiryDate = parsed.toISOString().split("T")[0];
      const { data: existingInsurance } = await supabase
        .from("car_insurance").select("id").eq("car_id", carId).single();

      if (existingInsurance) {
        await supabase.from("car_insurance").update({
          expiry_date: expiryDate, notified_30d: false, notified_7d: false, notified_1d: false
        }).eq("car_id", carId);
      } else {
        await supabase.from("car_insurance").insert({ car_id: carId, expiry_date: expiryDate });
      }

      const activeCar = userCars.find(car => car.id === carId);
      const carName = activeCar ? activeCar.car_name : "your car";
      const displayDate = parsed.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

      await sendReply(from, t(user, "insurance_expiry_saved",
        carName, displayDate, PREMIUM_ENABLED && isPremium(user)
      ));
      return res.sendStatus(200);
    }

    // ── PLATE NUMBER DETECTED ─────────────────────────────────────────────
    if (isPlateNumber(text)) {
      const plate = text.trim().replace(/\s+/g, "").toUpperCase();
      await supabase.from("users").update({ pending_plate: plate }).eq("id", user.id);
      await sendReply(from, t(user, "plate_received", plate));
      return res.sendStatus(200);
    }

    // ── MILEAGE LOG ───────────────────────────────────────────────────────
    if (isMileage(text) && carId) {
      const mileage = extractMileage(text);

      if (mileage) {
        if (PREMIUM_ENABLED && !isPremium(user)) {
          const allowed = await checkLimit(user.id, "log_count");
          if (!allowed) {
            await sendReply(from, t(user, "log_limit_reached"));
            return res.sendStatus(200);
          }
          await incrementUsage(user.id, "log_count");
        }

        const { count: mileageCount } = await supabase
          .from("logs").select("*", { count: "exact", head: true })
          .eq("car_id", carId).eq("type", "mileage");

        await saveLog(carId, "mileage", null, `Mileage ${mileage}`, mileage);
        await supabase.from("users").update({ last_log_at: new Date().toISOString() }).eq("id", user.id);

        reply = t(user, "mileage_logged", mileage);
        if (mileageCount === 0) reply += t(user, "mileage_first_tip");
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
        await sendReply(from, t(user, "car_name_exists", carName));
        return res.sendStatus(200);
      }

      const { data: existingPlate } = await supabase
        .from("cars").select("plate_number").eq("plate_number", plate).single();

      if (existingPlate) {
        await sendReply(from, t(user, "plate_already_registered"));
        await supabase.from("users").update({ pending_plate: null }).eq("id", user.id);
        return res.sendStatus(200);
      }

      const car = await registerCar(user.id, plate, carName);
      if (userCars.length === 0) await setActiveCar(user.id, car.id);
      await supabase.from("users").update({ pending_plate: null }).eq("id", user.id);

      const isFirstCar = userCars.length === 0;

      if (isFirstCar) {
        await supabase.from("users").update({ onboarding_step: "awaiting_city" }).eq("id", user.id);
        await sendReply(from, t(user, "onboarding_city", carName, plate));
      } else {
        await sendReply(from, t(user, "car_added_extra", carName, plate));
      }
      return res.sendStatus(200);
    }

    // ── AWAITING PLATE ────────────────────────────────────────────────────
    if (user.pending_plate === "AWAITING") {
      if (!isPlateNumber(text)) {
        await sendReply(from, t(user, "invalid_plate"));
        return res.sendStatus(200);
      }

      const plate = text.trim().replace(/\s+/g, "").toUpperCase();
      await supabase.from("users").update({ pending_plate: plate }).eq("id", user.id);
      await sendReply(from, t(user, "plate_received", plate));
      return res.sendStatus(200);
    }

    // ── EXPENSE LOG ───────────────────────────────────────────────────────
    const amount = parseAmount(text);
    const { type, subtype } = detectType(text);

    if (amount && carId && looksLikeLog(text)) {
      if (PREMIUM_ENABLED && !isPremium(user)) {
        const allowed = await checkLimit(user.id, "log_count");
        if (!allowed) {
          await sendReply(from, t(user, "log_limit_reached"));
          return res.sendStatus(200);
        }
        await incrementUsage(user.id, "log_count");
      }

      const { count } = await supabase.from("logs")
        .select("*", { count: "exact", head: true }).eq("car_id", carId);

      await saveLog(carId, type, amount, text, null, subtype);
      await supabase.from("users").update({ last_log_at: new Date().toISOString() }).eq("id", user.id);

      const isFirstLog = count === 0;

      if (isFirstLog) {
        reply = t(user, "first_log");
      } else {
        const carUsed = userCars.find(car => car.id === carId);
        const carName = carUsed ? carUsed.car_name : "your car";
        const isSw = user.language === "sw";

        let typeLabel = "Expense";
        if (type === "fuel") {
          typeLabel = isSw ? "Mafuta" : "Fuel";
        } else if (type === "insurance") {
          typeLabel = isSw ? "Bima" : "Insurance";
        } else if (type === "maintenance") {
          typeLabel = subtype
            ? (subtypeLabel(subtype) || (isSw ? "Matengenezo" : "Maintenance"))
            : (isSw ? "Matengenezo" : "Maintenance");
        }

        const isMilestone = count > 0 && (count + 1) % 10 === 0;

        reply = isMilestone
          ? t(user, "log_milestone", carName, typeLabel, amount, count + 1)
          : t(user, "log_saved", carName, typeLabel, amount);

        if (type === "insurance") {
          const { data: existingInsurance } = await supabase
            .from("car_insurance").select("id").eq("car_id", carId).single();
          if (!existingInsurance) reply += t(user, "insurance_expiry_prompt");
        }

        if (type === "maintenance" && subtype) {
          const subtypeToServiceKey = {
            engine_oil:  "oil_change",
            oil_filter:  "oil_filter",
            fuel_filter: "fuel_filter",
            air_filter:  "air_filter",
            coolant:     "coolant",
            gearbox_oil: "gearbox_oil",
            battery:     "battery",
            tyre:        "tyre",
            brake:       "brake",
            wiper:       "wiper",
            service:     "service"
          };
          const serviceKey = subtypeToServiceKey[subtype];

          if (serviceKey) {
            const { data: latestMileage } = await supabase
              .from("logs").select("mileage")
              .eq("car_id", carId).eq("type", "mileage")
              .order("created_at", { ascending: false }).limit(1).single();

            const { data: serviceReminder } = await supabase
              .from("service_reminders").select("id")
              .eq("car_id", carId).eq("service_type", serviceKey).single();

            if (serviceReminder) {
              await supabase.from("service_reminders").update({
                last_serviced_at: new Date().toISOString(),
                last_serviced_km: latestMileage?.mileage || null,
                notified_at: null
              }).eq("id", serviceReminder.id);

              reply += t(user, "reminder_reset");
            }
          }
        }
      }

      await sendReply(from, reply);
      return res.sendStatus(200);
    }

    // ── AI SMART FALLBACK ─────────────────────────────────────────────────
    const aiReply = await getAIFallbackReply(text, userCars, user.id, user.language);
    await sendReply(from, aiReply || t(user, "ai_fallback_default"));
    res.sendStatus(200);

  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(200);
  }
});

module.exports = router;