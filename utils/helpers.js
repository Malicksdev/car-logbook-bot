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
  const map = { "7days": 7, "14days": 14, "30days": 30 };
  return map[frequency] || 7;
}

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

module.exports = {
  isPremium,
  isActivePremiumUser,
  subtypeLabel,
  sleep,
  reminderDays,
  isPlateNumber,
  isMileage,
  extractMileage
};