const supabase = require("../config/supabase");

const LIMITS = {
  log_count:        10,
  history_count:    3,
  undo_count:       3,
  ai_fallback_count: 10
};

// Get today's usage row for a user (creates it if it doesn't exist)
async function getDailyUsage(userId) {
  const today = new Date().toISOString().split("T")[0]; // "YYYY-MM-DD"

  const { data: existing } = await supabase
    .from("daily_usage")
    .select("*")
    .eq("user_id", userId)
    .eq("date", today)
    .single();

  if (existing) return existing;

  const { data: created } = await supabase
    .from("daily_usage")
    .insert({ user_id: userId, date: today })
    .select()
    .single();

  return created;
}

// Returns true if user is under the limit, false if they've hit it
async function checkLimit(userId, field) {
  const usage = await getDailyUsage(userId);
  if (!usage) return true; // fail open — don't block if DB error
  const limit = LIMITS[field];
  if (limit === undefined) return true; // unknown field — fail open
  return (usage[field] || 0) < limit;
}

// Increment a usage counter for today
async function incrementUsage(userId, field) {
  const usage = await getDailyUsage(userId);
  if (!usage) return;

  const currentValue = usage[field] || 0;

  await supabase
    .from("daily_usage")
    .update({ [field]: currentValue + 1 })
    .eq("user_id", userId)
    .eq("date", usage.date);
}

module.exports = { checkLimit, incrementUsage, LIMITS };