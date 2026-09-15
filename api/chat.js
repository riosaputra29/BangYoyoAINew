import { OAuth2Client } from "google-auth-library";

import {
  getMemories,
  formatMemoriesForPrompt,
  saveChatMessage,
  createConversation,
  makeTitleFromMessage
} from "../lib/memory.js";

import { extractAndSaveFacts } from "../lib/extract.js";

import {
  verifyTanyaToken
} from "../lib/auth.js";


const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;


const GROQ_API_KEYS = [
  process.env.GROQ_KEY_1,
  process.env.GROQ_KEY_2,
  process.env.GROQ_KEY_3,
  process.env.GROQ_KEY_4
].filter(Boolean);


let currentKeyIndex = 0;


const MODEL =
  process.env.GROQ_MODEL ||
  "openai/gpt-oss-120b";


const VISION_MODEL =
  process.env.GROQ_VISION_MODEL ||
  "qwen/qwen3.8-27b";


const MAX_IMAGES_PER_REQUEST = 5;

const MAX_GROQ_RETRIES =
  Math.max(GROQ_API_KEYS.length, 1);


// TOKEN SAVING

const MAX_HISTORY_MESSAGES_FOR_MODEL = 4;

const MAX_DOCS_KEPT_FULL = 1;

const MAX_IMAGE_MSGS_KEPT_FULL = 1;

const MAX_MEMORY_CHARS_IN_PROMPT = 1200;


const googleClient =
  new OAuth2Client(GOOGLE_CLIENT_ID);



/* =========================================================
   GOOGLE AUTH
========================================================= */

async function verifyGoogleToken(idToken) {

  const ticket =
    await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID
    });

  const payload =
    ticket.getPayload();

  if (!payload) {
    throw new Error(
      "Payload Google tidak ditemukan."
    );
  }

  return {
    userId: payload.sub,
    email: payload.email,
    name:
      payload.name ||
      payload.email ||
      "User",
    provider: "google"
  };
}



/* =========================================================
   MAGIC LINK TOKEN
========================================================= */

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



/* =========================================================
   AUTH TOKEN
========================================================= */

async function verifyAuthToken(token) {

  if (!token) {
    throw new Error("Token login kosong.");
  }

  // Coba Google
  try {
    return await verifyGoogleToken(token);
  } catch (googleError) {
    console.log("Bukan Google token, mencoba Magic Link...");
  }

  // Coba Magic Link session
  return await verifyMagicToken(token);
}



/* =========================================================
   IMAGE
========================================================= */

function messageHasImage(message) {

  if (
    !message ||
    !Array.isArray(message.content)
  ) {
    return false;
  }


  return message.content.some(
    (part) =>
      part &&
      part.type === "image_url"
  );
}



/* =========================================================
   CAP IMAGE
========================================================= */

function capImagesPerRequest(
  messages,
  maxImages = MAX_IMAGES_PER_REQUEST
) {

  let imageCount = 0;


  const reversed =
    [...messages].reverse();


  const capped =
    reversed.map((message) => {

      if (
        !Array.isArray(
          message.content
        )
      ) {
        return message;
      }


      const newContent =
        message.content.filter(
          (part) => {

            if (
              part &&
              part.type === "image_url"
            ) {

              imageCount++;

              return (
                imageCount <=
                maxImages
              );
            }

            return true;

          }
        );


      return {
        ...message,
        content: newContent
      };

    });


  return capped.reverse();
}



/* =========================================================
   SLEEP
========================================================= */

function sleep(ms) {

  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );

}



/* =========================================================
   GROQ
========================================================= */

function callGroq(
  messages,
  modelId,
  maxTokens,
  attempt = 0
) {

  if (
    GROQ_API_KEYS.length === 0
  ) {

    return Promise.reject(
      new Error(
        "GROQ API key belum dikonfigurasi."
      )
    );

  }


  const apiKey =
    GROQ_API_KEYS[
      currentKeyIndex
    ];


  console.log(
    `Chat pakai Groq key ${
      currentKeyIndex + 1
    }/${GROQ_API_KEYS.length}`
  );


  return fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {

      method: "POST",

      headers: {

        "Content-Type":
          "application/json",

        "Authorization":
          "Bearer " + apiKey

      },

      body: JSON.stringify({

        model: modelId,

        messages,

        stream: true,

        max_tokens:
          maxTokens,

        temperature: 0.2

      })

    }

  ).then(
    async (response) => {

      if (
        response.status === 429
      ) {

        console.log(
          `Groq key ${
            currentKeyIndex + 1
          } kena rate limit`
        );


        if (
          attempt + 1 >=
          MAX_GROQ_RETRIES
        ) {

          return response;

        }


        currentKeyIndex =
          (
            currentKeyIndex + 1
          ) %
          GROQ_API_KEYS.length;


        await sleep(
          300 *
          (attempt + 1)
        );


        return callGroq(
          messages,
          modelId,
          maxTokens,
          attempt + 1
        );

      }


      return response;

    }
  );

}



/* =========================================================
   CLEAN MESSAGE
========================================================= */

function cleanMessages(messages) {

  return messages

    .filter((message) => {

      if (!message) {
        return false;
      }


      if (
        ![
          "user",
          "assistant"
        ].includes(
          message.role
        )
      ) {
        return false;
      }


      if (
        typeof message.content ===
        "string"
      ) {

        return (
          message.content.trim() !==
          ""
        );

      }


      if (
        Array.isArray(
          message.content
        )
      ) {

        return (
          message.content.length >
          0
        );

      }


      return false;

    })

    .map((message) => {

      if (
        typeof message.content ===
        "string"
      ) {

        return {

          role:
            message.role,

          content:
            message.content.trim()

        };

      }


      return {

        role:
          message.role,

        content:
          message.content

      };

    });

}



/* =========================================================
   DOCUMENT
========================================================= */

function containsDocument(
  content
) {

  if (
    typeof content !==
    "string"
  ) {
    return false;
  }


  return (

    content.includes(
      "[Isi file"
    ) ||

    content.includes(
      '[File "'
    ) ||

    content.includes(
      "--- Sheet:"
    ) ||

    content.includes(
      "--- Halaman"
    )

  );

}



/* =========================================================
   DOCUMENT NAME
========================================================= */

function getDocumentName(
  content
) {

  if (
    typeof content !==
    "string"
  ) {
    return "dokumen";
  }


  const match =

    content.match(
      /\[Isi file "([^"]+)"\]/i
    ) ||

    content.match(
      /\[File "([^"]+)"\]/i
    );


  return (
    match?.[1] ||
    "dokumen"
  );

}



/* =========================================================
   DOCUMENT INSTRUCTION
========================================================= */

function buildDocumentInstruction(
  content
) {

  if (
    !containsDocument(content)
  ) {
    return null;
  }


  const fileName =
    getDocumentName(content);


  return `

DOKUMEN USER

Nama file: ${fileName}

Gunakan dokumen sebagai sumber utama.
Jangan mengarang data.

`;

}



/* =========================================================
   TRIM MESSAGE
========================================================= */

function trimMessagesForModel(
  messages
) {

  const imageIndices = [];


  messages.forEach(
    (message, index) => {

      if (
        messageHasImage(message)
      ) {

        imageIndices.push(index);

      }

    }
  );


  const imageIndicesToStrip =
    new Set(

      imageIndices.slice(
        0,
        Math.max(
          0,
          imageIndices.length -
            MAX_IMAGE_MSGS_KEPT_FULL
        )
      )

    );


  const docIndices = [];


  messages.forEach(
    (message, index) => {

      if (

        typeof message.content ===
          "string" &&

        containsDocument(
          message.content
        )

      ) {

        docIndices.push(index);

      }

    }
  );


  const docIndicesToStrip =
    new Set(

      docIndices.slice(
        0,
        Math.max(
          0,
          docIndices.length -
            MAX_DOCS_KEPT_FULL
        )
      )

    );


  let trimmed =
    messages.map(
      (message, index) => {

        if (
          imageIndicesToStrip.has(
            index
          )
        ) {

          const textPart =
            Array.isArray(
              message.content
            )
              ? message.content.find(
                  (part) =>
                    part &&
                    part.type ===
                      "text"
                )
              : null;


          const label =
            textPart?.text?.trim() ||
            "(Gambar terlampir)";


          return {

            role:
              message.role,

            content:
              label +
              "\n[Gambar lama tidak dikirim ulang]"

          };

        }


        if (
          docIndicesToStrip.has(
            index
          )
        ) {

          const fileName =
            getDocumentName(
              message.content
            );


          return {

            role:
              message.role,

            content:
              `[Dokumen "${fileName}" sudah dianalisis. Isi tidak dikirim ulang]`

          };

        }


        return message;

      }
    );


  if (
    trimmed.length >
    MAX_HISTORY_MESSAGES_FOR_MODEL
  ) {

    trimmed =
      trimmed.slice(
        trimmed.length -
          MAX_HISTORY_MESSAGES_FOR_MODEL
      );

  }


  return trimmed;

}



/* =========================================================
   BUILD GROQ MESSAGE
========================================================= */

function buildGroqMessages(
  cleanMessages,
  memoryText,
  useVision
) {

  const result = [];


  result.push({

    role: "system",

    content: `Kamu adalah Tanya, asisten AI yang ramah dan teliti.

ATURAN UTAMA:
Utamakan akurasi.
Jangan mengarang.

BAHASA:
Gunakan Bahasa Indonesia default.
Ikuti bahasa user.

ATURAN MEMORY YANG WAJIB:

Jika di bawah ada "nama: Budi",
maka WAJIB panggil user "Budi"
di setiap jawaban.

Jangan pernah tanya
"siapa nama kamu" lagi kalau
sudah ada di memory.

MEMORY USER:

${memoryText}`

  });


  for (
    const message of cleanMessages
  ) {

    if (
      typeof message.content ===
      "string"
    ) {

      const documentInstruction =
        message.role === "user"
          ? buildDocumentInstruction(
              message.content
            )
          : null;


      if (
        documentInstruction
      ) {

        result.push({

          role: "system",

          content:
            documentInstruction

        });

      }


      result.push({

        role:
          message.role,

        content:
          message.content

      });

    } else {

      result.push({

        role:
          message.role,

        content:
          message.content

      });

    }

  }


  return result;

}



/* =========================================================
   MAIN HANDLER
========================================================= */

export default async function handler(
  req,
  res
) {

  /*
   * Hanya POST
   */

  if (
    req.method !== "POST"
  ) {

    return res
      .status(405)
      .json({

        error:
          "Method not allowed"

      });

  }



  /* =======================================================
     AUTH HEADER
  ======================================================= */

  const authHeader =
    req.headers.authorization ||
    "";


  if (
    !authHeader.startsWith(
      "Bearer "
    )
  ) {

    return res
      .status(401)
      .json({

        error:
          "Belum login"

      });

  }


  const idToken =
    authHeader
      .substring(7)
      .trim();



  /* =======================================================
     VERIFY GOOGLE / MAGIC LINK
  ======================================================= */

  let user;


  try {

    user =
      await verifyAuthToken(
        idToken
      );

  } catch (err) {

    console.error(
      "Auth error:",
      err
    );


    return res
      .status(401)
      .json({

        error:
          "Sesi login tidak valid atau sudah expired"

      });

  }


  const userId =
    user.userId;



  console.log(
    `User login: ${user.email || userId} | provider=${user.provider}`
  );



  /* =======================================================
     REQUEST BODY
  ======================================================= */

  const {
    messages,
    conversationId
  } = req.body || {};


  if (
    !Array.isArray(messages) ||
    messages.length === 0
  ) {

    return res
      .status(400)
      .json({

        error:
          "Pesan kosong"

      });

  }


  const clean =
    cleanMessages(
      messages
    );


  const lastUserMessage =
    [
      ...clean
    ]
      .reverse()
      .find(
        (message) =>
          message.role === "user"
      );



  /* =======================================================
     CONVERSATION
  ======================================================= */

  let convId =
    conversationId
      ? Number(conversationId)
      : null;


  if (!convId) {

    const title =
      lastUserMessage

        ? makeTitleFromMessage(

            typeof lastUserMessage.content ===
              "string"

              ? lastUserMessage.content

              : "Analisis gambar"

          )

        : "Percakapan baru";


    const conv =
      await createConversation(
        userId,
        title
      );


    convId =
      conv.id;

  }



  /* =======================================================
     MEMORY
  ======================================================= */

  let memoryText =
    "Belum ada memory tersimpan.";


  try {

    const memories =
      await getMemories(
        userId
      );


    memoryText =
      formatMemoriesForPrompt(
        memories
      );


    console.log(
      `Memory ditemukan: ${memories.length} item`
    );

  } catch (err) {

    console.error(
      "Gagal ambil memories:",
      err
    );

  }



  if (
    memoryText.length >
    MAX_MEMORY_CHARS_IN_PROMPT
  ) {

    memoryText =
      memoryText.slice(
        0,
        MAX_MEMORY_CHARS_IN_PROMPT
      );


    const lastNewLine =
      memoryText.lastIndexOf(
        "\n"
      );


    if (
      lastNewLine > 0
    ) {

      memoryText =
        memoryText.substring(
          0,
          lastNewLine
        );

    }


    memoryText +=
      "\n[Memory lama dipotong]";

  }


  console.log(
    "Memory dikirim ke AI:",
    memoryText
  );



  /* =======================================================
     VISION
  ======================================================= */

  const useVision =
    !!lastUserMessage &&
    messageHasImage(
      lastUserMessage
    );


  const trimmedForModel =
    trimMessagesForModel(
      clean
    );


  let groqMessages =
    buildGroqMessages(
      trimmedForModel,
      memoryText,
      useVision
    );


  if (useVision) {

    groqMessages =
      capImagesPerRequest(
        groqMessages
      );

  }


  const modelToUse =
    useVision
      ? VISION_MODEL
      : MODEL;


  const maxOutputTokens =
    useVision
      ? 2000
      : 1200;



  /* =======================================================
     SAVE USER MESSAGE
  ======================================================= */

  if (
    lastUserMessage
  ) {

    const savedContent =
      typeof lastUserMessage.content ===
        "string"

        ? lastUserMessage.content

        : "[Lampiran gambar]";


    saveChatMessage(
      userId,
      convId,
      "user",
      savedContent
    ).catch(
      console.error
    );

  }



  /* =======================================================
     GROQ
  ======================================================= */

  let upstream;


  try {

    upstream =
      await callGroq(
        groqMessages,
        modelToUse,
        maxOutputTokens
      );

  } catch (err) {

    console.error(
      "Groq error:",
      err
    );


    return res
      .status(502)
      .json({

        error:
          "Tidak dapat menghubungi AI"

      });

  }



  if (
    !upstream.ok ||
    !upstream.body
  ) {

    const errorText =
      await upstream
        .text()
        .catch(
          () => ""
        );


    return res
      .status(
        upstream.status
      )
      .json({

        error:
          errorText ||
          "Gagal respons AI"

      });

  }



  /* =======================================================
     SSE
  ======================================================= */

  res.status(200);


  res.setHeader(
    "Content-Type",
    "text/event-stream; charset=utf-8"
  );


  res.setHeader(
    "Cache-Control",
    "no-cache"
  );


  res.setHeader(
    "Connection",
    "keep-alive"
  );


  res.setHeader(
    "X-Conversation-Id",
    String(convId)
  );


  if (
    res.flushHeaders
  ) {

    res.flushHeaders();

  }



  const reader =
    upstream.body.getReader();


  const decoder =
    new TextDecoder();


  let sseBuffer = "";

  let fullReply = "";



  /* =======================================================
     PROCESS SSE
  ======================================================= */

  function processSSEChunk(
    chunkText
  ) {

    sseBuffer +=
      chunkText;


    const lines =
      sseBuffer.split(
        "\n"
      );


    sseBuffer =
      lines.pop() ?? "";


    for (
      const line of lines
    ) {

      const trimmed =
        line.trim();


      if (
        !trimmed.startsWith(
          "data:"
        )
      ) {
        continue;
      }


      const payload =
        trimmed
          .slice(5)
          .trim();


      if (
        payload ===
        "[DONE]"
      ) {
        continue;
      }


      try {

        const json =
          JSON.parse(
            payload
          );


        const delta =
          json
            ?.choices?.[0]
            ?.delta?.content;


        if (
          typeof delta ===
          "string"
        ) {

          fullReply +=
            delta;

        }

      } catch {

        // Abaikan SSE
      }

    }

  }



  /* =======================================================
     STREAM RESPONSE
  ======================================================= */

  try {

    while (true) {

      const {
        done,
        value
      } =
        await reader.read();


      if (done) {
        break;
      }


      res.write(
        value
      );


      processSSEChunk(
        decoder.decode(
          value,
          {
            stream: true
          }
        )
      );

    }

  } catch (err) {

    console.error(
      "Streaming error:",
      err
    );

  }



  /* =======================================================
     SAVE ASSISTANT
  ======================================================= */

  if (
    fullReply.trim()
  ) {

    await saveChatMessage(
      userId,
      convId,
      "assistant",
      fullReply.trim()
    );

  }



  /* =======================================================
     EXTRACT MEMORY
  ======================================================= */

  if (
    lastUserMessage &&
    typeof lastUserMessage.content ===
      "string"
  ) {

    console.log(
      "Mulai ekstrak memory..."
    );


    await extractAndSaveFacts(
      userId,
      lastUserMessage.content
    );

  }



  /* =======================================================
     END
  ======================================================= */

  res.end();

}
