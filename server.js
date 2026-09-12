import express from "express";
import { OAuth2Client } from "google-auth-library";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

const app = express();

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const PORT = process.env.PORT || 3000;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

if (!GOOGLE_CLIENT_ID) {
    console.error("❌ GOOGLE_CLIENT_ID belum diisi di .env");
}

if (!GEMINI_API_KEY) {
    console.error("❌ GEMINI_API_KEY belum diisi di .env");
}

if (!MODEL) {
    console.error("❌ GEMINI_MODEL belum diisi di .env");
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);


// =====================================================
// VERIFY GOOGLE ID TOKEN
// =====================================================

async function verifyGoogleToken(idToken) {
    if (!idToken) {
        throw new Error("Google ID Token kosong.");
    }

    const ticket = await googleClient.verifyIdToken({
        idToken: idToken,
        audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    if (!payload) {
        throw new Error("Payload Google tidak ditemukan.");
    }

    return payload;
}


// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/api/health", (req, res) => {

    res.json({
        ok: true,
        google_configured: !!GOOGLE_CLIENT_ID,
        gemini_configured: !!GEMINI_API_KEY,
        model: MODEL || null
    });

});


// =====================================================
// ROOT ROUTE (biar "Cannot GET /" tidak muncul)
// =====================================================

app.get("/", (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});


// =====================================================
// CHAT API
// =====================================================

app.post("/api/chat", async (req, res) => {

    // -------------------------------------------------
    // 1. CEK GOOGLE LOGIN
    // -------------------------------------------------

    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {

        return res.status(401).json({
            error: "Belum login dengan Google."
        });

    }

    const idToken = authHeader.substring(7).trim();

    if (!idToken) {

        return res.status(401).json({
            error: "Google ID Token tidak ditemukan."
        });

    }


    // -------------------------------------------------
    // 2. VERIFY GOOGLE TOKEN
    // -------------------------------------------------

    let googleUser;

    try {

        googleUser = await verifyGoogleToken(idToken);

        console.log(
            `Google login: ${googleUser.email || "unknown"}`
        );

    } catch (error) {

        console.error(
            "Google verification error:",
            error.message
        );

        return res.status(401).json({
            error: "Sesi Google tidak valid atau sudah kedaluwarsa."
        });

    }


    // -------------------------------------------------
    // 3. VALIDASI MESSAGES
    // -------------------------------------------------

    const { messages } = req.body;

    if (!Array.isArray(messages)) {

        return res.status(400).json({
            error: "Format messages harus berupa array."
        });

    }

    if (messages.length === 0) {

        return res.status(400).json({
            error: "Pesan kosong."
        });

    }


    // -------------------------------------------------
    // 4. BERSIHKAN MESSAGE
    // -------------------------------------------------

    const cleanMessages = messages
        .filter((message) => {

            return (
                message &&
                ["user", "assistant"].includes(message.role) &&
                typeof message.content === "string" &&
                message.content.trim() !== ""
            );

        })
        .map((message) => {

            return {
                role: message.role,
                content: message.content.trim()
            };

        });


    if (cleanMessages.length === 0) {

        return res.status(400).json({
            error: "Tidak ada pesan yang valid."
        });

    }


    // -------------------------------------------------
    // 5. KONVERSI KE FORMAT GEMINI
    // -------------------------------------------------
    // Gemini pakai "contents" bukan "messages", role
    // "assistant" harus jadi "model", dan tiap pesan
    // berisi array "parts" bukan string "content".

    const geminiContents = cleanMessages.map((message) => {

        return {
            role: message.role === "assistant" ? "model" : "user",
            parts: [{ text: message.content }]
        };

    });


    // -------------------------------------------------
    // 6. PANGGIL GEMINI
    // -------------------------------------------------

    let upstream;

    try {

        const url =
            `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent` +
            `?alt=sse&key=${GEMINI_API_KEY}`;

        upstream = await fetch(
            url,
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({

                    contents: geminiContents,

                    systemInstruction: {
                        role: "system",
                        parts: [{
                            text:
                                "Kamu adalah Tanya, asisten AI yang ramah, profesional, membantu, dan menjawab dalam bahasa Indonesia kecuali pengguna meminta bahasa lain."
                        }]
                    },

                    generationConfig: {
                        maxOutputTokens: 2000
                    }

                })
            }
        );

    } catch (error) {

        console.error(
            "Gemini connection error:",
            error
        );

        return res.status(502).json({
            error: "Tidak dapat menghubungi layanan AI."
        });

    }


    // -------------------------------------------------
    // 7. CEK RESPONSE GEMINI
    // -------------------------------------------------

    if (!upstream.ok || !upstream.body) {

        const errorText = await upstream.text();

        console.error(
            "Gemini API Error:",
            upstream.status,
            errorText
        );

        let message =
            "Gagal mendapatkan respons dari AI.";

        try {

            const parsed =
                JSON.parse(errorText);

            message =
                parsed?.error?.message ||
                message;

        } catch {

            // response bukan JSON

        }

        return res.status(upstream.status).json({
            error: message
        });

    }


    // -------------------------------------------------
    // 8. SSE RESPONSE KE BROWSER
    // -------------------------------------------------

    res.status(200);

    res.setHeader(
        "Content-Type",
        "text/event-stream; charset=utf-8"
    );

    res.setHeader(
        "Cache-Control",
        "no-cache, no-transform"
    );

    res.setHeader(
        "Connection",
        "keep-alive"
    );

    res.setHeader(
        "X-Accel-Buffering",
        "no"
    );

    if (res.flushHeaders) {
        res.flushHeaders();
    }


    // -------------------------------------------------
    // 9. STREAM GEMINI → BROWSER
    // -------------------------------------------------
    // Catatan: chunk mentah dari Gemini diteruskan apa
    // adanya (format SSE bawaan Gemini, bukan format
    // Anthropic). Kalau frontend kamu mem-parsing event
    // Anthropic (event: content_block_delta, dst), bagian
    // parsing di sisi client PERLU disesuaikan juga,
    // karena struktur JSON Gemini berbeda:
    // { candidates: [{ content: { parts: [{ text }] } }] }

    const reader =
        upstream.body.getReader();

    req.on("close", () => {

        reader
            .cancel()
            .catch(() => {});

    });


    try {

        while (true) {

            const {
                done,
                value
            } = await reader.read();

            if (done) {
                break;
            }

            res.write(value);

        }

    } catch (error) {

        console.error(
            "Streaming error:",
            error
        );

    } finally {

        res.end();

    }

});


// =====================================================
// START SERVER (hanya jalan kalau dijalankan langsung / lokal)
// Di Vercel, server tidak "listen" — Vercel yang memanggil
// export default app sebagai serverless function.
// =====================================================

if (process.env.VERCEL !== "1") {

    app.listen(PORT, () => {

        console.log("");
        console.log("======================================");
        console.log("       TANYA AI SERVER (Gemini)");
        console.log("======================================");
        console.log(`Server : http://localhost:${PORT}`);
        console.log(
            `Google Login : ${GOOGLE_CLIENT_ID ? "OK" : "BELUM DIISI"}`
        );
        console.log(
            `Gemini API : ${GEMINI_API_KEY ? "OK" : "BELUM DIISI"}`
        );
        console.log(
            `Model : ${MODEL || "BELUM DIISI"}`
        );
        console.log("======================================");
        console.log("");

    });

}

export default app;
