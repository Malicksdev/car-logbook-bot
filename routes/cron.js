const express = require("express");
const router = express.Router();

const supabase = require("../config/supabase");
const { sendReply } = require("../utils/sendReply");
const { isPremium, subtypeLabel, sleep, reminderDays, serviceTypeLabel } = require("../utils/helpers");
const { ADMIN_PHONE } = require("../config/constants");

// ─── CRON: CHECK PREMIUM EXPIRY + INSURANCE + INACTIVE REMINDERS ──────────────

router.get("/check-premium", async (req, res) => {
  const secret = req.headers["x-cron-secret"] || req.query.secret;
  if (secret !== process.env.CRON_SECRET) return res.sendStatus(403);

  const now = new Date();
  const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const in1Day  = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);

  // ── PREMIUM EXPIRY ─────────────────────────────────────────────────────
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

  // ── INACTIVE USER REMINDERS ────────────────────────────────────────────
  const { data: allUsersForReminder } = await supabase
    .from("users")
    .select("id, name, phone_number, created_at, last_log_at, last_reminder_sent_at, reminder_frequency")
    .neq("reminder_frequency", "off");

  let inactiveReminders = 0;
  const gracePeriodDays = 3;

  for (const u of allUsersForReminder || []) {
    try {
      const joinedAt = new Date(u.created_at);
      const daysSinceJoin = (now - joinedAt) / (1000 * 60 * 60 * 24);
      if (daysSinceJoin < gracePeriodDays) continue;

      const freqDays = reminderDays(u.reminder_frequency || "7days");
      const freqMs = freqDays * 24 * 60 * 60 * 1000;

      const lastLog = u.last_log_at ? new Date(u.last_log_at) : joinedAt;
      const daysSinceLog = (now - lastLog) / (1000 * 60 * 60 * 24);
      if (daysSinceLog < freqDays) continue;

      if (u.last_reminder_sent_at) {
        const lastReminderAt = new Date(u.last_reminder_sent_at);
        if ((now - lastReminderAt) < freqMs) continue;
      }

      const freqLabel = freqDays === 7 ? "week" : freqDays === 14 ? "2 weeks" : "month";

      await sendReply(u.phone_number,
`👋 Hey ${u.name}! It's been a ${freqLabel} since your last log.

Keeping your logbook up to date takes just a few seconds:

⛽ fuel 40k
🔧 oil change 120k
📏 mileage 30402

Your car history is only as good as what you track. 🚗

─────────────────
To change how often I remind you:
reminders weekly
reminders fortnightly
reminders monthly
reminders off`
      );

      await supabase.from("users")
        .update({ last_reminder_sent_at: now.toISOString() })
        .eq("id", u.id);

      inactiveReminders++;
    } catch (err) {
      console.error(`Inactive reminder error for ${u.phone_number}:`, err.message);
    }
  }

  console.log(`Inactive reminders sent: ${inactiveReminders}`);

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

  // ── SERVICE INTERVAL REMINDERS ─────────────────────────────────────────
  // For each service reminder: check if km or days threshold exceeded
  // Only fires for premium users
  // Skips if already notified since last service reset

  const { data: allReminders } = await supabase
    .from("service_reminders")
    .select("*, cars (id, car_name, car_users (users (id, phone_number, is_premium, is_lifetime, premium_until)))");

  let serviceReminders = 0;

  for (const reminder of allReminders || []) {
    try {
      const car = reminder.cars;
      if (!car) continue;

      for (const link of car.car_users || []) {
        const u = link.users;
        if (!u) continue;

        // Premium only
        const userIsPremium = u.is_lifetime || (u.is_premium && u.premium_until &&
          new Date(u.premium_until).getTime() + 3 * 24 * 60 * 60 * 1000 > Date.now());
        if (!userIsPremium) continue;

        // Already notified since last service reset — skip
        if (reminder.notified_at && reminder.last_serviced_at &&
            new Date(reminder.notified_at) > new Date(reminder.last_serviced_at)) continue;

        const label = serviceTypeLabel(reminder.service_type);
        let isDue = false;
        let dueReason = "";

        // Check km-based trigger
        if (reminder.interval_km) {
          const { data: latestMileage } = await supabase
            .from("logs").select("mileage")
            .eq("car_id", car.id).eq("type", "mileage")
            .order("created_at", { ascending: false }).limit(1).single();

          if (latestMileage?.mileage && reminder.last_serviced_km) {
            const kmSince = latestMileage.mileage - reminder.last_serviced_km;
            if (kmSince >= reminder.interval_km) {
              isDue = true;
              dueReason = `${kmSince.toLocaleString()} km since last ${label.toLowerCase()}`;
            }
          } else if (latestMileage?.mileage && !reminder.last_serviced_km) {
            // No last serviced km recorded — fall back to days
          }
        }

        // Fall back to days-based trigger if no km trigger fired
        if (!isDue && reminder.interval_days) {
          const lastDate = reminder.last_serviced_at ? new Date(reminder.last_serviced_at) : new Date(reminder.created_at);
          const daysSince = (now - lastDate) / (1000 * 60 * 60 * 24);
          if (daysSince >= reminder.interval_days) {
            isDue = true;
            dueReason = `${Math.floor(daysSince)} days since last ${label.toLowerCase()}`;
          }
        }

        // Also fall back to days if km interval set but no mileage logged at all
        if (!isDue && reminder.interval_km && !reminder.last_serviced_km) {
          const lastDate = reminder.last_serviced_at ? new Date(reminder.last_serviced_at) : new Date(reminder.created_at);
          const daysSince = (now - lastDate) / (1000 * 60 * 60 * 24);
          // Use a 90-day fallback if no mileage data available
          if (daysSince >= 90) {
            isDue = true;
            dueReason = `over 90 days since last ${label.toLowerCase()} (no mileage data available)`;
          }
        }

        if (!isDue) continue;

        await sendReply(u.phone_number,
`🔧 Service Reminder — ${car.car_name}

Time for a ${label}!

${dueReason}.

Once done, log it and I'll reset your reminder:
${reminder.service_type === "oil_change" ? "oil change" : label.toLowerCase()} <amount>

To see all your reminders:
reminders list`
        );

        await supabase.from("service_reminders")
          .update({ notified_at: now.toISOString() })
          .eq("id", reminder.id);

        serviceReminders++;
      }
    } catch (err) {
      console.error(`Service reminder error for reminder ${reminder.id}:`, err.message);
    }
  }

  console.log(`Service reminders sent: ${serviceReminders}`);
  return res.status(200).json({ warned3, warned1, downgraded, insuranceReminders, inactiveReminders, serviceReminders });
});

// ─── CRON: MONTHLY SUMMARY ────────────────────────────────────────────────────

router.get("/monthly", async (req, res) => {
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
      await sleep(100);
      summariesSent++;

    } catch (err) {
      console.error(`Monthly summary error for ${u.phone_number}:`, err.message);
    }
  }

  console.log(`Monthly summaries sent: ${summariesSent}`);
  return res.status(200).json({ summariesSent, month: monthLabel });
});

module.exports = router;