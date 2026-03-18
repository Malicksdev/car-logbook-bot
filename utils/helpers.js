const { PREMIUM_ENABLED } = require("../config/constants");

// ─── PREMIUM CHECKS ───────────────────────────────────────────────────────────

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

// ─── TRANSLATIONS ─────────────────────────────────────────────────────────────
// All user-facing strings live here.
// Add new strings to both 'en' and 'sw' together — never one without the other.

const translations = {

  // ── ONBOARDING ──────────────────────────────────────────────────────────────

  language_prompt: {
    en: `👋 Welcome to Car Logbook!\n\nPlease choose your language:\n\n1. English\n2. Kiswahili`,
    sw: `👋 Karibu Car Logbook!\n\nTafadhali chagua lugha yako:\n\n1. English\n2. Kiswahili`
  },

  language_invalid: {
    en: `Please reply with 1 for English or 2 for Kiswahili.\n\n1. English\n2. Kiswahili`,
    sw: `Tafadhali jibu 1 kwa English au 2 kwa Kiswahili.\n\n1. English\n2. Kiswahili`
  },

  language_set_en: {
    en: `✅ English selected.\n\nWhat's your car's plate number?\n\nExample: T123ABC`,
    sw: `✅ Umechagua English.\n\nNambari ya usajili wa gari lako ni nini?\n\nMfano: T123ABC`
  },

  language_set_sw: {
    en: `✅ Kiswahili kimechaguliwa.\n\nNambari ya usajili wa gari lako ni nini?\n\nMfano: T123ABC`,
    sw: `✅ Kiswahili kimechaguliwa.\n\nNambari ya usajili wa gari lako ni nini?\n\nMfano: T123ABC`
  },

  welcome_new_user: {
    en: (name) => `👋 Welcome to Car Logbook, ${name}!\n\nI help you track fuel, maintenance, mileage, and car expenses — right here on WhatsApp. No app needed.\n\nLet's get your car added first.\n\nWhat's your car's plate number?\n\nExample: T123ABC`,
    sw: (name) => `👋 Karibu Car Logbook, ${name}!\n\nNakusaidia kufuatilia mafuta, matengenezo, na gharama za gari — hapa hapa WhatsApp. Hakuna app inayohitajika.\n\nTuanze kwa kuongeza gari lako.\n\nNambari ya usajili wa gari lako ni nini?\n\nMfano: T123ABC`
  },

  language_switch_prompt: {
    en: `🌐 Language / Lugha\n\nReply with:\n1. English\n2. Kiswahili`,
    sw: `🌐 Language / Lugha\n\nJibu:\n1. English\n2. Kiswahili`
  },

  language_switched_en: {
    en: `✅ Language changed to English.`,
    sw: `✅ Lugha imebadilishwa kuwa English.`
  },

  language_switched_sw: {
    en: `✅ Lugha imebadilishwa kuwa Kiswahili.`,
    sw: `✅ Lugha imebadilishwa kuwa Kiswahili.`
  },

  language_invalid_switch: {
    en: `Please reply with 1 for English or 2 for Kiswahili.`,
    sw: `Tafadhali jibu 1 kwa English au 2 kwa Kiswahili.`
  },

  autodetect_swahili_prompt: {
    en: `🌐 It looks like you're writing in Swahili. Would you like to switch?\n\nInaonekana unaandika Kiswahili. Ungependa kubadili lugha?\n\n1. Switch to Kiswahili / Badili kwenda Kiswahili\n2. Keep English / Endelea na English`,
    sw: `🌐 It looks like you're writing in Swahili. Would you like to switch?\n\nInaonekana unaandika Kiswahili. Ungependa kubadili lugha?\n\n1. Switch to Kiswahili / Badili kwenda Kiswahili\n2. Keep English / Endelea na English`
  },

  onboarding_city: {
    en: (carName, plate) => `🎉 ${carName} (${plate}) added!\n\nQuick setup — which city are you in?\n\nThis helps me show you local fuel prices each month.\n\nReply with your city (e.g. Arusha, Dar es Salaam, Mwanza)\n\nOr type "skip" to skip.`,
    sw: (carName, plate) => `🎉 ${carName} (${plate}) imeongezwa!\n\nMaswali mawili ya haraka — uko jiji gani?\n\nHii inanisaidia kukuonyesha bei za mafuta za mtaa kila mwezi.\n\nJibu na jiji lako (mfano: Arusha, Dar es Salaam, Mwanza)\n\nAu andika "ruka" kuruka.`
  },

  onboarding_city_saved: {
    en: (city) => `✅ Got it — ${city}!\n\nOne more quick question:\n\n⛽ What fuel does your car use?\n\nReply: petrol or diesel\n\n(or "skip" to skip)`,
    sw: (city) => `✅ Sawa — ${city}!\n\nSwali moja zaidi:\n\n⛽ Gari lako linatumia mafuta gani?\n\nJibu: petrol au diesel\n\n(au "ruka" kuruka)`
  },

  onboarding_city_skipped: {
    en: `No problem!\n\nOne more quick question:\n\n⛽ What fuel does your car use?\n\nReply: petrol or diesel\n\n(or "skip" to skip)`,
    sw: `Sawa!\n\nSwali moja zaidi:\n\n⛽ Gari lako linatumia mafuta gani?\n\nJibu: petrol au diesel\n\n(au "ruka" kuruka)`
  },

  onboarding_complete: {
    en: (name) => `🎉 You're all set, ${name}!\n\nYour first log takes 5 seconds — how much did you last spend on fuel?\n\nJust reply with something like:\n⛽ fuel 40k\n\nThat's it. I'll take care of the rest.`,
    sw: (name) => `🎉 Umekamilisha, ${name}!\n\nIngizo lako la kwanza linachukua sekunde 5 — ulitumia kiasi gani mara ya mwisho kwa mafuta?\n\nJibu tu kitu kama:\n⛽ mafuta 40k\n\nHiyo tu. Mimi nitashughulikia mengine.`
  },

  fuel_type_saved: {
    en: (fuelType) => `Fuel type saved: ${fuelType}.`,
    sw: (fuelType) => `Aina ya mafuta imehifadhiwa: ${fuelType}.`
  },

  fuel_type_skipped: {
    en: `No problem, you can always update this later.`,
    sw: `Sawa, unaweza kusasisha hii baadaye.`
  },

  // ── CANCEL ──────────────────────────────────────────────────────────────────

  cancelled: {
    en: `Okay, cancelled. What would you like to do?\n\nType "help" to see all commands.`,
    sw: `Sawa, imeghairiwa. Ungependa kufanya nini?\n\nAndika "help" kuona amri zote.`
  },

  // ── GREETINGS ────────────────────────────────────────────────────────────────

  greeting_no_car: {
    en: (name) => `👋 Hey ${name}! Good to have you here.\n\nIt looks like you haven't added a car yet. Let's fix that!\n\nWhat's your car's plate number?\n\nExample: T123ABC`,
    sw: (name) => `👋 Habari ${name}! Karibu.\n\nInaonekana bado hujaongeza gari. Tufanye hivyo!\n\nNambari ya usajili wa gari lako ni nini?\n\nMfano: T123ABC`
  },

  greeting_with_car: {
    en: (name) => `👋 Hey ${name}! Ready to log something?\n\n⛽ fuel 40k\n🔧 oil change 120k\n📏 mileage 30402\n📒 history\n\nType "help" to see all commands.`,
    sw: (name) => `👋 Habari ${name}! Uko tayari kurekodi kitu?\n\n⛽ mafuta 40k\n🔧 oil change 120k\n📏 kilomita 30402\n📒 historia\n\nAndika "help" kuona amri zote.`
  },

  // ── START ────────────────────────────────────────────────────────────────────

  start: {
    en: (name) => `🚗 Car Logbook\n\nHey ${name}! Here's what you can do:\n\n⛽ Log fuel → fuel 40k\n🔧 Log maintenance → oil change 120k\n📏 Log mileage → mileage 30402\n📒 View history → history\n🚗 View your cars → cars\n➕ Add a new car → add car\n\nType "help" anytime you need a reminder.\n💬 Have feedback? feedback <your message>`,
    sw: (name) => `🚗 Car Logbook\n\nHabari ${name}! Hivi ndivyo unavyoweza kufanya:\n\n⛽ Rekodi mafuta → mafuta 40k\n🔧 Rekodi matengenezo → oil change 120k\n📏 Rekodi kilomita → kilomita 30402\n📒 Tazama historia → historia\n🚗 Magari yako → magari\n➕ Ongeza gari jipya → ongeza gari\n\nAndika "help" wakati wowote.\n💬 Maoni? feedback <ujumbe wako>`
  },

  // ── HELP ─────────────────────────────────────────────────────────────────────

  help: {
    en: (PREMIUM_ENABLED) => `🚗 Car Logbook — Quick Guide

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
🔧 remind oil change every 5000km → service reminders ${PREMIUM_ENABLED ? "(Premium)" : ""}
🌐 language → change language / badili lugha

Other:
↩️ undo → remove last log
⭐ upgrade → go Premium
💬 feedback <message> → send us feedback

Tip: Just type what you did naturally — I'll figure out the rest!`,
    sw: (PREMIUM_ENABLED) => `🚗 Car Logbook — Mwongozo

Kurekodi:
⛽ mafuta 40k
🔧 oil change 120k
🔧 air cleaner 30k
🔧 betri 80k
🔧 tairi 150k
📏 kilomita 30402
💰 bima 1.2M

Historia:
📒 historia
📒 historia 10 ${PREMIUM_ENABLED ? "(Premium)" : ""}
📒 historia mwezi ${PREMIUM_ENABLED ? "(Premium)" : ""}
📒 historia rav4 ${PREMIUM_ENABLED ? "(Premium)" : ""}

Magari:
🚗 magari → magari yako
➕ ongeza gari → sajili gari jipya ${PREMIUM_ENABLED ? "(Premium baada ya gari la 1)" : ""}
🔄 badili rav4 → badili gari

Mipangilio:
📍 jiji langu Arusha → bei za mafuta za mtaa ${PREMIUM_ENABLED ? "(bure kuweka, Premium kubadili)" : ""}
🔔 vikumbusho wiki / mwezi / zima → vikumbusho vya kurekodi
🔧 kumbuka oil change kila 5000km → vikumbusho vya huduma ${PREMIUM_ENABLED ? "(Premium)" : ""}
🌐 lugha → badili lugha / change language

Nyingine:
↩️ futa → ondoa rekodi ya mwisho
⭐ upgrade → kuwa Premium
💬 maoni <ujumbe> → tuma maoni

Kidokezo: Andika tu ulichofanya kwa kawaida — nitaelewa!`
  },

  // ── CARS ─────────────────────────────────────────────────────────────────────

  no_cars: {
    en: `🚗 You haven't added any cars yet.\n\nSend your plate number to get started.\n\nExample: T123ABC`,
    sw: `🚗 Bado hujaongeza magari yoyote.\n\nTuma nambari ya usajili kuanza.\n\nMfano: T123ABC`
  },

  cars_footer: {
    en: (firstCarName) => `To log against a specific car:\nfuel 40k rav4\n\nTo switch active car:\nswitch to rav4\n\n➕ Add another car: add car`,
    sw: (firstCarName) => `Kurekodi kwa gari maalum:\nmafuta 40k rav4\n\nKubadili gari:\nbadili ${firstCarName}\n\n➕ Ongeza gari jingine: ongeza gari`
  },

  add_car_prompt: {
    en: `➕ Let's add a new car.\n\nWhat's the plate number?\n\nExample: T456DEF`,
    sw: `➕ Tuongeze gari jipya.\n\nNambari ya usajili ni nini?\n\nMfano: T456DEF`
  },

  add_car_premium_required: {
    en: `⭐ Adding multiple cars is a Premium feature.\n\nYou're currently on the free plan which includes 1 car.\n\nUpgrade for 5,000 TZS/month to add unlimited cars.\n\nType: upgrade`,
    sw: `⭐ Kuongeza magari mengi ni kipengele cha Premium.\n\nUpo kwenye mpango wa bure ambao unajumuisha gari 1.\n\nPanda daraja kwa TZS 5,000/mwezi kuongeza magari bila kikomo.\n\nAndika: upgrade`
  },

  car_name_exists: {
    en: (carName) => `You already have a car named "${carName}".\n\nPlease choose a different name.\n\nExamples:\n${carName} 2\nwork ${carName}`,
    sw: (carName) => `Una gari linaleitwa "${carName}" tayari.\n\nTafadhali chagua jina tofauti.\n\nMifano:\n${carName} 2\ngari la kazi`
  },

  plate_already_registered: {
    en: `⚠️ That plate number is already registered in the system.\n\nIf this is your car, contact us at contact@carlogbook.app to claim ownership.`,
    sw: `⚠️ Nambari hiyo ya usajili imesajiliwa tayari.\n\nIkiwa hii ni gari lako, wasiliana nasi: contact@carlogbook.app`
  },

  car_added_extra: {
    en: (carName, plate) => `✅ ${carName} (${plate}) has been added to your logbook.\n\nTo switch to this car:\nswitch to ${carName}`,
    sw: (carName, plate) => `✅ ${carName} (${plate}) imeongezwa kwenye daftari lako.\n\nKubadili gari hili:\nbadili ${carName}`
  },

  invalid_plate: {
    en: `That doesn't look like a valid plate number.\n\nTanzanian plates look like: T123ABC\n\nPlease try again or type "cancel" to go back.`,
    sw: `Hiyo haionekani kama nambari sahihi ya usajili.\n\nNambari za Tanzania zinaonekana hivi: T123ABC\n\nJaribu tena au andika "ghairi" kurudi nyuma.`
  },

  plate_received: {
    en: (plate) => `Got it — ${plate} ✅\n\nWhat would you like to call this car?\n\nExamples:\nRav4\nDad's car\nWork car`,
    sw: (plate) => `Nimepokea — ${plate} ✅\n\nUngependa kuita gari hili nini?\n\nMifano:\nRav4\nGari la baba\nGari la kazi`
  },

  // ── SWITCH CAR ────────────────────────────────────────────────────────────────

  switch_premium_required: {
    en: `⭐ Switching between cars is a Premium feature.\n\nType: upgrade`,
    sw: `⭐ Kubadili kati ya magari ni kipengele cha Premium.\n\nAndika: upgrade`
  },

  switch_car_not_found: {
    en: (carName) => `I couldn't find a car named "${carName}".\n\nYour cars:`,
    sw: (carName) => `Sikupata gari linaleitwa "${carName}".\n\nMagari yako:`
  },

  switch_car_success: {
    en: (carName) => `✅ Active car switched to ${carName}.\n\nLogs will now go to ${carName} by default.\n\nTo log:\nfuel 40k\nmileage 30402`,
    sw: (carName) => `✅ Gari la sasa limebadilishwa kuwa ${carName}.\n\nMaingizo yatakwenda kwa ${carName} kwa chaguo-msingi.\n\nKurekodi:\nmafuta 40k\nkilomita 30402`
  },

  // ── LOGGING ──────────────────────────────────────────────────────────────────

  log_limit_reached: {
    en: `You've reached today's free limit of 10 logs — the limit resets tomorrow.\n\nUpgrade for unlimited logging:\nupgrade`,
    sw: `Umefika kikomo cha bure cha maingizo 10 leo — kikomo kinarejea kesho.\n\nPanda daraja kwa maingizo bila kikomo:\nupgrade`
  },

  first_log: {
    en: `🎉 First log saved — you're off to a great start!\n\nKeep going:\n⛽ fuel 40k\n🔧 oil change 120k\n📏 mileage 30402\n📒 history`,
    sw: `🎉 Rekodi ya kwanza imehifadhiwa — umeanzia vizuri!\n\nEndelea:\n⛽ mafuta 40k\n🔧 oil change 120k\n📏 kilomita 30402\n📒 historia`
  },

  log_saved: {
    en: (carName, typeLabel, amount) => `✅ Log saved\n\nCar: ${carName}\n${typeLabel}: ${amount.toLocaleString()} TZS`,
    sw: (carName, typeLabel, amount) => `✅ Rekodi imehifadhiwa\n\nGari: ${carName}\n${typeLabel}: ${amount.toLocaleString()} TZS`
  },

  log_milestone: {
    en: (carName, typeLabel, amount, count) => `✅ Log saved\n\nCar: ${carName}\n${typeLabel}: ${amount.toLocaleString()} TZS\n\n🙌 ${count} logs and counting — great job staying on top of your car expenses!\n\n💬 Enjoying Car Logbook? We'd love to hear from you:\nfeedback <your message>`,
    sw: (carName, typeLabel, amount, count) => `✅ Rekodi imehifadhiwa\n\nGari: ${carName}\n${typeLabel}: ${amount.toLocaleString()} TZS\n\n🙌 Maingizo ${count} — hongera kwa kufuatilia gharama za gari lako!\n\n💬 Unafurahia Car Logbook? Tungependa kusikia kutoka kwako:\nmaoni <ujumbe wako>`
  },

  insurance_expiry_prompt: {
    en: `\n\nWould you like to set a reminder for when it expires?\n\nJust send the date:\ninsurance expiry 15 Aug 2026`,
    sw: `\n\nUngependa kuweka kikumbusho cha tarehe ya kumalizika?\n\nTuma tarehe tu:\nbima kumalizika 15 Aug 2026`
  },

  reminder_reset: {
    en: `\n\n🔔 Service reminder reset — I'll remind you again when it's due.`,
    sw: `\n\n🔔 Kikumbusho cha huduma kimewekwa upya — nitakukumbusha tena itakapohitajika.`
  },

  mileage_logged: {
    en: (mileage) => `📏 Mileage logged — ${mileage.toLocaleString()} km`,
    sw: (mileage) => `📏 Kilomita zimerekodiwa — ${mileage.toLocaleString()} km`
  },

  mileage_first_tip: {
    en: `\n\n📌 Tip: Keep logging mileage regularly and I'll track your total km driven each month in your monthly summary.`,
    sw: `\n\n📌 Kidokezo: Endelea kurekodi kilomita mara kwa mara na nitafuatilia jumla ya km uliyoendea kila mwezi.`
  },

  // ── HISTORY ──────────────────────────────────────────────────────────────────

  history_premium_required: {
    en: `⭐ This is a Premium feature.\n\nExtended history and per-car history are available on Premium.\n\nType: upgrade`,
    sw: `⭐ Hii ni kipengele cha Premium.\n\nHistoria iliyopanuliwa na historia kwa kila gari zinapatikana kwa Premium.\n\nAndika: upgrade`
  },

  history_limit_reached: {
    en: `You've checked your history 3 times today — the limit resets tomorrow.\n\nUpgrade for unlimited history access:\nupgrade`,
    sw: `Umekagua historia yako mara 3 leo — kikomo kinarejea kesho.\n\nPanda daraja kwa ufikiaji wa historia bila kikomo:\nupgrade`
  },

  history_no_logs: {
    en: (carName, isMonth) => `📒 No logs found for ${carName}${isMonth ? " this month" : ""}.\n\nStart logging:\nfuel 40k`,
    sw: (carName, isMonth) => `📒 Hakuna maingizo kwa ${carName}${isMonth ? " mwezi huu" : ""}.\n\nAnza kurekodi:\nmafuta 40k`
  },

  history_car_not_found: {
    en: (carName) => `I couldn't find a car named "${carName}".\n\nYour cars:`,
    sw: (carName) => `Sikupata gari linaleitwa "${carName}".\n\nMagari yako:`
  },

  // ── UNDO ─────────────────────────────────────────────────────────────────────

  undo_no_car: {
    en: `Hmm, I couldn't find a car to undo a log for.\n\nMake sure you have a car registered:\ncars`,
    sw: `Sikupata gari la kufuta rekodi yake.\n\nHakikisha una gari lililosajiliwa:\nmagari`
  },

  undo_limit_reached: {
    en: `You've used your 3 undos for today — the limit resets tomorrow.\n\nUpgrade for unlimited undos:\nupgrade`,
    sw: `Umetumia nafasi zako 3 za kufuta leo — kikomo kinarejea kesho.\n\nPanda daraja kwa ufutaji bila kikomo:\nupgrade`
  },

  undo_success: {
    en: `↩️ Done! Your last log has been removed.`,
    sw: `↩️ Imefanyika! Rekodi yako ya mwisho imeondolewa.`
  },

  undo_nothing: {
    en: `Nothing to undo — there are no logs yet for this car.`,
    sw: `Hakuna cha kufuta — bado hakuna maingizo kwa gari hili.`
  },

  // ── INSURANCE EXPIRY ──────────────────────────────────────────────────────────

  insurance_expiry_no_car: {
    en: `You need to have a car registered to set an insurance expiry date.\n\nType: cars`,
    sw: `Unahitaji gari lililosajiliwa kuweka tarehe ya kumalizika kwa bima.\n\nAndika: magari`
  },

  insurance_expiry_invalid_date: {
    en: `I couldn't read that date. Please use a clear format.\n\nExamples:\ninsurance expiry 15 Aug 2026\ninsurance expiry 2026-08-15`,
    sw: `Sikuweza kusoma tarehe hiyo. Tafadhali tumia muundo wazi.\n\nMifano:\nbima kumalizika 15 Aug 2026\nbima kumalizika 2026-08-15`
  },

  insurance_expiry_saved: {
    en: (carName, displayDate, isPremiumUser) => `✅ Insurance expiry saved for ${carName}.\n\nExpiry date: ${displayDate}${!isPremiumUser ? "\n\nReminders at 30, 7, and 1 day before expiry are a Premium feature.\n\nType: upgrade" : "\n\nI'll remind you 30 days, 7 days, and 1 day before it expires."}`,
    sw: (carName, displayDate, isPremiumUser) => `✅ Tarehe ya kumalizika kwa bima imehifadhiwa kwa ${carName}.\n\nTarehe ya kumalizika: ${displayDate}${!isPremiumUser ? "\n\nVikumbusho siku 30, 7, na 1 kabla ya kumalizika ni kipengele cha Premium.\n\nAndika: upgrade" : "\n\nNitakukumbusha siku 30, siku 7, na siku 1 kabla ya kumalizika."}`
  },

  // ── REMINDERS ────────────────────────────────────────────────────────────────

  reminder_frequency_invalid: {
    en: `To set your reminder frequency, reply with one of:\n\nreminders weekly\nreminders fortnightly\nreminders monthly\nreminders off`,
    sw: `Kuweka mara ya vikumbusho, jibu na moja ya:\n\nvikumbusho wiki\nvikumbusho wiki mbili\nvikumbusho mwezi\nvikumbusho zima`
  },

  reminder_frequency_off: {
    en: `🔕 Got it — no more logging reminders.\n\nYou can turn them back on anytime:\nreminders weekly`,
    sw: `🔕 Sawa — hakuna vikumbusho zaidi vya kurekodi.\n\nUnaweza kuviwasha tena wakati wowote:\nvikumbusho wiki`
  },

  reminder_frequency_set: {
    en: (option, days) => `✅ Reminders set to ${option}.\n\nI'll nudge you if you haven't logged anything in ${days}.`,
    sw: (option, days) => `✅ Vikumbusho vimewekwa kuwa ${option}.\n\nNitakukumbusha ikiwa haujarekodia chochote kwa ${days}.`
  },

  reminder_new_user: {
    en: (name) => `👋 Hey ${name}! Just a nudge — have you logged your car expenses recently?\n\nKeeping your logbook up to date takes just a few seconds:\n\n⛽ fuel 40k\n🔧 oil change 120k\n📏 mileage 30402\n\nI'll check in every 3 days while you're getting started — building the habit early makes all the difference! 🚗\n\n─────────────────\nTo change reminder frequency:\nreminders weekly\nreminders off`,
    sw: (name) => `👋 Habari ${name}! Ukumbusho tu — je, umerekodia gharama za gari lako hivi karibuni?\n\nKuweka daftari lako la kisasa kunachukua sekunde chache tu:\n\n⛽ mafuta 40k\n🔧 oil change 120k\n📏 kilomita 30402\n\nNitakukagua kila siku 3 unapoanza — kujenga tabia mapema kunafanya tofauti kubwa! 🚗\n\n─────────────────\nKubadili mara ya vikumbusho:\nvikumbusho wiki\nvikumbusho zima`
  },

  reminder_transition: {
    en: (name) => `👋 Hey ${name}! You've been using Car Logbook for a month — great work staying on top of your car expenses! 🎉\n\nI'll now check in weekly instead of every 3 days. You can always adjust this:\n\nreminders weekly\nreminders fortnightly\nreminders monthly\nreminders off`,
    sw: (name) => `👋 Habari ${name}! Umetumia Car Logbook kwa mwezi mmoja — hongera kwa kufuatilia gharama za gari lako! 🎉\n\nSasa nitakukagua kila wiki badala ya kila siku 3. Unaweza kubadilisha hili wakati wowote:\n\nvikumbusho wiki\nvikumbusho wiki mbili\nvikumbusho mwezi\nvikumbusho zima`
  },

  dropoff_nudge_day1: {
    en: (name) => `👋 Hey ${name}! Just checking in — have you had a chance to log your first expense yet?\n\nIt takes 5 seconds:\n⛽ fuel 40k\n\nOnce you've done your first log, you'll see how easy it is to keep going. 🚗`,
    sw: (name) => `👋 Habari ${name}! Nakagua tu — je, umeweza kurekodi gharama yako ya kwanza bado?\n\nInachukua sekunde 5:\n⛽ mafuta 40k\n\nUkifanya ingizo lako la kwanza, utaona jinsi ilivyo rahisi kuendelea. 🚗`
  },

  dropoff_nudge_day3: {
    en: (name) => `👋 Hey ${name}! Still here when you're ready.\n\nTracking even just fuel takes 5 seconds and adds up to real insight over time — you'll always know what your car is costing you.\n\n⛽ fuel 40k\n\nGive it a try!`,
    sw: (name) => `👋 Habari ${name}! Bado nipo hapa ukiwa tayari.\n\nKufuatilia hata mafuta tu kunachukua sekunde 5 na kutoa maarifa ya kweli kwa muda — utajua kila wakati gari lako linakugharimu kiasi gani.\n\n⛽ mafuta 40k\n\nJaribu!`
  },

  dropoff_nudge_day7: {
    en: (name) => `👋 Last nudge from me, ${name} — your Car Logbook is set up and ready whenever you need it.\n\nWhenever you fill up or do a service, just type:\n⛽ fuel 40k\n🔧 oil change 120k\n\nI'll be here. 🚗`,
    sw: (name) => `👋 Ukumbusho wa mwisho kutoka kwangu, ${name} — Car Logbook yako imewekwa na iko tayari ukihitaji.\n\nUkijaza mafuta au kufanya huduma, andika tu:\n⛽ mafuta 40k\n🔧 oil change 120k\n\nNitakuwepo. 🚗`
  },

  dropoff_no_car: {
    en: (name) => `👋 Hey ${name}! You started setting up Car Logbook but didn't finish adding your car.\n\nPick up where you left off — what's your car's plate number?\n\nExample: T123ABC`,
    sw: (name) => `👋 Habari ${name}! Ulianza kusanidi Car Logbook lakini hukumaliza kuongeza gari lako.\n\nEndelea ulipoacha — nambari ya usajili wa gari lako ni nini?\n\nMfano: T123ABC`
  },

  dropoff_stuck_plate: {
    en: (name) => `👋 Hey ${name}! It looks like you were in the middle of adding a car.\n\nWhat's the plate number?\n\nExample: T123ABC\n\nOr type "cancel" to start over.`,
    sw: (name) => `👋 Habari ${name}! Inaonekana ulikuwa ukiongeza gari.\n\nNambari ya usajili ni nini?\n\nMfano: T123ABC\n\nAu andika "ghairi" kuanza upya.`
  },

  service_reminder_premium_required: {
    en: `⭐ Service reminders are a Premium feature.\n\nUpgrade to set reminders for oil changes, tyre rotations, and more:\nupgrade`,
    sw: `⭐ Vikumbusho vya huduma ni kipengele cha Premium.\n\nPanda daraja kuweka vikumbusho vya kubadilisha mafuta, kuzungusha matairi, na zaidi:\nupgrade`
  },

  service_reminder_no_car: {
    en: `You need a car registered before setting service reminders.\n\nType: cars`,
    sw: `Unahitaji gari lililosajiliwa kabla ya kuweka vikumbusho vya huduma.\n\nAndika: magari`
  },

  service_reminder_invalid_format: {
    en: `I didn't understand that reminder format.\n\nExamples:\nremind oil change every 5000km\nremind tyre every 10000km\nremind service every 90 days\n\nTo see your reminders:\nreminders list`,
    sw: `Sikuelewa muundo huo wa kikumbusho.\n\nMifano:\nkumbuka oil change kila 5000km\nkumbuka tairi kila 10000km\nkumbuka huduma kila siku 90\n\nKuona vikumbusho vyako:\norodha ya vikumbusho`
  },

  service_reminder_set: {
    en: (label, carName, intervalLabel, serviceRaw) => `✅ Reminder set — ${label} for ${carName}\n\nI'll remind you ${intervalLabel}.\n\nTo see all reminders:\nreminders list\n\nTo remove it:\nreminders clear ${serviceRaw}`,
    sw: (label, carName, intervalLabel, serviceRaw) => `✅ Kikumbusho kimewekwa — ${label} kwa ${carName}\n\nNitakukumbusha ${intervalLabel}.\n\nKuona vikumbusho vyote:\norodha ya vikumbusho\n\nKuondoa:\nfuta kikumbusho ${serviceRaw}`
  },

  reminders_list_no_car: {
    en: `No active car found.\n\nType: cars`,
    sw: `Hakuna gari hai lililopatikana.\n\nAndika: magari`
  },

  reminders_list_empty: {
    en: (carName) => `No service reminders set for ${carName}.\n\nTo add one:\nremind oil change every 5000km`,
    sw: (carName) => `Hakuna vikumbusho vya huduma vilivyowekwa kwa ${carName}.\n\nKuongeza:\nkumbuka oil change kila 5000km`
  },

  reminders_list_footer: {
    en: `To remove a reminder:\nreminders clear oil change`,
    sw: `Kuondoa kikumbusho:\nfuta kikumbusho oil change`
  },

  reminders_clear_not_found: {
    en: (label) => `No reminder found for "${label}".\n\nTo see your reminders:\nreminders list`,
    sw: (label) => `Hakuna kikumbusho kilichopatikana kwa "${label}".\n\nKuona vikumbusho vyako:\norodha ya vikumbusho`
  },

  reminders_clear_success: {
    en: (label) => `✅ Reminder removed — ${label}.\n\nTo see remaining reminders:\nreminders list`,
    sw: (label) => `✅ Kikumbusho kimeondolewa — ${label}.\n\nKuona vikumbusho vilivyobaki:\norodha ya vikumbusho`
  },

  // ── CITY ─────────────────────────────────────────────────────────────────────

  city_missing: {
    en: `Please include your city name.\n\nExample:\nmy city Arusha`,
    sw: `Tafadhali jumuisha jina la jiji lako.\n\nMfano:\njiji langu Arusha`
  },

  city_premium_required: {
    en: (city) => `⭐ Changing your city is a Premium feature.\n\nYour current city: ${city}\n\nUpgrade to update it: upgrade`,
    sw: (city) => `⭐ Kubadili jiji lako ni kipengele cha Premium.\n\nJiji lako la sasa: ${city}\n\nPanda daraja kusasisha: upgrade`
  },

  city_updated: {
    en: (city) => `✅ City updated to ${city}.\n\nI'll now show you local fuel prices and city-specific updates.`,
    sw: (city) => `✅ Jiji limesasishwa kuwa ${city}.\n\nSasa nitakuonyesha bei za mafuta za mtaa na habari maalum za jiji.`
  },

  // ── UPGRADE ──────────────────────────────────────────────────────────────────

  already_premium: {
    en: (planLabel, expiryDate) => `⭐ You're already a Premium user!\n\nYour Premium features are active:\n• Multiple cars\n• Full history access\n• More coming soon\n${expiryDate ? `\nPlan: ${planLabel}\nRenews on: ${expiryDate}` : ""}\nThank you for supporting Car Logbook! 🙏`,
    sw: (planLabel, expiryDate) => `⭐ Wewe ni mtumiaji wa Premium tayari!\n\nVipengele vyako vya Premium viko hai:\n• Magari mengi\n• Ufikiaji kamili wa historia\n• Zaidi inakuja hivi karibuni\n${expiryDate ? `\nMpango: ${planLabel}\nInahuishwa: ${expiryDate}` : ""}\nAsante kwa kusaidia Car Logbook! 🙏`
  },

  // ── PAYMENT ───────────────────────────────────────────────────────────────────

  cancel_payment_none: {
    en: `You don't have any pending payments to cancel.`,
    sw: `Huna malipo yoyote yanayosubiri kughairiwa.`
  },

  cancel_payment_success: {
    en: (txnId) => `✅ Your pending payment (${txnId}) has been cancelled.\n\nIf you'd like to try again, type: upgrade`,
    sw: (txnId) => `✅ Malipo yako yanayosubiri (${txnId}) yameghairiwa.\n\nUkitaka kujaribu tena, andika: upgrade`
  },

  paid_no_txn: {
    en: `Please include your transaction ID.\n\nExample:\npaid QHG72K3`,
    sw: `Tafadhali jumuisha nambari ya muamala.\n\nMfano:\nlimelipwa QHG72K3`
  },

  paid_txn_not_found: {
    en: `I couldn't find a transaction ID in that message.\n\nPlease send just the transaction ID:\n\npaid QHG72K3\n\nOr contact us at contact@carlogbook.app if you need help.`,
    sw: `Sikupata nambari ya muamala katika ujumbe huo.\n\nTafadhali tuma nambari ya muamala tu:\n\nlimelipwa QHG72K3\n\nAu wasiliana nasi: contact@carlogbook.app`
  },

  paid_already_pending: {
    en: (txnId) => `You already have a pending payment (${txnId}).\n\nWe'll notify you once it's verified. This usually takes a few hours.\n\nMade a mistake? Type: cancel payment\n\nQuestions? contact@carlogbook.app`,
    sw: (txnId) => `Una malipo yanayosubiri (${txnId}) tayari.\n\nTutakujulisha baada ya kuthibitishwa. Hii kawaida inachukua masaa machache.\n\nUlifanya kosa? Andika: ghairi malipo\n\nMaswali? contact@carlogbook.app`
  },

  paid_duplicate: {
    en: `⚠️ That transaction ID has already been submitted.\n\nIf you think this is a mistake, contact us at:\ncontact@carlogbook.app`,
    sw: `⚠️ Nambari hiyo ya muamala imewasilishwa tayari.\n\nUkidhani hii ni kosa, wasiliana nasi:\ncontact@carlogbook.app`
  },

  paid_received: {
    en: (txnId) => `✅ Got it! Your payment is being verified.\n\nTransaction ID: ${txnId}\n\nYou'll receive a confirmation message shortly.\n\nMade a mistake? Type: cancel payment\n\nQuestions? contact@carlogbook.app`,
    sw: (txnId) => `✅ Nimepokea! Malipo yako yanakaguliwa.\n\nNambari ya muamala: ${txnId}\n\nUtapokea ujumbe wa uthibitisho hivi karibuni.\n\nUlifanya kosa? Andika: ghairi malipo\n\nMaswali? contact@carlogbook.app`
  },

  // ── PHOTO ─────────────────────────────────────────────────────────────────────

  photo_premium_required: {
    en: `📷 Photo logging is a Premium feature.\n\nUpgrade to log expenses by photo — I'll read the receipt or product label for you.\n\nType: upgrade`,
    sw: `📷 Kurekodi kwa picha ni kipengele cha Premium.\n\nPanda daraja kurekodi gharama kwa picha — nitasoma risiti au lebo ya bidhaa kwa ajili yako.\n\nAndika: upgrade`
  },

  photo_no_car: {
    en: `📷 Got your photo! You'll need to add a car first before logging expenses.\n\nType: add car`,
    sw: `📷 Nimepokea picha yako! Unahitaji kuongeza gari kwanza kabla ya kurekodi gharama.\n\nAndika: ongeza gari`
  },

  photo_analyzing: {
    en: `📷 Analyzing your photo...`,
    sw: `📷 Ninachambua picha yako...`
  },

  photo_amount_prompt: {
    en: `I need the amount to log this.\n\nHow much did you pay? (e.g. 120k)\n\nOr type "cancel" to skip.`,
    sw: `Ninahitaji kiasi ili kurekodi hili.\n\nUliilipa kiasi gani? (mfano: 120k)\n\nAu andika "ghairi" kuruka.`
  },

  photo_logged: {
    en: (carName, typeLabel, amount, description) => `✅ Logged from photo!\n\nCar: ${carName}\n${typeLabel}: ${amount.toLocaleString()} TZS\n\n📷 ${description || "Photo attached"}`,
    sw: (carName, typeLabel, amount, description) => `✅ Imerekodiwa kutoka kwa picha!\n\nGari: ${carName}\n${typeLabel}: ${amount.toLocaleString()} TZS\n\n📷 ${description || "Picha imeambatishwa"}`
  },

  // ── FEEDBACK ──────────────────────────────────────────────────────────────────

  feedback_missing: {
    en: `Please include your message after "feedback".\n\nExample:\nfeedback the bot didn't understand my message`,
    sw: `Tafadhali jumuisha ujumbe wako baada ya "maoni".\n\nMfano:\nmaoni bot haikuelewa ujumbe wangu`
  },

  feedback_thanks: {
    en: (name) => `Thanks for the feedback, ${name}! 🙏\n\nWe read every message and use it to make Car Logbook better.`,
    sw: (name) => `Asante kwa maoni, ${name}! 🙏\n\nTunasoma kila ujumbe na kuutumia kuboresha Car Logbook.`
  },

  // ── MULTIPLE CARS DETECTED ────────────────────────────────────────────────────

  multiple_cars_detected: {
    en: `I found a few cars in your message — which one did you mean?\n\nTip: Include the car name clearly, e.g:\nfuel 40k rav4`,
    sw: `Nilipata magari kadhaa katika ujumbe wako — ulimaanisha gani?\n\nKidokezo: Jumuisha jina la gari wazi, mfano:\nmafuta 40k rav4`
  },

  // ── AI FALLBACK ───────────────────────────────────────────────────────────────

  ai_fallback_default: {
    en: `Hmm, I didn't quite get that. 🤔\n\nHere are some things you can try:\n\n⛽ fuel 40k\n🔧 oil change 120k\n📏 mileage 30402\n📒 history\n🚗 cars\n\nOr type "help" for the full guide.\n\n💬 Something not working as expected?\nfeedback <your message>`,
    sw: `Hmm, sikuelewa vizuri. 🤔\n\nHapa kuna mambo unayoweza kujaribu:\n\n⛽ mafuta 40k\n🔧 oil change 120k\n📏 kilomita 30402\n📒 historia\n🚗 magari\n\nAu andika "help" kwa mwongozo kamili.\n\n💬 Kitu hakifanyi kazi kama inavyotarajiwa?\nmaoni <ujumbe wako>`
  }
};

// ─── TRANSLATION HELPER ───────────────────────────────────────────────────────
// Usage:
//   t(user, 'cancelled')                     → string
//   t(user, 'welcome_new_user', name)        → string (function key)
//   t(user, 'log_saved', carName, label, amt) → string (function key, multiple args)

function t(user, key, ...args) {
  const lang = user?.language || "en";
  const entry = translations[key];

  if (!entry) {
    console.warn(`[i18n] Missing translation key: "${key}"`);
    return "";
  }

  const value = entry[lang] ?? entry["en"];

  if (typeof value === "function") {
    return value(...args);
  }

  return value;
}

// ─── LABEL HELPERS ────────────────────────────────────────────────────────────

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

// ─── MISC ─────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function reminderDays(frequency) {
  const map = { "3days": 3, "7days": 7, "14days": 14, "30days": 30 };
  return map[frequency] || 7;
}

function isPlateNumber(text) {
  return /^T[0-9]{3}[A-Z]{3}$/i.test(text.trim().replace(/\s+/g, ""));
}

function isMileage(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("mileage") ||
    lower.includes("kilomita") ||
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

// ─── SERVICE REMINDER HELPERS ─────────────────────────────────────────────────

function normalizeServiceType(text) {
  const lower = text.toLowerCase().trim();
  const map = {
    // English
    "oil change":   "oil_change",
    "engine oil":   "oil_change",
    "oil filter":   "oil_filter",
    "fuel filter":  "fuel_filter",
    "air filter":   "air_filter",
    "air cleaner":  "air_filter",
    "coolant":      "coolant",
    "gearbox oil":  "gearbox_oil",
    "gearbox":      "gearbox_oil",
    "battery":      "battery",
    "tyres":        "tyre",
    "tyre":         "tyre",
    "brakes":       "brake",
    "brake":        "brake",
    "wiper":        "wiper",
    "wipers":       "wiper",
    "service":      "service",
    "full service": "service",
    // Swahili
    "mafuta ya injini": "oil_change",
    "mafuta injini":    "oil_change",
    "chujio la mafuta": "oil_filter",
    "chujio mafuta":    "oil_filter",
    "chujio la dizeli": "fuel_filter",
    "chujio hewa":      "air_filter",
    "kipozea":          "coolant",
    "mafuta ya gearbox":"gearbox_oil",
    "betri":            "battery",
    "tairi":            "tyre",
    "matairi":          "tyre",
    "breki":            "brake",
    "mswaki":           "wiper",
    "huduma":           "service",
    "huduma kamili":    "service"
  };
  return map[lower] || lower.replace(/\s+/g, "_");
}

function serviceTypeLabel(key) {
  const labels = {
    oil_change:  "Oil Change",
    oil_filter:  "Oil Filter",
    fuel_filter: "Fuel Filter",
    air_filter:  "Air Filter",
    coolant:     "Coolant",
    gearbox_oil: "Gearbox Oil",
    battery:     "Battery",
    tyre:        "Tyres",
    brake:       "Brakes",
    wiper:       "Wiper Blades",
    service:     "Full Service"
  };
  return labels[key] || key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// ─── SWAHILI LANGUAGE DETECTION ───────────────────────────────────────────────
// Returns true if the message appears to be written in Swahili
// Used for auto-detect before language preference is set

const swahiliIndicators = [
  "mafuta", "kilomita", "historia", "magari", "ongeza gari",
  "ghairi", "msaada", "bima", "matengenezo", "betri", "tairi",
  "breki", "huduma", "limelipwa", "maoni", "jiji langu",
  "badili", "vikumbusho", "lugha", "habari", "karibu", "sawa",
  "ndiyo", "hapana", "asante", "tafadhali"
];

function looksLikeSwahili(text) {
  const lower = text.toLowerCase();
  return swahiliIndicators.some(word => lower.includes(word));
}

module.exports = {
  isPremium,
  isActivePremiumUser,
  subtypeLabel,
  normalizeServiceType,
  serviceTypeLabel,
  sleep,
  reminderDays,
  isPlateNumber,
  isMileage,
  extractMileage,
  looksLikeSwahili,
  t
};