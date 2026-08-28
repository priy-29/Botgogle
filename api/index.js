const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const axios = require('axios');

// ==========================================
// 1. INISIALISASI BOT & AUTH GOOGLE DRIVE
// ==========================================
const bot = new Telegraf(process.env.BOT_TOKEN);

const getGoogleDriveClient = () => {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  return google.drive({ version: 'v3', auth });
};

// ==========================================
// 2. FUNGSI SCRAPER GOOGLE FORM OTOMATIS
// ==========================================
async function getFormEntries(formUrl) {
  try {
    const cleanUrl = formUrl.replace(/\/formResponse.*/, '/viewform');
    const response = await axios.get(cleanUrl);
    const html = response.data;

    // Mengambil struktur data form rahasia dari Google
    const match = html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(.*?);<\/script>/s);
    if (!match) throw new Error('Gagal menemukan data formulir.');

    const rawData = JSON.parse(match[1]);
    const questions = rawData[1][1]; 
    const formFields = [];

    questions.forEach((q) => {
      const questionTitle = q[1];      
      const entryId = q[4]?.[0]?.[0];   

      if (entryId) {
        formFields.push({
          title: questionTitle,
          entryParam: `entry.${entryId}`
        });
      }
    });

    return {
      fields: formFields,
      submitUrl: cleanUrl.replace(/\/viewform.*/, '/formResponse')
    };
  } catch (error) {
    console.error('Scraper Error:', error.message);
    return null;
  }
}

// ==========================================
// 3. DATABASE SESI SEMENTARA (MEMORY)
// ==========================================
const userSessions = {};

// ==========================================
// 4. LOGIKA PERCAKAPAN BOT (WIZARD)
// ==========================================
bot.start((ctx) => {
  ctx.reply(
    `Halo ${ctx.from.first_name}! 👋\n\n` +
    `Kirimkan link Google Form apa saja ke sini, dan aku akan membantumu mengisinya langsung dari Telegram.`
  );
});

// Menangkap semua pesan (Teks, Foto, Dokumen)
bot.on('message', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = userSessions[chatId] || { isAnswering: false };
  const textMsg = ctx.message.text || '';

  // SKENARIO A: User mengirim link Google Form baru
  if (textMsg.includes('docs.google.com/forms/')) {
    await ctx.reply('🔍 Sedang membaca formulir...');
    const formData = await getFormEntries(textMsg);

    if (!formData || formData.fields.length === 0) {
      return ctx.reply('❌ Gagal membaca formulir. Pastikan link bisa diakses publik (tidak perlu login).');
    }

    // Mulai sesi pengisian
    userSessions[chatId] = {
      isAnswering: true,
      submitUrl: formData.submitUrl,
      fields: formData.fields,
      currentIndex: 0,
      answers: {} // Tempat menyimpan jawaban
    };

    const firstQuestion = formData.fields[0].title;
    return ctx.reply(`✅ Formulir ditemukan!\n\nPertanyaan 1:\n*${firstQuestion}*`, { parse_mode: 'Markdown' });
  }

  // SKENARIO B: User sedang dalam proses menjawab form
  if (session.isAnswering) {
    const currentField = session.fields[session.currentIndex];
    let answerValue = '';

    // Jika user membalas dengan Foto atau PDF/Dokumen
    if (ctx.message.photo || ctx.message.document) {
      try {
        await ctx.reply('⏳ Sedang mengunggah file ke Google Drive...');
        
        let fileId, fileName, mimeType;
        if (ctx.message.photo) {
          const photo = ctx.message.photo[ctx.message.photo.length - 1];
          fileId = photo.file_id;
          fileName = `Foto_${chatId}_${Date.now()}.jpg`;
          mimeType = 'image/jpeg';
        } else {
          fileId = ctx.message.document.file_id;
          fileName = ctx.message.document.file_name;
          mimeType = ctx.message.document.mime_type;
        }

        const fileLink = await ctx.telegram.getFileLink(fileId);
        const fileStream = await axios({ url: fileLink.href, responseType: 'stream' });

        const drive = getGoogleDriveClient();
        const driveRes = await drive.files.create({
          requestBody: { name: fileName, parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] },
          media: { mimeType: mimeType, body: fileStream.data },
          fields: 'webViewLink'
        });

        answerValue = driveRes.data.webViewLink; // Jawaban diisi dengan link Drive
      } catch (error) {
        console.error('Upload Error:', error);
        return ctx.reply('❌ Gagal mengunggah file. Silakan kirim ulang file tersebut.');
      }
    } 
    // Jika user membalas dengan teks biasa
    else if (textMsg) {
      answerValue = textMsg;
    } else {
      return ctx.reply('Tolong kirimkan teks, foto, atau dokumen.');
    }

    // Simpan jawaban ke memori
    session.answers[currentField.entryParam] = answerValue;
    session.currentIndex++;

    // Cek apakah masih ada pertanyaan selanjutnya
    if (session.currentIndex < session.fields.length) {
      const nextQuestion = session.fields[session.currentIndex].title;
      return ctx.reply(`Pertanyaan ${session.currentIndex + 1}:\n*${nextQuestion}*`, { parse_mode: 'Markdown' });
    } 
    
    // SKENARIO C: Semua pertanyaan sudah dijawab, kirim ke Google Form!
    else {
      await ctx.reply('🚀 Semua data terkumpul! Sedang mengirim ke Google Form...');
      
      try {
        const params = new URLSearchParams();
        for (const [entryKey, value] of Object.entries(session.answers)) {
          params.append(entryKey, value);
        }

        await axios.post(session.submitUrl, params);
        
        await ctx.reply('✅ Berhasil! Data formulirmu sudah terkirim sempurna.');
        delete userSessions[chatId]; // Bersihkan sesi
      } catch (error) {
        console.error('Submit Error:', error.message);
        ctx.reply('❌ Gagal mengirim ke Google Form, tapi file sudah tersimpan. Ketik /start untuk mengulang.');
        delete userSessions[chatId];
      }
    }
  }
});

// ==========================================
// 5. EXPORT UNTUK VERCEL SERVERLESS
// ==========================================
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
  } else {
    res.status(200).send('Bot Google Form Dinamis Berjalan Lancar di Vercel!');
  }
};
