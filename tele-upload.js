// workers.js
// Telegram Upload Bot for Cloudflare Workers

export default {
  async fetch(request, env) {

    const BOT_TOKEN = env.BOT_TOKEN;
    const WEBHOOK_SECRET = env.WEBHOOK_SECRET || "secret";

    const UPLOAD_URL =
      "https://bokepflix.sakittakberdarah.workers.dev/api/upload/file";

    const FOLDERS_URL =
      "https://bokepflix.sakittakberdarah.workers.dev/api/folders";

    const url = new URL(request.url);

    // =========================
    // SET WEBHOOK
    // =========================

    if (url.pathname === "/setup") {

      const webhookUrl =
        `${url.origin}/telegram/${WEBHOOK_SECRET}`;

      const tg = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            url: webhookUrl
          })
        }
      );

      return Response.json(await tg.json());
    }

    // =========================
    // WEBHOOK
    // =========================

    if (
      request.method === "POST" &&
      url.pathname === `/telegram/${WEBHOOK_SECRET}`
    ) {

      const update = await request.json();

      const msg =
        update.message ||
        update.edited_message;

      const callback =
        update.callback_query;

      // =========================
      // CALLBACK BUTTON
      // =========================

      if (callback) {

        const chatId =
          callback.message.chat.id;

        const data = callback.data || "";

        if (data.startsWith("folder_")) {

          const sessionKey =
            `session_${chatId}`;

          const session =
            JSON.parse(
              await env.SESSIONS.get(sessionKey)
            );

          session.folder =
            data.replace("folder_", "");

          await env.SESSIONS.put(
            sessionKey,
            JSON.stringify(session),
            {
              expirationTtl: 3600
            }
          );

          await fetch(
            `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json"
              },
              body: JSON.stringify({
                callback_query_id: callback.id
              })
            }
          );

          await sendMessage(
            BOT_TOKEN,
            chatId,
            "Uploading video..."
          );

          await uploadVideo(
            env,
            BOT_TOKEN,
            chatId,
            session
          );

          return Response.json({
            ok: true
          });
        }
      }

      // =========================
      // MESSAGE
      // =========================

      if (msg) {

        const chatId =
          msg.chat.id;

        const sessionKey =
          `session_${chatId}`;

        const sessionRaw =
          await env.SESSIONS.get(sessionKey);

        let session =
          sessionRaw
            ? JSON.parse(sessionRaw)
            : null;

        // =========================
        // START
        // =========================

        if (msg.text === "/start") {

          await sendMessage(
            BOT_TOKEN,
            chatId,
            "Kirim video/document video."
          );

          return Response.json({
            ok: true
          });
        }

        // =========================
        // VIDEO RECEIVED
        // =========================

        if (
          msg.video ||
          msg.document
        ) {

          const media =
            msg.video || msg.document;

          session = {
            step: "title",
            fileId: media.file_id
          };

          await env.SESSIONS.put(
            sessionKey,
            JSON.stringify(session),
            {
              expirationTtl: 3600
            }
          );

          await sendMessage(
            BOT_TOKEN,
            chatId,
            "Masukkan judul:"
          );

          return Response.json({
            ok: true
          });
        }

        // =========================
        // TITLE
        // =========================

        if (
          session &&
          session.step === "title"
        ) {

          session.title =
            msg.text;

          session.step =
            "description";

          await env.SESSIONS.put(
            sessionKey,
            JSON.stringify(session),
            {
              expirationTtl: 3600
            }
          );

          await sendMessage(
            BOT_TOKEN,
            chatId,
            "Masukkan deskripsi:"
          );

          return Response.json({
            ok: true
          });
        }

        // =========================
        // DESCRIPTION
        // =========================

        if (
          session &&
          session.step === "description"
        ) {

          session.description =
            msg.text;

          session.step =
            "tags";

          await env.SESSIONS.put(
            sessionKey,
            JSON.stringify(session),
            {
              expirationTtl: 3600
            }
          );

          await sendMessage(
            BOT_TOKEN,
            chatId,
            "Masukkan tags:"
          );

          return Response.json({
            ok: true
          });
        }

        // =========================
        // TAGS
        // =========================

        if (
          session &&
          session.step === "tags"
        ) {

          session.tags =
            msg.text;

          session.step =
            "folder";

          await env.SESSIONS.put(
            sessionKey,
            JSON.stringify(session),
            {
              expirationTtl: 3600
            }
          );

          const folderReq =
            await fetch(FOLDERS_URL);

          const folderJson =
            await folderReq.json();

          const folders =
            folderJson.result || [];

          const buttons =
            folders.map(f => [{
              text:
                `${f.name} (${f.fld_id})`,
              callback_data:
                `folder_${f.fld_id}`
            }]);

          await sendMessage(
            BOT_TOKEN,
            chatId,
            "Pilih folder:",
            {
              inline_keyboard:
                buttons
            }
          );

          return Response.json({
            ok: true
          });
        }
      }

      return Response.json({
        ok: true
      });
    }

    return new Response("Not Found", {
      status: 404
    });
  }
};

// =========================
// SEND MESSAGE
// =========================

async function sendMessage(
  BOT_TOKEN,
  chatId,
  text,
  keyboard = null
) {

  const body = {
    chat_id: chatId,
    text
  };

  if (keyboard) {
    body.reply_markup = keyboard;
  }

  await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
}

// =========================
// UPLOAD VIDEO
// =========================

async function uploadVideo(
  env,
  BOT_TOKEN,
  chatId,
  session
) {

  try {

    const tgFile =
      await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getFile`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            file_id: session.fileId
          })
        }
      );

    const tgJson =
      await tgFile.json();

    const filePath =
      tgJson.result.file_path;

    const fileUrl =
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

    const videoReq =
      await fetch(fileUrl);

    const videoBlob =
      await videoReq.blob();

    const form =
      new FormData();

    form.append(
      "file",
      videoBlob,
      "video.mp4"
    );

    form.append(
      "title",
      session.title || ""
    );

    form.append(
      "description",
      session.description || ""
    );

    form.append(
      "tags",
      session.tags || ""
    );

    form.append(
      "fld_id",
      session.folder || "0"
    );

    const uploadReq =
      await fetch(
        "https://bokepflix.sakittakberdarah.workers.dev/api/upload/file",
        {
          method: "POST",
          body: form
        }
      );

    const uploadJson =
      await uploadReq.json();

    const item =
      uploadJson?.result?.result?.[0] || {};

    await sendMessage(
      BOT_TOKEN,
      chatId,
      [
        "UPLOAD BERHASIL ✅",
        "",
        `Title: ${item.title || "-"}`,
        `File Code: ${item.filecode || "-"}`,
        "",
        `Embed:`,
        item.protected_embed || "-",
        "",
        `Download:`,
        item.download_url || "-"
      ].join("\n")
    );

  } catch (err) {

    await sendMessage(
      BOT_TOKEN,
      chatId,
      `Upload gagal:\n${err.message || err}`
    );
  }
}
