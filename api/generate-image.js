export const runtime = "nodejs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "OPENAI_API_KEY belum diset di Vercel."
      });
    }

    const prompt = String(req.body?.prompt || "").trim();

    if (!prompt) {
      return res.status(400).json({
        error: "Prompt gambar kosong."
      });
    }

    if (prompt.length > 4000) {
      return res.status(400).json({
        error: "Prompt terlalu panjang."
      });
    }

    console.log("IMAGE PROMPT:", prompt);

    const response = await fetch(
      "https://api.openai.com/v1/images/generations",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },

        body: JSON.stringify({
          model: "gpt-image-1",
          prompt,
          size: "1024x1024"
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("OPENAI IMAGE ERROR:", data);

      return res.status(502).json({
        error:
          data?.error?.message ||
          "Gagal membuat gambar."
      });
    }

    const image = data?.data?.[0];

    if (!image) {
      return res.status(502).json({
        error: "OpenAI tidak mengembalikan gambar."
      });
    }

    return res.status(200).json({
      ok: true,
      image: image.b64_json
        ? `data:image/png;base64,${image.b64_json}`
        : image.url || null
    });

  } catch (error) {

    console.error(
      "GENERATE IMAGE ERROR:",
      error
    );

    return res.status(500).json({
      error:
        error?.message ||
        "Terjadi kesalahan saat membuat gambar."
    });
  }
}
