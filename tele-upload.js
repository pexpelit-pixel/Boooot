// tele-upload.js
// Environment vars: BOT_TOKEN, API_BASE (opsional, default ke worker utama), BOT_STATE (KV)

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");

    const body = await request.json();
    if (!body.message && !body.callback_query) return new Response("OK");

    return handleUpdate(body, env);
  },
};

async function handleUpdate(update, env) {
  const msg = update.message;
  const chatId = msg?.chat?.id;
  const text = msg?.text?.trim() || "";
  const fileInfo = msg.document || msg.video;
  const apiBase = env.API_BASE || "https://xstreaming.hanadrophtml.workers.dev";

  if (!chatId) return new Response("OK");

  // ---- commands outside state ----
  if (text.startsWith("/start")) {
    return sendMessage(chatId, `👋 Halo! Saya bot upload XStreaming.\n\nPerintah:\n/upload_url <link> [judul] [tag1,tag2]\n/folders - lihat folder\n/folder <id> - set folder default\n/cancel - batalkan proses\n\nAtau kirim langsung file video.`, env);
  }

  if (text.startsWith("/folders")) {
    const res = await fetch(`${apiBase}/api/folders`);
    const data = await res.json();
    const folders = data?.result?.folders || data?.result || [];
    const list = folders.map(f => `🆔 ${f.fld_id} – ${f.name}`).join("\n") || "Folder kosong";
    return sendMessage(chatId, `📁 Folder yang tersedia:\n${list}`, env);
  }

  if (text.startsWith("/cancel")) {
    await env.BOT_STATE.delete(`chat:${chatId}`);
    return sendMessage(chatId, "❌ Proses dibatalkan.", env);
  }

  // ---- perintah upload url langsung ----
  if (text.startsWith("/upload_url")) {
    const args = text.split(" ").slice(1); // [link, title?, tags?]
    if (!args[0]) return sendMessage(chatId, "❌ Gunakan: /upload_url <link> [judul] [tag1,tag2]", env);
    const url = args[0];
    const title = args[1] || "";
    const tags = args[2] || "";

    return uploadFromUrl(chatId, url, title, tags, apiBase, env);
  }

  // ---- folder default setter ----
  if (text.startsWith("/folder")) {
    const fld = text.split(" ")[1] || "0";
    // simpan di KV khusus user
    await env.BOT_STATE.put(`folder:${chatId}`, fld, { expirationTtl: 86400 * 30 });
    return sendMessage(chatId, `✅ Folder default di-set ke **${fld}**`, env);
  }

  // ---- handle state dialog ----
  const stateKey = `chat:${chatId}`;
  const currentState = await env.BOT_STATE.get(stateKey, { type: "json" });

  // kalau ada file masuk dan tidak dalam state, mulai dialog
  if (fileInfo && !currentState) {
    const fileId = fileInfo.file_id;
    await env.BOT_STATE.put(stateKey, JSON.stringify({
      state: "AWAIT_TITLE",
      file_id: fileId,
      data: {}
    }), { expirationTtl: 600 });
    return sendMessage(chatId, "📁 File video diterima. Sekarang kirim **judul** video.", env);
  }

  // prose dialog berdasarkan state
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
        return sendMessage(chatId, "🏷️ Sekarang kirim **tag** (pisahkan koma atau spasi). Atau kirim `-` untuk kosong.", env);

      case "AWAIT_TAGS":
        data.tags = text === "-" ? "" : text;
        await env.BOT_STATE.put(stateKey, JSON.stringify({
          state: "AWAIT_FOLDER",
          file_id,
          data
        }), { expirationTtl: 600 });
        return sendMessage(chatId, "📂 Masukkan **folder ID** (bisa 0 untuk root, atau ketik `0`).\nKamu juga bisa ketik `/folder <id>` dulu.", env);

      case "AWAIT_FOLDER":
        data.fld_id = text || "0";
        // hapus state, lakukan upload
        await env.BOT_STATE.delete(stateKey);
        return uploadFile(chatId, file_id, data.title, data.tags, data.fld_id, apiBase, env);

      default:
        await env.BOT_STATE.delete(stateKey);
        return sendMessage(chatId, "⚠️ State tidak valid, dibatalkan.", env);
    }
  }

  // jika bukan perintah dan tidak ada file & tidak ada state, tanggapi dengan help
  return sendMessage(chatId, "Ketik /start untuk bantuan.", env);
}

// ------- helper functions -------

async function sendMessage(chatId, text, env) {
  const token = env.BOT_TOKEN;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
    }),
  });
  return new Response("OK");
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
    await sendMessage(chatId, "✅ Upload URL berhasil!\n" + JSON.stringify(data, null, 2), env);
  } catch (e) {
    await sendMessage(chatId, "❌ Gagal upload: " + e.message, env);
  }
  return new Response("OK");
}

async function uploadFile(chatId, fileId, title, tags, fld_id, apiBase, env) {
  try {
    // 1. Unduh file dari Telegram
    const token = env.BOT_TOKEN;
    const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const fileJson = await fileRes.json();
    if (!fileJson.ok) throw new Error("Gagal mengambil info file: " + fileJson.description);
    const filePath = fileJson.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const fileBlob = await fetch(downloadUrl).then(r => r.blob());

    // 2. Kirim ke API utama sebagai FormData
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
    await sendMessage(chatId, "✅ Upload file berhasil!\n" + JSON.stringify(result, null, 2), env);
  } catch (e) {
    await sendMessage(chatId, "❌ Gagal upload file: " + e.message, env);
  }
  return new Response("OK");
}

async function getDefaultFolder(chatId, env) {
  const saved = await env.BOT_STATE.get(`folder:${chatId}`);
  return saved || "0";
}
