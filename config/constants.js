// ─── FEATURE FLAGS ────────────────────────────────────────────────────────────

// Set to true to enforce free vs premium restrictions
const PREMIUM_ENABLED = false;

// AI fallback: max calls per user per day (applies when PREMIUM_ENABLED = true)
const AI_FALLBACK_DAILY_LIMIT = 3;

// ─── ENVIRONMENT ──────────────────────────────────────────────────────────────

const ADMIN_PHONE = process.env.ADMIN_PHONE;
const MPESA_NUMBER = process.env.MPESA_NUMBER || "XXXXXXX";

module.exports = {
  PREMIUM_ENABLED,
  AI_FALLBACK_DAILY_LIMIT,
  ADMIN_PHONE,
  MPESA_NUMBER
};