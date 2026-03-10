// FIX: handle commas, k/K suffix, and M/m suffix (millions)
// Also handles decimals like 1.2M → 1,200,000
function parseAmount(text) {
  const match = text.match(/\b([\d,]+\.?\d*[kKmM]?)\b/);
  if (!match) return null;

  let value = match[0].replace(/,/g, "").toLowerCase();

  if (value.endsWith("m")) {
    const num = parseFloat(value.replace("m", ""));
    return Math.round(num * 1000000);
  }

  if (value.endsWith("k")) {
    const num = parseFloat(value.replace("k", ""));
    return Math.round(num * 1000);
  }

  return parseInt(value);
}

// Returns { type, subtype }
function detectType(text) {
  const lower = text.toLowerCase();

  // ── FUEL ──────────────────────────────────────────────────────────────────
  if (lower.includes("fuel") || lower.includes("mafuta") || lower.includes("petrol") || lower.includes("diesel")) {
    return { type: "fuel", subtype: null };
  }

  // ── INSURANCE ─────────────────────────────────────────────────────────────
  if (lower.includes("insurance") || lower.includes("bima")) {
    return { type: "insurance", subtype: null };
  }

  // ── MAINTENANCE SUBTYPES ───────────────────────────────────────────────────

  if (lower.includes("engine oil") || lower.includes("motor oil")) {
    return { type: "maintenance", subtype: "engine_oil" };
  }

  if (lower.includes("oil filter")) {
    return { type: "maintenance", subtype: "oil_filter" };
  }

  if (lower.includes("fuel filter")) {
    return { type: "maintenance", subtype: "fuel_filter" };
  }

  if (lower.includes("air cleaner") || lower.includes("air filter")) {
    return { type: "maintenance", subtype: "air_filter" };
  }

  if (lower.includes("coolant") || lower.includes("radiator")) {
    return { type: "maintenance", subtype: "coolant" };
  }

  if (lower.includes("gearbox oil") || lower.includes("gearbox")) {
    return { type: "maintenance", subtype: "gearbox_oil" };
  }

  if (lower.includes("hydraulic fluid") || lower.includes("hydraulic")) {
    return { type: "maintenance", subtype: "hydraulic" };
  }

  if (lower.includes("battery") || lower.includes("betri")) {
    return { type: "maintenance", subtype: "battery" };
  }

  if (lower.includes("tyre") || lower.includes("tire") || lower.includes("tyres") || lower.includes("tires")) {
    return { type: "maintenance", subtype: "tyre" };
  }

  if (lower.includes("wiper blade") || lower.includes("wiper")) {
    return { type: "maintenance", subtype: "wiper" };
  }

  if (lower.includes("brake") || lower.includes("brakes") || lower.includes("brake pad")) {
    return { type: "maintenance", subtype: "brake" };
  }

  if (lower.includes("wash") || lower.includes("car wash")) {
    return { type: "maintenance", subtype: "wash" };
  }

  if (lower.includes("service")) {
    return { type: "maintenance", subtype: "service" };
  }

  // generic oil falls here if not matched above (e.g. just "oil 30k")
  if (lower.includes("oil")) {
    return { type: "maintenance", subtype: "engine_oil" };
  }

  if (lower.includes("repair") || lower.includes("maintenance")) {
    return { type: "maintenance", subtype: null };
  }

  return { type: "other", subtype: null };
}

// Keywords that indicate a message is a log entry
// Used to prevent SMS dumps being parsed as logs
function looksLikeLog(text) {
  const lower = text.toLowerCase();
  const logKeywords = [
    "fuel", "mafuta", "petrol", "diesel",
    "oil", "service", "brake", "brakes",
    "insurance", "bima",
    "mileage", "km", "kms", "miles",
    "maintenance", "repair",
    "tyre", "tire", "tyres", "tires",
    "wash", "car wash",
    "air cleaner", "air filter",
    "coolant", "radiator",
    "gearbox", "hydraulic",
    "battery", "betri",
    "wiper", "filter"
  ];
  return logKeywords.some(k => lower.includes(k));
}

module.exports = { parseAmount, detectType, looksLikeLog };