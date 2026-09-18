import { OAuth2Client } from "google-auth-library";

import { verifyTanyaToken } from "../lib/auth.js";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

/* =========================================================
   AUTH
   (Duplikat dari chat.js supaya endpoint ini mandiri. Idealnya
   dipindah ke satu file bersama, misal ../lib/verify-auth.js,
   lalu di-import di sini dan di chat.js — supaya kalau logic
   auth berubah, cukup diedit di satu tempat saja.)
========================================================= */

async function verifyGoogleToken(idToken) {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID
  });

  const payload = ticket.getPayload();

  if (!payload) {
    throw new Error("Payload Google tidak ditemukan.");
  }

  return {
    userId: payload.sub,
    email: payload.email,
    name: payload.name || payload.email || "User",
    provider: "google"
  };
}

async function verifyMagicToken(token) {
  const data = await verifyTanyaToken(token);

  if (data.type !== "session") {
    throw new Error("Token session tidak valid.");
  }

  if (!data.userId) {
    throw new Error("User ID tidak ditemukan.");
  }

  return {
    userId: String(data.userId),
    email: data.email || null,
    name: data.name || data.email || "User",
    provider: data.auth_provider || "magic"
  };
}

async function verifyAuthToken(token) {
  if (!token) {
    throw new Error("Token login kosong.");
  }

  try {
    return await verifyGoogleToken(token);
  } catch (googleError) {
    console.log("Bukan Google token, mencoba Magic Link...");
  }

  return await verifyMagicToken(token);
}

/* =========================================================
   ANIME STYLE BOOST
========================================================= */

// Kata kunci yang menandakan user ingin gaya anime/manga.
const ANIME_KEYWORDS = [
  "anime",
  "manga",
  "chibi",
  "waifu",
  "shounen",
  "shoujo",
  "kawaii"
];

// Deskripsi tambahan yang disisipkan ke prompt supaya hasil
// gambar lebih konsisten bergaya anime (bukan realistis/3D).
const ANIME_STYLE_BOOST =
  "anime style, japanese anime art, cel shading, clean line art, " +
  "vibrant colors, studio quality, highly detailed, official art";

function isAnimeRequest(prompt) {
  const t = prompt.toLowerCase();

  return ANIME_KEYWORDS.some((keyword) => t.includes(keyword));
}

function buildFinalPrompt(prompt) {
  if (isAnimeRequest(prompt)) {
    return `${prompt}, ${ANIME_STYLE_BOOST}`;
  }

  return prompt;
}

/* =========================================================
   MAIN HANDLER
========================================================= */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  /* =======================================================
     AUTH HEADER
  ======================================================= */

  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Belum login" });
  }

  const idToken = authHeader.substring(7).trim();

  try {
    await verifyAuthToken(idToken);
  } catch (err) {
    console.error("Auth error:", err);

    return res
      .status(401)
      .json({ error: "Sesi login tidak valid atau sudah expired" });
  }

  /* =======================================================
     REQUEST BODY
  ======================================================= */

  const { prompt } = req.body || {};

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "Prompt gambar kosong." });
  }

  const finalPrompt = buildFinalPrompt(prompt.trim());

  console.log("Generate image prompt:", finalPrompt);

  /* =======================================================
     POLLINATIONS.AI — TEXT TO IMAGE GRATIS
     Tidak butuh API key, tidak ada rate limit ketat.
     model=flux memberi hasil lebih detail & konsisten
     dibanding model default "turbo", termasuk untuk gaya anime.
  ======================================================= */

  const seed = Math.floor(Math.random() * 1_000_000);

  const imageUrl =
    "https://image.pollinations.ai/prompt/" +
    encodeURIComponent(finalPrompt) +
    `?width=768&height=768&model=flux&nologo=true&seed=${seed}`;

  try {
    const imageResponse = await fetch(imageUrl);

    if (!imageResponse.ok) {
      const errorText = await imageResponse.text().catch(() => "");

      console.error(
        "Pollinations error:",
        imageResponse.status,
        errorText
      );

      return res.status(502).json({
        error: "Gagal membuat gambar dari provider. Coba lagi."
      });
    }

    const contentType =
      imageResponse.headers.get("content-type") || "image/jpeg";

    const arrayBuffer = await imageResponse.arrayBuffer();

    const base64 = Buffer.from(arrayBuffer).toString("base64");

    const dataUrl = `data:${contentType};base64,${base64}`;

    return res.status(200).json({ image: dataUrl });
  } catch (err) {
    console.error("Generate image error:", err);

    return res.status(502).json({
      error: "Tidak dapat menghubungi provider gambar."
    });
  }
}
