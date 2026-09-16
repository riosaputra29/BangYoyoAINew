
import { OAuth2Client } from "google-auth-library";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const GROQ_API_KEYS = [
  process.env.GROQ_KEY_1,
  process.env.GROQ_KEY_2,
  process.env.GROQ_KEY_3,
  process.env.GROQ_KEY_4
].filter(Boolean);

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// =========================================================
// GROQ REQUEST DENGAN ROTASI API KEY
// =========================================================

async function groqRequest(url, options = {}) {
  if (!GROQ_API_KEYS.length) {
    throw new Error("Tidak ada GROQ API key.");
  }

  let lastError = null;

  for (let i = 0; i < GROQ_API_KEYS.length; i++) {
    const apiKey = GROQ_API_KEYS[i];

    try {
      const response = await fetch(url, {
        ...options,

        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${apiKey}`
        }
      });

      // Berhasil
      if (response.ok) {
        return response;
      }

      const errorText = await response.text();

      console.error(
        `Groq key ${i + 1} error:`,
        response.status,
        errorText
      );

      lastError = new Error(
        `Groq key ${i + 1}: HTTP ${response.status}`
      );

      // Rate limit / quota
      // lanjut ke API key berikutnya
      if (
        response.status === 401 ||
        response.status === 429 ||
        response.status === 413 ||
        response.status >= 500
      ) {
        continue;
      }

      // Error lain
      continue;

    } catch (error) {
      console.error(
        `Groq key ${i + 1} connection error:`,
        error
      );

      lastError = error;
    }
  }

  throw lastError || new Error("Semua Groq API key gagal.");
}


// =========================================================
// API VOICE
// =========================================================

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {

    // =====================================================
    // GOOGLE AUTH
    // =====================================================

    const auth =
      req.headers.authorization || "";

    if (!auth.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Unauthorized"
      });
    }

    const idToken =
      auth.replace("Bearer ", "").trim();

    if (!idToken) {
      return res.status(401).json({
        error: "Google token tidak ditemukan"
      });
    }

    const ticket =
      await googleClient.verifyIdToken({
        idToken,
        audience: GOOGLE_CLIENT_ID
      });

    const payload =
      ticket.getPayload();

    if (!payload?.sub) {
      return res.status(401).json({
        error: "Google token tidak valid"
      });
    }

    // =====================================================
    // CEK GROQ KEY
    // =====================================================

    if (!GROQ_API_KEYS.length) {
      return res.status(500).json({
        error:
          "GROQ_KEY_1 sampai GROQ_KEY_4 belum tersedia."
      });
    }

    // =====================================================
    // CEK AUDIO
    // =====================================================

    const contentType =
      req.headers["content-type"] || "";

    if (
      !contentType.includes("audio") &&
      !contentType.includes("webm") &&
      !contentType.includes("ogg") &&
      !contentType.includes("wav") &&
      !contentType.includes("mpeg") &&
      !contentType.includes("mp4")
    ) {
      return res.status(400).json({
        error: "Request harus berupa file audio."
      });
    }

    // =====================================================
    // BACA AUDIO
    // =====================================================

    const chunks = [];

    for await (const chunk of req) {
      chunks.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk)
      );
    }

    const audioBuffer =
      Buffer.concat(chunks);

    if (!audioBuffer.length) {
      return res.status(400).json({
        error: "Audio kosong."
      });
    }

    // Maksimum 10 MB
    const MAX_AUDIO_SIZE =
      10 * 1024 * 1024;

    if (audioBuffer.length > MAX_AUDIO_SIZE) {
      return res.status(413).json({
        error:
          "Ukuran audio terlalu besar. Maksimal 10 MB."
      });
    }

    console.log(
      `Voice audio diterima: ${
        Math.round(audioBuffer.length / 1024)
      } KB`
    );

    // =====================================================
    // SPEECH TO TEXT
    // =====================================================

    const formData = new FormData();

    const audioBlob = new Blob(
      [audioBuffer],
      {
        type:
          contentType.split(";")[0]
          || "audio/webm"
      }
    );

    formData.append(
      "file",
      audioBlob,
      "voice.webm"
    );

    formData.append(
      "model",
      "whisper-large-v3-turbo"
    );

    formData.append(
      "language",
      "id"
    );

    formData.append(
      "response_format",
      "json"
    );

    console.log(
      "Voice → Speech-to-Text..."
    );

    const transcriptionResponse =
      await groqRequest(
        "https://api.groq.com/openai/v1/audio/transcriptions",
        {
          method: "POST",
          body: formData
        }
      );

    const transcription =
      await transcriptionResponse.json();

    const userText =
      (transcription.text || "").trim();

    if (!userText) {
      return res.status(400).json({
        error:
          "Suara tidak berhasil dikenali."
      });
    }

    console.log(
      "Transcription:",
      userText
    );

    // =====================================================
    // AI RESPONSE
    // =====================================================

    console.log(
      "Voice → AI..."
    );

    const aiResponse =
      await groqRequest(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({

            model:
              process.env.GROQ_MODEL
              || "llama-3.3-70b-versatile",

            messages: [
              {
                role: "system",

                content:
                  "Kamu adalah Tanya, asisten AI berbahasa Indonesia. Jawablah secara natural, jelas, singkat, dan nyaman ketika dibacakan menggunakan suara."
              },

              {
                role: "user",

                content: userText
              }
            ],

            temperature: 0.5,

            max_tokens: 700
          })
        }
      );

    const aiData =
      await aiResponse.json();

    const answer =
      aiData
        ?.choices?.[0]
        ?.message
        ?.content
        ?.trim();

    if (!answer) {
      return res.status(502).json({
        error:
          "AI tidak memberikan jawaban."
      });
    }

    console.log(
      "AI answer berhasil."
    );

    // =====================================================
    // RESPONSE
    // =====================================================

    return res.status(200).json({

      success: true,

      text: userText,

      answer

    });

  } catch (error) {

    console.error(
      "VOICE API ERROR:",
      error
    );

    return res.status(500).json({
      error:
        error?.message
        || "Terjadi kesalahan pada Voice API."
    });
  }
}
