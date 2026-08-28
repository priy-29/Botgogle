const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');
const axios = require('axios');

// 1. Inisialisasi Bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// 2. Fungsi Auth Google Drive
const getGoogleDriveClient = () => {
  // Mengambil kredensial JSON dari Vercel Environment Variable
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  return google.drive({ version: 'v3', auth });
};

// Memory sementara untuk menyimpan tahap percakapan user
const userSessions = {};

const resetSession = (chatId) => {
  delete userSessions[chatId];
};

// --- HANDLER COMMAND /start ---
bot.start((ctx) => {
  const chatId = ctx.chat.id;
  resetSession(chatId);

  ctx.reply(
    `Halo ${ctx.from.first_name}! 👋\n\nSelamat datang di Bot Formulir Otomatis. Klik tombol di bawah untuk mulai mengisi data:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('📝 Mulai Isi Form', 'START_FORM')]
    ])
  );
});

// --- TOMBOL INLINE: MULAI FORM ---
bot.action('START_FORM', (ctx) => {
  const chatId = ctx.chat.id;
  userSessions[chatId] = { step: 'AWAITING_NAMA' };
  
  ctx.answerCbQuery();
  ctx.reply('📌 *Langkah 1:* Silakan ketik *Nama Lengkap* Anda:', { parse_mode: 'Markdown' });
});

// --- HANDLER TEKS (Mengambil Nama) ---
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = userSessions[chatId];

  if (!session) {
    return ctx.reply('Ketik /start untuk memulai pengisian form.');
  }

  if (session.step === 'AWAITING_NAMA') {
    session.nama = ctx.message.text;
    session.step = 'AWAITING_KATEGORI';

    // Menampilkan Pilihan Kategori dengan Inline Keyboard
    return ctx.reply(
      `Terima kasih, *${session.nama}*!\n\n📌 *Langkah 2:* Pilih kategori pekerjaan Anda di bawah ini:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💻 IT / Developer', 'KAT_IT')],
          [Markup.button.callback('🎨 Designer', 'KAT_DESIGN')],
          [Markup.button.callback('📈 Marketing', 'KAT_MARKETING')]
        ])
      }
    );
  }
});

// --- HANDLER INLINE KEYBOARD (Pilihan Kategori) ---
bot.action(/^KAT_/, (ctx) => {
  const chatId = ctx.chat.id;
  const session = userSessions[chatId];

  if (!session || session.step !== 'AWAITING_KATEGORI') {
    return ctx.reply('Sesi telah habis. Ketik /start untuk mengulang.');
  }

  const kategoriMap = {
    KAT_IT: 'IT / Developer',
    KAT_DESIGN: 'Designer',
    KAT_MARKETING: 'Marketing'
  };

  session.kategori = kategoriMap[ctx.match[0]] || 'Lainnya';
  session.step = 'AWAITING_FILE';

  ctx.answerCbQuery();
  ctx.reply(
    `Kategori dipilih: *${session.kategori}*\n\n📌 *Langkah Terakhir:* Silakan kirimkan dokumen/foto bukti (Bisa berupa Gambar atau PDF):`,
    { parse_mode: 'Markdown' }
  );
});

// --- HANDLER UPLOAD FILE (Foto atau Document/PDF) ---
bot.on(['photo', 'document'], async (ctx) => {
  const chatId = ctx.chat.id;
  const session = userSessions[chatId];

  if (!session || session.step !== 'AWAITING_FILE') {
    return ctx.reply('Sesi tidak valid. Ketik /start untuk memulai kembali.');
  }

  try {
    await ctx.reply('⏳ Sedang memproses file dan mengunggah ke Google Drive...');

    let fileId, fileName, mimeType;

    if (ctx.message.photo) {
      // Mengambil foto dengan resolusi terbaik
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      fileId = photo.file_id;
      fileName = `Foto_${chatId}_${Date.now()}.jpg`;
      mimeType = 'image/jpeg';
    } else if (ctx.message.document) {
      fileId = ctx.message.document.file_id;
      fileName = ctx.message.document.file_name || `Doc_${chatId}_${Date.now()}`;
      mimeType = ctx.message.document.mime_type;
    }

    // 1. Ambil Link download dari Telegram
    const fileLink = await ctx.telegram.getFileLink(fileId);
    
    // 2. Download file sebagai stream
    const fileStream = await axios({
      url: fileLink.href,
      responseType: 'stream'
    });

    // 3. Unggah File ke Google Drive
    const drive = getGoogleDriveClient();
    const driveRes = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] // ID Folder Drive kamu
      },
      media: {
        mimeType: mimeType,
        body: fileStream.data
      },
      fields: 'id, webViewLink'
    });

    const fileDriveUrl = driveRes.data.webViewLink;

    // 4. Tembak Data ke Google Form Orang Lain
    await ctx.reply('⏳ Mengirimkan jawaban ke Google Form...');

    const params = new URLSearchParams();
    params.append(process.env.ENTRY_NAMA, session.nama);
    params.append(process.env.ENTRY_KATEGORI, session.kategori);
    params.append(process.env.ENTRY_FILE_LINK, fileDriveUrl); // Kirim URL Drive ke kolom teks form

    await axios.post(process.env.GOOGLE_FORM_URL, params);

    // 5. Kirimkan Rekap Hasil ke Telegram
    await ctx.reply(
      `✅ *Pendaftaran Berhasil Dikirim!*\n\n` +
      `📋 *Rekap Data Informasi:*\n` +
      `• *Nama:* ${session.nama}\n` +
      `• *Kategori:* ${session.kategori}\n` +
      `• *Link Lampiran Drive:* [Klik untuk Buka File](${fileDriveUrl})\n\n` +
      `Terima kasih telah mengisi formulir!`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );

    resetSession(chatId);

  } catch (error) {
    console.error('Error saat submit:', error);
    ctx.reply('❌ Terjadi kesalahan saat mengunggah file atau mengirim data. Silakan coba lagi dengan /start.');
  }
});

// --- EXPORT UNTUK VERCEL SERVERLESS ---
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
  } else {
    res.status(200).send('Bot Google Form Vercel Siap!');
  }
};
             
