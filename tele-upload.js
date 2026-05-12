// tele-upload.js
export default {
  async fetch(request, env) {
    // GET request = health check
    if (request.method === "GET") {
      return new Response("Bot is running ✅", { status: 200 });
    }

    // POST dari Telegram
    if (request.method === "POST") {
      try {
        const body = await request.json();

        // Abaikan update tanpa message/callback_query
        if (!body.message && !body.callback_query) {
          return new Response("OK");
        }

        return await handleUpdate(body, env);
      } catch (err) {
        // Log error lengkap
        console.error("Error processing update:", err.message, err.stack);
        return new Response("OK"); // Tetap return 200 agar Telegram tidak resend
      }
    }

    return new Response("Method not allowed", { status: 405 });
  },
};

async function handleUpdate(update, env) {
  const msg = update.message;
  const chatId = msg?.chat?.id;
  const text = msg?.text?.trim() || "";
  const fileInfo = msg?.document || msg?.video;
  const apiBase = env.API_BASE || "https://xstreaming.hanadrophtml.workers.dev";

  console.log("Update:", { chatId, text, hasFile: !!fileInfo });

  if (!chatId) {
    console.log("No chatId, skipping");
    return new Response("OK");
  }

  // ---- commands outside state ----
  if (text.startsWith("/start")) {
    return sendMessage(chatId, "👋 Halo! Saya bot upload XStreaming.\n\nPerintah:\n/upload_url <link> [judul] [tag1,tag2]\n/folders - lihat folder\n/folder <id> - set folder default\n/cancel - batalkan proses\n\nAtau kirim langsung file video.", env);
  }

  if (text.startsWith("/folders")) {
    try {
      const res = await fetch(`${apiBase}/api/folders`);
      const data = await res.json();
      const folders = data?.result?.folders || data?.result || [];
      if (!Array.isArray(folders)) {
        return sendMessage(chatId, "❌ Gagal ambil folder: format tak terduga", env);
      }
      const list = folders.map(f => `🆔 ${f.fld_id} – ${f.name || "Tanpa Nama"}`).join("\n") || "Folder kosong";
      return sendMessage(chatId, `📁 Folder yang tersedia:\n${list}`, env);
    } catch (e) {
      console.error("/folders error:", e);
      return sendMessage(chatId, "❌ Gagal ambil folder: " + e.message, env);
    }
  }

  if (text.startsWith("/cancel")) {
    await env.BOT_STATE.delete(`chat:${chatId}`);
    return sendMessage(chatId, "❌ Proses dibatalkan.", env);
  }

  // ---- upload url langsung ----
  if (text.startsWith("/upload_url")) {
    const args = text.split(" ").slice(1);
    if (!args[0]) return sendMessage(chatId, "❌ Gunakan: /upload_url <link> [judul] [tag1,tag2]", env);
    const url = args[0];
    const title = args[1] || "";
    const tags = args.slice(2).join(" ") || "";
    return uploadFromUrl(chatId, url, title, tags, apiBase, env);
  }

  // ---- folder default ----
  if (text.startsWith("/folder")) {
    const fld = text.split(" ")[1] || "0";
    try {
      await env.BOT_STATE.put(`folder:${chatId}`, fld, { expirationTtl: 86400 * 30 });
    } catch (e) {
      console.error("Save folder error:", e);
    }
    return sendMessage(chatId, `✅ Folder default di-set ke *${fld}*`, env);
  }

  // ---- handle state dialog ----
  const stateKey = `chat:${chatId}`;
  let currentState = null;
  try {
    currentState = await env.BOT_STATE.get(stateKey, { type: "json" });
  } catch (e) {
    console.error("Get state error:", e);
  }

  // kalau ada file dan tidak dalam state
  if (fileInfo && !currentState) {
    const fileId = fileInfo.file_id;
    try {
      await env.BOT_STATE.put(stateKey, JSON.stringify({
        state: "AWAIT_TITLE",
        file_id: fileId,
        data: {}
      }), { expirationTtl: 600 });
    } catch (e) {
      console.error("Save state error:", e);
    }
    return sendMessage(chatId, "📁 File video diterima. Sekarang kirim *judul* video.", env);
  }

  if (currentState) {
    const { state, file_id, data } = currentState;

    switch (state) {
      case "AWAIT_TITLE":
        data.title = text || "Untitled";
        await env.BOT_STATE.put(stateKey, JSON.stringify({
          state: "AWAIT_TAGS",
          file_id,
          data
        }), { expirationTtl: 600 });
        return sendMessage(chatId, "🏷️ Sekarang kirim *tag* (pisahkan koma). Atau kirim `-` untuk kosong.", env);

      case "AWAIT_TAGS":
        data.tags = text === "-" ? "" : text;
        await env.BOT_STATE.put(stateKey, JSON.stringify({
          state: "AWAIT_FOLDER",
          file_id,
          data
        }), { expirationTtl: 600 });
        return sendMessage(chatId, "📂 Masukkan *folder ID* (0 = root).", env);

      case "AWAIT_FOLDER":
        data.fld_id = text || "0";
        await env.BOT_STATE.delete(stateKey);
        return uploadFile(chatId, file_id, data.title, data.tags, data.fld_id, apiBase, env);

      default:
        await env.BOT_STATE.delete(stateKey);
        return sendMessage(chatId, "⚠️ State tidak valid, dibatalkan.", env);
    }
  }

  // Tidak ada yang cocok
  return sendMessage(chatId, "Ketik /start untuk bantuan.", env);
}

// ---------- helpers ----------

async function sendMessage(chatId, text, env) {
  const token = env.BOT_TOKEN;
  if (!token) {
    console.error("BOT_TOKEN not set!");
    return new Response("OK");
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: "Markdown",
      }),
    });
    const json = await res.json();
    if (!json.ok) {
      console.error("Telegram API error:", json);
    }
  } catch (e) {
    console.error("sendMessage error:", e.message);
  }

  return new Response("OK");
}

async function getDefaultFolder(chatId, env) {
  try {
    const saved = await env.BOT_STATE.get(`folder:${chatId}`);
    return saved || "0";
  } catch {
    return "0";
  }
}

async function uploadFromUrl(chatId, url, title, tags, apiBase, env) {
  try {
    const res = await fetch(`${apiBase}/api/upload/url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        new_title: title,
        tags,
        fld_id: await getDefaultFolder(chatId, env)
      }),
    });
    const data = await res.json();
    await sendMessage(chatId, "✅ Upload URL berhasil!\n\n```\n" + JSON.stringify(data, null, 2).slice(0, 3500) + "\n```", env);
  } catch (e) {
    await sendMessage(chatId, "❌ Gagal upload: " + e.message, env);
  }
  return new Response("OK");
}

async function uploadFile(chatId, fileId, title, tags, fld_id, apiBase, env) {
  const token = env.BOT_TOKEN;
  if (!token) {
    return sendMessage(chatId, "❌ BOT_TOKEN belum diset", env);
  }

  try {
    // Download dari Telegram
    const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const fileJson = await fileRes.json();
    if (!fileJson.ok) throw new Error("Gagal ambil file: " + fileJson.description);

    const filePath = fileJson.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const fileBlob = await fetch(downloadUrl).then(r => r.blob());

    // Upload ke worker utama
    const form = new FormData();
    form.append("file", fileBlob, filePath.split("/").pop() || "video.mp4");
    form.append("new_title", title);
    form.append("tags", tags);
    form.append("fld_id", fld_id || "0");

    const uploadRes = await fetch(`${apiBase}/api/upload/file`, {
      method: "POST",
      body: form,
    });
    const result = await uploadRes.json();
    await sendMessage(chatId, "✅ Upload file berhasil!\n\n```\n" + JSON.stringify(result, null, 2).slice(0, 3500) + "\n```", env);
  } catch (e) {
    console.error("uploadFile error:", e);
    await sendMessage(chatId, "❌ Gagal upload: " + e.message, env);
  }
  return new Response("OK");
}
