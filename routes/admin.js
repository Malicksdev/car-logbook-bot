const express = require("express");
const router = express.Router();

const supabase = require("../config/supabase");
const { sendReply } = require("../utils/sendReply");
const { sleep } = require("../utils/helpers");
const { ADMIN_PHONE, MPESA_NUMBER } = require("../config/constants");

// ─── ADMIN COMMAND HANDLER ────────────────────────────────────────────────────
// Called from webhook.js when from === ADMIN_PHONE
// Returns true if a command was handled, false if not an admin command

async function handleAdminCommand(from, text) {

  // APPROVE
  if (text.toLowerCase().startsWith("approve ")) {
    const parts = text.split(" ");
    const targetPhone = parts[1]?.trim();
    const plan = parts[2]?.toLowerCase().trim() || "monthly";

    if (!targetPhone) {
      await sendReply(from, `Usage:\napprove 255XXXXXXXXX\napprove 255XXXXXXXXX annual`);
      return true;
    }
    if (!["monthly", "annual"].includes(plan)) {
      await sendReply(from, `❌ Unknown plan: "${plan}"\n\nValid plans: monthly, annual`);
      return true;
    }

    const { data: targetUser } = await supabase.from("users").select("*").eq("phone_number", targetPhone).single();
    if (!targetUser) { await sendReply(from, `❌ No user found: ${targetPhone}`); return true; }

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
    return true;
  }

  // REJECT
  if (text.toLowerCase().startsWith("reject ")) {
    const targetPhone = text.split(" ")[1]?.trim();
    if (!targetPhone) { await sendReply(from, `Usage: reject 255XXXXXXXXX`); return true; }

    const { data: targetUser } = await supabase.from("users").select("*").eq("phone_number", targetPhone).single();
    if (!targetUser) { await sendReply(from, `❌ No user found: ${targetPhone}`); return true; }

    await supabase.from("payments").update({ status: "rejected" }).eq("user_id", targetUser.id).eq("status", "pending");
    await sendReply(targetPhone,
      `Sorry, we couldn't verify your payment.\n\nPlease double-check your transaction ID and try again:\n\npaid <transaction_id>\n\nOr contact us at contact@carlogbook.app for help.`
    );
    await sendReply(from, `❌ Payment rejected for ${targetUser.name} (${targetPhone}).`);
    return true;
  }

  // DOWNGRADE
  if (text.toLowerCase().startsWith("downgrade ")) {
    const targetPhone = text.split(" ")[1]?.trim();
    if (!targetPhone) { await sendReply(from, `Usage: downgrade 255XXXXXXXXX`); return true; }

    const { data: targetUser } = await supabase.from("users").select("*").eq("phone_number", targetPhone).single();
    if (!targetUser) { await sendReply(from, `❌ No user found: ${targetPhone}`); return true; }

    await supabase.from("users").update({
      is_premium: false, is_lifetime: false, premium_until: null, premium_plan: null,
      premium_warned_3d: false, premium_warned_1d: false
    }).eq("phone_number", targetPhone);

    await sendReply(from, `✅ ${targetUser.name} (${targetPhone}) downgraded to free.`);
    return true;
  }

  // EXTEND
  if (text.toLowerCase().startsWith("extend ")) {
    const targetPhone = text.split(" ")[1]?.trim();
    if (!targetPhone) { await sendReply(from, `Usage: extend 255XXXXXXXXX`); return true; }

    const { data: targetUser } = await supabase.from("users").select("*").eq("phone_number", targetPhone).single();
    if (!targetUser) { await sendReply(from, `❌ No user found: ${targetPhone}`); return true; }
    if (!targetUser.is_premium) { await sendReply(from, `⚠️ ${targetUser.name} is not premium. Use approve instead.`); return true; }

    const base = targetUser.premium_until ? new Date(targetUser.premium_until) : new Date();
    const newExpiry = new Date(base.setMonth(base.getMonth() + 1)).toISOString();

    await supabase.from("users").update({
      premium_until: newExpiry, premium_warned_3d: false, premium_warned_1d: false
    }).eq("phone_number", targetPhone);

    const expiryLabel = new Date(newExpiry).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    await sendReply(targetPhone, `⭐ Good news! Your Car Logbook Premium has been extended.\n\nNew expiry: ${expiryLabel}\n\nThank you for being a valued member! 🙏`);
    await sendReply(from, `✅ ${targetUser.name} extended by 1 month. New expiry: ${expiryLabel}`);
    return true;
  }

  // USER LOOKUP
  if (text.toLowerCase().startsWith("user ")) {
    const targetPhone = text.split(" ")[1]?.trim();
    if (!targetPhone) { await sendReply(from, `Usage: user 255XXXXXXXXX`); return true; }

    const { data: targetUser } = await supabase.from("users").select("*").eq("phone_number", targetPhone).single();
    if (!targetUser) { await sendReply(from, `❌ No user found: ${targetPhone}`); return true; }

    const { data: userCarLinks } = await supabase
      .from("car_users").select("car_id, cars (car_name, plate_number)").eq("user_id", targetUser.id);

    const { count: totalLogs } = await supabase.from("logs")
      .select("*", { count: "exact", head: true })
      .in("car_id", (userCarLinks || []).map(l => l.car_id));

    const joined = new Date(targetUser.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    const lastLogStr = targetUser.last_log_at
      ? new Date(targetUser.last_log_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
      : "Never";

    let planStatus = "Free";
    if (targetUser.is_lifetime) planStatus = "Lifetime ⭐";
    else if (targetUser.is_premium && targetUser.premium_until) {
      const expiry = new Date(targetUser.premium_until).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
      planStatus = `Premium (${targetUser.premium_plan || "monthly"}) — expires ${expiry}`;
    }

    const carList = (userCarLinks || []).map(l => `  • ${l.cars.car_name} (${l.cars.plate_number})`).join("\n") || "  None";
    const freqLabel = { "7days": "Weekly", "14days": "Fortnightly", "30days": "Monthly", "off": "Off" };

    await sendReply(from,
`👤 User Lookup

Name: ${targetUser.name}
Phone: ${targetPhone}
Joined: ${joined}
Plan: ${planStatus}
City: ${targetUser.city || "Not set"}
Last log: ${lastLogStr}
Reminders: ${freqLabel[targetUser.reminder_frequency || "7days"] || "Weekly"}
Cars: ${userCarLinks?.length || 0}
${carList}
Total logs: ${totalLogs || 0}`
    );
    return true;
  }

  // CAR LOOKUP
  if (text.toLowerCase().startsWith("car ")) {
    const plateRaw = text.split(" ")[1]?.trim().toUpperCase().replace(/\s+/g, "");
    if (!plateRaw) { await sendReply(from, `Usage: car T123ABC`); return true; }

    const { data: carData } = await supabase.from("cars").select("*").eq("plate_number", plateRaw).single();
    if (!carData) { await sendReply(from, `❌ No car found: ${plateRaw}`); return true; }

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
    return true;
  }

  // PENDING
  if (text.toLowerCase() === "pending") {
    const { data: pendingPayments } = await supabase
      .from("payments").select("*, users (name, phone_number)")
      .eq("status", "pending").order("created_at", { ascending: false });

    if (!pendingPayments || !pendingPayments.length) {
      await sendReply(from, `✅ No pending payments right now.`);
      return true;
    }

    let msg = `💰 Pending Payments (${pendingPayments.length})\n\n`;
    pendingPayments.forEach((p, i) => {
      const date = new Date(p.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      msg += `${i + 1}. ${p.users.name} (${p.users.phone_number})\n   TID: ${p.transaction_id}\n   Submitted: ${date}\n\n`;
    });
    msg += `To approve:\napprove 255XXXXXXXXX\napprove 255XXXXXXXXX annual`;
    await sendReply(from, msg);
    return true;
  }

  // PAYMENTS
  if (text.toLowerCase() === "payments") {
    const { data: recentPayments } = await supabase
      .from("payments").select("*, users (name, phone_number)")
      .eq("status", "approved").order("created_at", { ascending: false }).limit(10);

    if (!recentPayments || !recentPayments.length) {
      await sendReply(from, `No approved payments yet.`);
      return true;
    }

    let msg = `✅ Recent Payments (last ${recentPayments.length})\n\n`;
    recentPayments.forEach((p, i) => {
      const date = new Date(p.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
      const planStr = p.plan ? ` — ${p.plan}` : "";
      const amountStr = p.amount ? ` (${p.amount.toLocaleString()} TZS)` : "";
      msg += `${i + 1}. ${p.users.name} (${p.users.phone_number})\n   ${date}${planStr}${amountStr}\n\n`;
    });
    await sendReply(from, msg);
    return true;
  }

  // STATS
  if (text.toLowerCase() === "stats") {
    const { count: totalUsers }       = await supabase.from("users").select("*", { count: "exact", head: true });
    const { count: premiumUsers }     = await supabase.from("users").select("*", { count: "exact", head: true }).eq("is_premium", true);
    const { count: totalLogs }        = await supabase.from("logs").select("*", { count: "exact", head: true });
    const { count: usersWithCity }    = await supabase.from("users").select("*", { count: "exact", head: true }).not("city", "is", null);
    const { count: remindersOff }     = await supabase.from("users").select("*", { count: "exact", head: true }).eq("reminder_frequency", "off");
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { count: newUsersThisWeek } = await supabase.from("users").select("*", { count: "exact", head: true }).gte("created_at", oneWeekAgo);
    const { count: pendingCount }     = await supabase.from("payments").select("*", { count: "exact", head: true }).eq("status", "pending");

    await sendReply(from,
`📊 Car Logbook Stats

👥 Total users: ${totalUsers || 0}
⭐ Premium users: ${premiumUsers || 0}
🆕 New this week: ${newUsersThisWeek || 0}
📋 Total logs: ${totalLogs || 0}
💰 Pending payments: ${pendingCount || 0}
📍 Users with city: ${usersWithCity || 0}
🔕 Reminders off: ${remindersOff || 0}`
    );
    return true;
  }

  // BROADCAST
  if (text.toLowerCase().startsWith("broadcast ")) {
    const broadcastMessage = text.slice(10).trim();
    if (!broadcastMessage) { await sendReply(from, `Usage: broadcast <your message>`); return true; }

    const { data: allUsers } = await supabase.from("users").select("phone_number, name");
    if (!allUsers || !allUsers.length) { await sendReply(from, `No users to broadcast to.`); return true; }

    await sendReply(from, `📡 Sending broadcast to ${allUsers.length} users...`);
    let sent = 0, failed = 0;
    for (const u of allUsers) {
      try {
        await sendReply(u.phone_number, broadcastMessage);
        sent++;
        await sleep(100);
      } catch (e) {
        console.error(`Broadcast failed for ${u.phone_number}:`, e.message);
        failed++;
      }
    }
    await sendReply(from, `✅ Broadcast complete.\nSent: ${sent}\nFailed: ${failed}`);
    return true;
  }

  // ── EWURA SET PRICES ──────────────────────────────────────────────────
  if (text.toLowerCase().startsWith("ewura ") &&
      !text.toLowerCase().startsWith("ewura broadcast") &&
      !text.toLowerCase().startsWith("ewura status")) {

    const parts = text.trim().split(/\s+/);
    if (parts.length < 5) {
      await sendReply(from, `Usage: ewura <city> <petrol> <diesel> <kerosene>\n\nExamples:\newura arusha 2973 2967 3042\newura dar 2864 2858 2932`);
      return true;
    }

    const kerosene = parseInt(parts[parts.length - 1]);
    const diesel   = parseInt(parts[parts.length - 2]);
    const petrol   = parseInt(parts[parts.length - 3]);
    const cityRaw  = parts.slice(1, parts.length - 3).join(" ").toLowerCase().trim();

    const cityAliases = {
      "dar": "dar es salaam", "dares salaam": "dar es salaam",
      "dar es salaam": "dar es salaam", "arusha": "arusha",
      "dodoma": "dodoma", "mwanza": "mwanza",
      "mbeya": "mbeya", "moshi": "moshi", "tanga": "tanga"
    };
    const city = cityAliases[cityRaw] || cityRaw;

    if (isNaN(petrol) || isNaN(diesel) || isNaN(kerosene)) {
      await sendReply(from, `❌ Invalid prices. Last 3 values must be numbers.\n\nExample:\newura arusha 2973 2967 3042`);
      return true;
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
    return true;
  }

  // ── EWURA STATUS ──────────────────────────────────────────────────────
  if (text.toLowerCase() === "ewura status") {
    const nowDate = new Date();
    const monthKey = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, "0")}`;
    const monthLabel = nowDate.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

    const { data: prices } = await supabase.from("fuel_prices").select("*").eq("month", monthKey).order("city");

    if (!prices || prices.length === 0) {
      await sendReply(from, `⛽ EWURA Status — ${monthLabel}\n\nNo prices entered yet.\n\nEnter prices:\newura arusha 2973 2967 3042`);
      return true;
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
    return true;
  }

  // ── EWURA BROADCAST ───────────────────────────────────────────────────
  if (text.toLowerCase() === "ewura broadcast") {
    const nowDate = new Date();
    const monthKey = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, "0")}`;
    const monthLabel = nowDate.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

    const { data: prices } = await supabase.from("fuel_prices").select("*").eq("month", monthKey);

    if (!prices || prices.length === 0) {
      await sendReply(from, `❌ No EWURA prices entered for ${monthLabel}.\n\nEnter prices first:\newura arusha 2973 2967 3042`);
      return true;
    }

    const priceMap = {};
    for (const p of prices) priceMap[p.city.toLowerCase().trim()] = p;

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
          if (!userCity) msg += `\n📍 Set your city for local prices:\nmy city Arusha`;
        }

        msg += `\n─────────────────\nSource: EWURA Tanzania\nEffective: ${monthLabel}`;

        await sendReply(u.phone_number, msg);
        await sleep(100);
        sent++;
      } catch (e) {
        console.error(`EWURA broadcast failed for ${u.phone_number}:`, e.message);
        failed++;
      }
    }

    await sendReply(from, `✅ EWURA broadcast complete.\nSent: ${sent}\nFailed: ${failed}`);
    return true;
  }

  // ── ADMIN HELP ────────────────────────────────────────────────────────
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
    return true;
  }

  // Not an admin command
  return false;
}

module.exports = { handleAdminCommand };