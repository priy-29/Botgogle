const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const axios = require('axios');

// Inisialisasi Bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// Fungsi Autentikasi Google Drive
const getDriveClient = () => {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  return google.drive({ version: 'v3', auth });
};

// Fungsi Scraper Google Form Otomatis
async function getFormEntries(formUrl) {
  try {
    const cleanUrl = formUrl.replace(/\/formResponse.*/, '/viewform');
    const response = await axios.get(cleanUrl);
    const match = response.data.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(.*?);<\/script>/s);
    if (!match) return null;

    const rawData = JSON.parse(match[1]);
    const questions = rawData[1][1]; 
    const formFields = [];

    questions.forEach((q) => {
      const title = q[1];      
      const entryId = q[4]?.[0]?.[0];   
      if (entryId) formFields.push({ title, entryParam: `entry.${entryId}` });
    });

    return { fields: formFields, submitUrl: cleanUrl.replace(/\/viewform.*/, '/formResponse') };
  } catch (error) {
    return null;
  }
}

// Database Sesi (Memory)
let userSessions = {};

// Perintah /start
bot.start((ctx) => {
  ctx.reply(`Halo ${ctx.from.first_name}! 👋\n\nKirimkan link Google Form ke sini, dan aku akan bantu mengisinya.`);
});

// Menangkap Pesan Teks dan File
bot.on('message', async (ctx) => {
  const chatId = ctx.chat.id;
  const textMsg = ctx.message.text || '';
  
  // Deteksi Link Form
  if (textMsg.includes('docs.google.com/forms/')) {
    await ctx.reply('🔍 Sedang membaca formulir...');
    const formData = await getFormEntries(textMsg);
    if (!formData) return ctx.reply('❌ Gagal membaca formulir.');

    userSessions[chatId] = { isAnswering: true, ...formData, currentIndex: 0, answers: {} };
    return ctx.reply(`✅ Formulir ditemukan!\n\nPertanyaan 1:\n*${formData.fields[0].title}*`, { parse_mode: 'Markdown' });
  }

  // Proses Menjawab
  const session = userSessions[chatId];
  if (session && session.isAnswering) {
    const currentField = session.fields[session.currentIndex];
    let answerValue = '';

    if (ctx.message.photo || ctx.message.document) {
      try {
        await ctx.reply('⏳ Sedang mengunggah file ke Google Drive...');
        const fileId = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : ctx.message.document.file_id;
        const fileName = ctx.message.document ? ctx.message.document.file_name : `Foto_${Date.now()}.jpg`;
        const mimeType = ctx.message.document ? ctx.message.document.mime_type : 'image/jpeg';
        
        const fileLink = await ctx.telegram.getFileLink(fileId);
        const fileStream = await axios({ url: fileLink.href, responseType: 'stream' });

        const drive = getDriveClient();
        const driveRes = await drive.files.create({
          requestBody: { name: fileName, parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] },
          media: { mimeType, body: fileStream.data },
          fields: 'webViewLink'
        });
        answerValue = driveRes.data.webViewLink;
      } catch (error) {
        return ctx.reply('❌ Gagal mengunggah file. Silakan coba lagi.');
      }
    } else if (textMsg) {
      answerValue = textMsg;
    } else {
      return ctx.reply('Tolong kirimkan teks, foto, atau dokumen.');
    }

    session.answers[currentField.entryParam] = answerValue;
    session.currentIndex++;

    if (session.currentIndex < session.fields.length) {
      return ctx.reply(`Pertanyaan ${session.currentIndex + 1}:\n*${session.fields[session.currentIndex].title}*`, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply('🚀 Mengirim jawaban ke Google Form...');
      try {
        const params = new URLSearchParams();
        for (const [key, val] of Object.entries(session.answers)) params.append(key, val);
        await axios.post(session.submitUrl, params);
        ctx.reply('✅ Berhasil! Data formulirmu sudah terkirim sempurna.');
      } catch (error) {
        ctx.reply('❌ Gagal mengirim ke Google Form.');
      }
      delete userSessions[chatId];
    }
  }
});

// Wajib untuk Serverless Vercel
module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body, res);
    } else {
      res.status(200).send('Bot berjalan lancar di Vercel - Versi Baru!');
    }
  } catch (error) {
    console.error('Vercel Error:', error);
    res.status(500).send('Terjadi kendala pada server.');
  }
};
