
import { OAuth2Client } from "google-auth-library";

import { verifyTanyaToken } from "../lib/auth.js";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Minta durasi function lebih panjang ke Vercel (generate gambar
// bisa lebih lama dari chat text biasa). PENTING: di plan Hobby
// (gratis), Vercel MENOLAK deploy kalau nilai ini lebih besar dari
// 10 — bukan cuma membatasi otomatis. Kalau kamu sudah upgrade ke
// plan Pro, angka ini boleh dinaikkan lagi (misal ke 30 atau 60).
export const config = {
  maxDuration: 10
};

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
     (termasuk untuk gaya anime), tapi kadang lebih lambat.
     Kalau flux timeout, fallback otomatis ke model=turbo
     yang jauh lebih cepat.
  ======================================================= */

  // Vercel Hobby plan MEMBATASI TOTAL EKSEKUSI FUNCTION ke 10 detik
  // (lihat config.maxDuration di atas). Auth check + overhead lain
  // butuh sedikit waktu, jadi flux+turbo digabung harus di bawah
  // itu. Kalau flux belum selesai dalam 5 detik, langsung coba
  // turbo dengan sisa waktu ~3.5 detik.
  const FLUX_TIMEOUT_MS = 5000;
  const TURBO_TIMEOUT_MS = 3500;

  async function fetchPollinationsImage(model, timeoutMs) {
    const seed = Math.floor(Math.random() * 1_000_000);

    const imageUrl =
      "https://image.pollinations.ai/prompt/" +
      encodeURIComponent(finalPrompt) +
      `?width=768&height=768&model=${model}&nologo=true&seed=${seed}`;

    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs
    );

    try {
      const imageResponse = await fetch(imageUrl, {
        signal: controller.signal
      });

      clearTimeout(timer);

      if (!imageResponse.ok) {
        const errorText = await imageResponse.text().catch(() => "");

        console.error(
          `Pollinations (${model}) error:`,
          imageResponse.status,
          errorText
        );

        throw new Error(
          `Provider gambar (${model}) membalas status ${imageResponse.status}.`
        );
      }

      const contentType =
        imageResponse.headers.get("content-type") || "image/jpeg";

      const arrayBuffer = await imageResponse.arrayBuffer();

      const base64 = Buffer.from(arrayBuffer).toString("base64");

      return `data:${contentType};base64,${base64}`;
    } catch (err) {
      clearTimeout(timer);

      if (err.name === "AbortError") {
        console.error(`Pollinations (${model}) timeout setelah ${timeoutMs}ms`);

        throw new Error(`Provider gambar (${model}) timeout.`);
      }

      throw err;
    }
  }

  try {
    let dataUrl;

    try {
      // Coba model berkualitas tinggi dulu.
      dataUrl = await fetchPollinationsImage("flux", FLUX_TIMEOUT_MS);
    } catch (fluxErr) {
      console.log(
        "Flux gagal/timeout, fallback ke turbo:",
        fluxErr.message
      );

      // Fallback ke model yang jauh lebih cepat.
      dataUrl = await fetchPollinationsImage("turbo", TURBO_TIMEOUT_MS);
    }

    return res.status(200).json({ image: dataUrl });
  } catch (err) {
    console.error("Generate image error (semua model gagal):", err);

    return res.status(502).json({
      error:
        "Gagal membuat gambar: " +
        (err.message || "provider tidak merespons. Coba lagi.")
    });
  }
}
