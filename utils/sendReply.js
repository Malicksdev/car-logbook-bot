const axios = require("axios");

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// ─── SEND TEXT MESSAGE ────────────────────────────────────────────────────────

async function sendReply(to, message) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message }
    },
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// ─── SEND MEDIA MESSAGE ───────────────────────────────────────────────────────
// type: "image" | "video" | "document"
// url: publicly accessible URL to the media file
// caption: optional text shown below the media

async function sendMediaReply(to, type, url, caption = "") {
  const mediaPayload = { link: url };
  if (caption) mediaPayload.caption = caption;

  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type,
      [type]: mediaPayload
    },
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

module.exports = { sendReply, sendMediaReply };