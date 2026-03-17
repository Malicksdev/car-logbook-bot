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
  if (
    lower.includes("fuel") ||
    lower.includes("mafuta") ||       // Swahili: fuel/oil (context-dependent, checked before oil subtypes)
    lower.includes("petrol") ||
    lower.includes("diesel")
  ) {
    // Guard: "mafuta ya injini" and similar oil phrases should fall through to maintenance below.
    // Only treat as fuel if it's a plain "mafuta" without a qualifying phrase.
    const isEngineoil =
      lower.includes("mafuta ya injini") ||
      lower.includes("mafuta injini") ||
      lower.includes("mafuta ya gearbox") ||
      lower.includes("mafuta gearbox");

    if (!isEngineoil) {
      return { type: "fuel", subtype: null };
    }
  }

  // ── INSURANCE ─────────────────────────────────────────────────────────────
  if (
    lower.includes("insurance") ||
    lower.includes("bima")             // Swahili: insurance
  ) {
    return { type: "insurance", subtype: null };
  }

  // ── MAINTENANCE SUBTYPES ───────────────────────────────────────────────────

  if (
    lower.includes("engine oil") ||
    lower.includes("motor oil") ||
    lower.includes("mafuta ya injini") ||   // Swahili: engine oil
    lower.includes("mafuta injini") ||
    lower.includes("oil ya gari") ||        // Mixed Swahili-English: oil for the car
    lower.includes("oil ya injini") ||      // Mixed: engine oil
    lower.includes("oil ya motor")          // Mixed: motor oil
  ) {
    return { type: "maintenance", subtype: "engine_oil" };
  }

  if (
    lower.includes("oil filter") ||
    lower.includes("chujio la mafuta") ||   // Swahili: oil filter
    lower.includes("chujio mafuta")
  ) {
    return { type: "maintenance", subtype: "oil_filter" };
  }

  if (
    lower.includes("fuel filter") ||
    lower.includes("chujio la dizeli") ||   // Swahili: fuel filter
    lower.includes("chujio dizeli")
  ) {
    return { type: "maintenance", subtype: "fuel_filter" };
  }

  if (
    lower.includes("air cleaner") ||
    lower.includes("air filter") ||
    lower.includes("chujio hewa")           // Swahili: air filter
  ) {
    return { type: "maintenance", subtype: "air_filter" };
  }

  if (
    lower.includes("coolant") ||
    lower.includes("radiator") ||
    lower.includes("kipozea")              // Swahili: coolant
  ) {
    return { type: "maintenance", subtype: "coolant" };
  }

  if (
    lower.includes("gearbox oil") ||
    lower.includes("gearbox") ||
    lower.includes("mafuta ya gearbox") || // Swahili: gearbox oil
    lower.includes("mafuta gearbox")
  ) {
    return { type: "maintenance", subtype: "gearbox_oil" };
  }

  if (
    lower.includes("hydraulic fluid") ||
    lower.includes("hydraulic")
  ) {
    return { type: "maintenance", subtype: "hydraulic" };
  }

  if (
    lower.includes("battery") ||
    lower.includes("betri")                // Swahili: battery
  ) {
    return { type: "maintenance", subtype: "battery" };
  }

  if (
    lower.includes("tyre") ||
    lower.includes("tire") ||
    lower.includes("tyres") ||
    lower.includes("tires") ||
    lower.includes("tairi") ||             // Swahili: tyre
    lower.includes("matairi")             // Swahili: tyres
  ) {
    return { type: "maintenance", subtype: "tyre" };
  }

  if (
    lower.includes("wiper blade") ||
    lower.includes("wiper") ||
    lower.includes("mswaki")              // Swahili: wiper
  ) {
    return { type: "maintenance", subtype: "wiper" };
  }

  if (
    lower.includes("brake") ||
    lower.includes("brakes") ||
    lower.includes("brake pad") ||
    lower.includes("breki")               // Swahili: brake
  ) {
    return { type: "maintenance", subtype: "brake" };
  }

  if (
    lower.includes("wash") ||
    lower.includes("car wash") ||
    lower.includes("osha gari") ||        // Swahili: wash car
    lower.includes("kunawa gari")
  ) {
    return { type: "maintenance", subtype: "wash" };
  }

  if (
    lower.includes("service") ||
    lower.includes("huduma")              // Swahili: service
  ) {
    return { type: "maintenance", subtype: "service" };
  }

  // generic oil falls here if not matched above (e.g. just "oil 30k")
  if (lower.includes("oil")) {
    return { type: "maintenance", subtype: "engine_oil" };
  }

  if (
    lower.includes("repair") ||
    lower.includes("maintenance") ||
    lower.includes("matengenezo") ||      // Swahili: maintenance
    lower.includes("kutengeneza")         // Swahili: to repair
  ) {
    return { type: "maintenance", subtype: null };
  }

  return { type: "other", subtype: null };
}

// Keywords that indicate a message is a log entry.
// Used to prevent SMS dumps being parsed as logs.
function looksLikeLog(text) {
  const lower = text.toLowerCase();
  const logKeywords = [
    // English
    "fuel", "petrol", "diesel",
    "oil", "service", "brake", "brakes",
    "insurance",
    "mileage", "km", "kms", "miles",
    "maintenance", "repair",
    "tyre", "tire", "tyres", "tires",
    "wash", "car wash",
    "air cleaner", "air filter",
    "coolant", "radiator",
    "gearbox", "hydraulic",
    "battery",
    "wiper", "filter",
    // Swahili
    "mafuta",        // fuel / oil
    "oil ya",        // mixed Swahili-English: oil ya gari, oil ya injini
    "bima",          // insurance
    "kilomita",      // mileage
    "matengenezo",   // maintenance
    "kutengeneza",   // repair
    "tairi",         // tyre
    "matairi",       // tyres
    "betri",         // battery
    "breki",         // brake
    "huduma",        // service
    "kipozea",       // coolant
    "chujio",        // filter (oil/air/fuel)
    "mswaki",        // wiper
    "osha gari",     // car wash
    "kunawa gari"    // car wash
  ];
  return logKeywords.some(k => lower.includes(k));
}

module.exports = { parseAmount, detectType, looksLikeLog };