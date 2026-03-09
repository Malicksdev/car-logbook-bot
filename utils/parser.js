function parseAmount(text) {

  const match = text.match(/\b(\d+[kK]?)\b/);

  if (!match) return null;

  let value = match[0].toLowerCase();

  if (value.includes("k")) {
    return parseInt(value.replace("k", "")) * 1000;
  }

  return parseInt(value);
}

function detectType(text) {

  text = text.toLowerCase();

  if (text.includes("fuel") || text.includes("mafuta")) {
    return "fuel";
  }

  if (text.includes("oil") || text.includes("service") || text.includes("brake")) {
    return "maintenance";
  }

  if (text.includes("insurance")) {
    return "insurance";
  }

  return "other";
}

module.exports = { parseAmount, detectType };