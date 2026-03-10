// FIX: handle commas in amounts e.g. "fuel 1,200,000" → 1200000
function parseAmount(text) {
  const match = text.match(/\b([\d,]+[kK]?)\b/);
  if (!match) return null;
  let value = match[0].replace(/,/g, "").toLowerCase();
  if (value.includes("k")) return parseInt(value.replace("k", "")) * 1000;
  return parseInt(value);
}

function detectType(text) {
  text = text.toLowerCase();
  if (text.includes("fuel") || text.includes("mafuta") || text.includes("petrol")) return "fuel";
  if (
    text.includes("oil") ||
    text.includes("service") ||
    text.includes("brake") ||
    text.includes("repair") ||
    text.includes("tyre") ||
    text.includes("tire") ||
    text.includes("wash")
  ) return "maintenance";
  if (text.includes("insurance")) return "insurance";
  return "other";
}

module.exports = { parseAmount, detectType };