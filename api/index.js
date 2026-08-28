const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const axios = require('axios');

// =====================================================
// CONFIG
// =====================================================

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN belum diset di Vercel Environment Variables');
}

const bot = new Telegraf(BOT_TOKEN);

// =====================================================
// GOOGLE DRIVE
// =====================================================

function getDriveClient() {
  try {
    const credentials = JSON.parse(
      process.env.GOOGLE_CREDENTIALS || '{}'
    );

    if (!credentials.client_email || !credentials.private_key) {
      throw new Error('GOOGLE_CREDENTIALS tidak lengkap');
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/drive.file'
      ]
    });

    return google.drive({
      version: 'v3',
      auth
    });

  } catch (error) {
    console.error('Google Drive config error:', error.message);
    throw error;
  }
}

// =====================================================
// NORMALIZE GOOGLE FORM URL
// =====================================================

function normalizeFormUrl(input) {
  try {
    const url = new URL(input.trim());

    if (
      url.hostname !== 'docs.google.com' &&
      url.hostname !== 'docs.googleusercontent.com'
    ) {
      return null;
    }

    if (!url.pathname.includes('/forms/')) {
      return null;
    }

    /*
     * Contoh URL:
     *
     * /forms/d/e/FORM_ID/viewform
     * /forms/d/e/FORM_ID/formResponse
     * /forms/d/e/FORM_ID/viewform?usp=publish-editor...
     *
     * Kita buang semua query parameter.
     */

    const parts = url.pathname.split('/');

    const formsIndex = parts.indexOf('forms');

    if (formsIndex === -1) {
      return null;
    }

    const dIndex = parts.indexOf('d', formsIndex);

    if (dIndex === -1 || !parts[dIndex + 1]) {
      return null;
    }

    const formId = parts[dIndex + 1];

    if (!formId) {
      return null;
    }

    const basePath =
      `/forms/d/${formId}`;

    return {
      viewUrl:
        `https://docs.google.com${basePath}/viewform`,

      submitUrl:
        `https://docs.google.com${basePath}/formResponse`
    };

  } catch (error) {
    console.error(
      'Invalid Google Form URL:',
      error.message
    );

    return null;
  }
}

// =====================================================
// EXTRACT FB_PUBLIC_LOAD_DATA_
// =====================================================

function extractPublicLoadData(html) {
  /*
   * Google Form biasanya mempunyai:
   *
   * FB_PUBLIC_LOAD_DATA_ = [...]
   *
   * Tetapi format script bisa berubah.
   *
   * Jadi jangan bergantung pada:
   *
   * <script>...</script>
   *
   * saja.
   */

  const marker = 'FB_PUBLIC_LOAD_DATA_';

  const markerIndex = html.indexOf(marker);

  if (markerIndex === -1) {
    return null;
  }

  const equalsIndex = html.indexOf(
    '=',
    markerIndex + marker.length
  );

  if (equalsIndex === -1) {
    return null;
  }

  const start = html.indexOf(
    '[',
    equalsIndex
  );

  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const char = html[i];

    if (inString) {

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '[') {
      depth++;
    }

    if (char === ']') {
      depth--;

      if (depth === 0) {
        return html.slice(
          start,
          i + 1
        );
      }
    }
  }

  return null;
}

// =====================================================
// RECURSIVE GOOGLE FORM QUESTION FINDER
// =====================================================

function extractQuestionFields(data) {

  const fields = [];
  const seen = new Set();

  function walk(node) {

    if (!Array.isArray(node)) {
      return;
    }

    /*
     * Bentuk question Google Form yang umum:
     *
     * [
     *   ...,
     *   "Judul pertanyaan",
     *   ...,
     *   [
     *      [ENTRY_ID, ...]
     *   ]
     * ]
     */

    if (
      typeof node[1] === 'string' &&
      Array.isArray(node[4])
    ) {

      let entryId = null;

      try {

        if (
          Array.isArray(node[4][0]) &&
          node[4][0][0] != null
        ) {
          entryId = String(
            node[4][0][0]
          );
        }

      } catch (_) {}

      if (
        entryId &&
        /^\d+$/.test(entryId) &&
        !seen.has(entryId)
      ) {

        const title =
          String(node[1]).trim();

        if (title) {

          seen.add(entryId);

          fields.push({
            title,
            entryId,
            entryParam:
              `entry.${entryId}`
          });

        }
      }
    }

    for (const child of node) {
      if (Array.isArray(child)) {
        walk(child);
      }
    }
  }

  walk(data);

  return fields;
}

// =====================================================
// FALLBACK: SEARCH ENTRY IDS IN HTML
// =====================================================

function extractFallbackFields(html) {

  const fields = [];
  const seen = new Set();

  /*
   * Fallback ini digunakan kalau struktur
   * FB_PUBLIC_LOAD_DATA_ berubah.
   *
   * Kita cari pola:
   *
   * entry.123456
   */

  const regex =
    /entry\.(\d{5,})/g;

  let match;

  while (
    (match = regex.exec(html)) !== null
  ) {

    const entryId = match[1];

    if (seen.has(entryId)) {
      continue;
    }

    seen.add(entryId);

    fields.push({
      title:
        `Pertanyaan ${fields.length + 1}`,

      entryId,

      entryParam:
        `entry.${entryId}`
    });
  }

  return fields;
}

// =====================================================
// GET GOOGLE FORM
// =====================================================

async function getFormEntries(formUrl) {

  try {

    const normalized =
      normalizeFormUrl(formUrl);

    if (!normalized) {
      console.error(
        'URL Google Form tidak valid'
      );

      return null;
    }

    console.log(
      'Reading Google Form:',
      normalized.viewUrl
    );

    const response =
      await axios.get(
        normalized.viewUrl,
        {
          timeout: 20000,

          maxRedirects: 5,

          headers: {
            'User-Agent':
              'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36',

            'Accept':
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

            'Accept-Language':
              'en-US,en;q=0.9,id;q=0.8'
          },

          validateStatus:
            status =>
              status >= 200 &&
              status < 400
        }
      );

    const html =
      response.data;

    if (
      typeof html !== 'string' ||
      html.length < 100
    ) {

      console.error(
        'Response Google Form kosong'
      );

      return null;
    }

    console.log(
      'Google Form HTML:',
      html.length,
      'bytes'
    );

    // -------------------------------------------------
    // PARSER UTAMA
    // -------------------------------------------------

    const jsonText =
      extractPublicLoadData(html);

    let fields = [];

    if (jsonText) {

      try {

        const data =
          JSON.parse(jsonText);

        fields =
          extractQuestionFields(data);

        console.log(
          'Questions found:',
          fields.length
        );

      } catch (error) {

        console.error(
          'FB_PUBLIC_LOAD_DATA JSON error:',
          error.message
        );
      }
    } else {

      console.log(
        'FB_PUBLIC_LOAD_DATA_ tidak ditemukan'
      );
    }

    // -------------------------------------------------
    // FALLBACK
    // -------------------------------------------------

    if (fields.length === 0) {

      console.log(
        'Menggunakan fallback parser...'
      );

      fields =
        extractFallbackFields(html);

      console.log(
        'Fallback fields:',
        fields.length
      );
    }

    // -------------------------------------------------
    // VALIDASI
    // -------------------------------------------------

    if (fields.length === 0) {

      /*
       * Simpan sedikit informasi diagnostik
       * ke Vercel Logs.
       */

      console.error(
        'Tidak ada field Google Form yang ditemukan'
      );

      console.error(
        'HTML contains form:',
        html.includes(
          'docs.google.com/forms'
        )
      );

      console.error(
        'HTML contains entry:',
        html.includes('entry.')
      );

      return null;
    }

    return {
      fields,
      submitUrl:
        normalized.submitUrl
    };

  } catch (error) {

    console.error(
      'getFormEntries ERROR:',
      error.message
    );

    if (error.response) {

      console.error(
        'HTTP:',
        error.response.status
      );

      console.error(
        'URL:',
        error.config?.url
      );
    }

    return null;
  }
}

// =====================================================
// SESSION DATABASE
// =====================================================

const userSessions = {};

// =====================================================
// START
// =====================================================

bot.start(async (ctx) => {

  await ctx.reply(
    `Halo ${ctx.from.first_name || 'Pak'}! 👋\n\n` +
    `Kirimkan link Google Form ke sini, ` +
    `dan aku akan bantu mengisinya.`
  );

});

// =====================================================
// CANCEL
// =====================================================

bot.command('cancel', async (ctx) => {

  const chatId =
    ctx.chat.id;

  delete userSessions[chatId];

  await ctx.reply(
    '❌ Pengisian formulir dibatalkan.'
  );

});

// =====================================================
// MESSAGE HANDLER
// =====================================================

bot.on('message', async (ctx) => {

  const chatId =
    ctx.chat.id;

  const message =
    ctx.message;

  const textMsg =
    message.text ||
    message.caption ||
    '';

  // ===================================================
  // DETEKSI GOOGLE FORM
  // ===================================================

  if (
    textMsg.includes(
      'docs.google.com/forms/'
    )
  ) {

    await ctx.reply(
      '🔍 Sedang membaca formulir...'
    );

    const formData =
      await getFormEntries(textMsg);

    if (!formData) {

      return ctx.reply(
        '❌ Gagal membaca formulir.\n\n' +
        'Pastikan formulir bisa dibuka ' +
        'tanpa login dan link yang dikirim ' +
        'adalah link Google Form publik.'
      );
    }

    if (
      !formData.fields ||
      formData.fields.length === 0
    ) {

      return ctx.reply(
        '❌ Formulir terbaca, tetapi ' +
        'tidak ada pertanyaan yang ditemukan.'
      );
    }

    userSessions[chatId] = {

      isAnswering: true,

      ...formData,

      currentIndex: 0,

      answers: {}
    };

    const firstField =
      formData.fields[0];

    return ctx.reply(
      `✅ Formulir ditemukan!\n\n` +
      `📋 Total pertanyaan: ${formData.fields.length}\n\n` +
      `Pertanyaan 1:\n` +
      `${firstField.title}`,
    );
  }

  // ===================================================
  // SESSION
  // ===================================================

  const session =
    userSessions[chatId];

  if (
    !session ||
    !session.isAnswering
  ) {
    return;
  }

  const currentField =
    session.fields[
      session.currentIndex
    ];

  if (!currentField) {

    delete userSessions[chatId];

    return ctx.reply(
      '❌ Sesi formulir tidak valid. ' +
      'Silakan kirim ulang link Google Form.'
    );
  }

  let answerValue = '';

  // ===================================================
  // PHOTO / DOCUMENT
  // ===================================================

  if (
    message.photo ||
    message.document
  ) {

    try {

      await ctx.reply(
        '⏳ Sedang mengunggah file ke Google Drive...'
      );

      const fileId =
        message.photo
          ? message.photo[
              message.photo.length - 1
            ].file_id
          : message.document.file_id;

      const fileName =
        message.document
          ? message.document.file_name
          : `Foto_${Date.now()}.jpg`;

      const mimeType =
        message.document
          ? (
              message.document.mime_type ||
              'application/octet-stream'
            )
          : 'image/jpeg';

      const fileLink =
        await ctx.telegram.getFileLink(
          fileId
        );

      const fileStream =
        await axios({
          url: fileLink.href,

          responseType: 'stream',

          timeout: 30000
        });

      const drive =
        getDriveClient();

      const createData = {
        requestBody: {
          name: fileName
        },

        media: {
          mimeType,
          body: fileStream.data
        },

        fields:
          'id,name,webViewLink'
      };

      if (
        process.env.GOOGLE_DRIVE_FOLDER_ID
      ) {

        createData.requestBody.parents =
          [
            process.env.GOOGLE_DRIVE_FOLDER_ID
          ];
      }

      const driveRes =
        await drive.files.create(
          createData
        );

      /*
       * Supaya link dapat dibuka.
       */

      try {

        await drive.permissions.create({
          fileId:
            driveRes.data.id,

          requestBody: {
            role: 'reader',
            type: 'anyone'
          }
        });

      } catch (permissionError) {

        console.error(
          'Drive permission warning:',
          permissionError.message
        );
      }

      answerValue =
        driveRes.data.webViewLink ||
        `https://drive.google.com/file/d/${driveRes.data.id}/view`;

    } catch (error) {

      console.error(
        'Upload error:',
        error.message
      );

      return ctx.reply(
        '❌ Gagal mengunggah file.\n' +
        'Silakan coba lagi.'
      );
    }

  } else if (textMsg) {

    answerValue =
      textMsg.trim();

  } else {

    return ctx.reply(
      'Tolong kirimkan teks, foto, atau dokumen.'
    );
  }

  // ===================================================
  // SAVE ANSWER
  // ===================================================

  session.answers[
    currentField.entryParam
  ] = answerValue;

  session.currentIndex++;

  // ===================================================
  // NEXT QUESTION
  // ===================================================

  if (
    session.currentIndex <
    session.fields.length
  ) {

    const nextField =
      session.fields[
        session.currentIndex
      ];

    return ctx.reply(
      `Pertanyaan ${session.currentIndex + 1}:\n\n` +
      `${nextField.title}`
    );
  }

  // ===================================================
  // SUBMIT
  // ===================================================

  await ctx.reply(
    '🚀 Mengirim jawaban ke Google Form...'
  );

  try {

    const params =
      new URLSearchParams();

    for (
      const [key, value]
      of Object.entries(session.answers)
    ) {

      if (
        Array.isArray(value)
      ) {

        for (
          const item of value
        ) {

          params.append(
            key,
            String(item)
          );
        }

      } else {

        params.append(
          key,
          String(value)
        );
      }
    }

    const submitResponse =
      await axios.post(
        session.submitUrl,
        params.toString(),
        {
          timeout: 20000,

          maxRedirects: 5,

          headers: {
            'Content-Type':
              'application/x-www-form-urlencoded',

            'User-Agent':
              'Mozilla/5.0'
          },

          validateStatus:
            status =>
              status >= 200 &&
              status < 400
        }
      );

    console.log(
      'Google Form submit status:',
      submitResponse.status
    );

    await ctx.reply(
      '✅ Berhasil!\n\n' +
      'Data formulirmu sudah terkirim.'
    );

  } catch (error) {

    console.error(
      'Google Form submit error:',
      error.message
    );

    if (error.response) {

      console.error(
        'Submit HTTP status:',
        error.response.status
      );
    }

    await ctx.reply(
      '❌ Gagal mengirim ke Google Form.\n\n' +
      'Form berhasil dibaca, tetapi Google ' +
      'menolak pengiriman jawabannya.'
    );
  }

  // ===================================================
  // CLEAR SESSION
  // ===================================================

  delete userSessions[chatId];

});

// =====================================================
// VERCEL SERVERLESS
// =====================================================

module.exports = async (req, res) => {

  try {

    if (req.method === 'POST') {

      /*
       * Telegram webhook mengirim update JSON.
       */

      await bot.handleUpdate(
        req.body,
        res
      );

      return;
    }

    res.status(200).send(
      'Botgogle API berjalan lancar di Vercel.'
    );

  } catch (error) {

    console.error(
      'Vercel Error:',
      error
    );

    if (!res.headersSent) {

      res.status(500).send(
        'Terjadi kendala pada server.'
      );
    }
  }
};
