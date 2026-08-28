const { Telegraf, Markup } = require("telegraf");
const { google } = require("googleapis");
const { Redis } = require("@upstash/redis");
const crypto = require("crypto");

const bot = new Telegraf(process.env.BOT_TOKEN);

const redis = Redis.fromEnv();

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/forms.body.readonly",
  "https://www.googleapis.com/auth/drive.file"
];

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function tokenKey(chatId) {
  return `google:${chatId}`;
}

function stateKey(state) {
  return `oauth:${state}`;
}

function getFormId(url) {
  try {
    const u = new URL(url.trim());
    const m = u.pathname.match(/\/forms\/d\/(?:e\/)?([^/]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function loginUrl(chatId) {
  const state = crypto.randomBytes(32).toString("hex");

  await redis.set(
    stateKey(state),
    String(chatId),
    { ex: 600 }
  );

  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state
  });
}

async function getAuth(chatId) {
  const token = await redis.get(tokenKey(chatId));

  if (!token) return null;

  const auth = oauthClient();

  auth.setCredentials(token);

  auth.on("tokens", async tokens => {
    await redis.set(
      tokenKey(chatId),
      {
        ...token,
        ...tokens,
        refresh_token:
          tokens.refresh_token || token.refresh_token
      }
    );
  });

  return auth;
}

async function getProfile(auth) {
  const oauth2 = google.oauth2({
    auth,
    version: "v2"
  });

  return (await oauth2.userinfo.get()).data;
}

async function readForm(chatId, url) {
  const formId = getFormId(url);

  if (!formId) {
    throw new Error("Link Google Form tidak valid.");
  }

  const auth = await getAuth(chatId);

  if (!auth) {
    const e = new Error("GOOGLE_LOGIN");
    e.code = "GOOGLE_LOGIN";
    throw e;
  }

  const forms = google.forms({
    version: "v1",
    auth
  });

  return (
    await forms.forms.get({
      formId
    })
  ).data;
}

function questions(form) {
  const result = [];

  for (const item of form.items || []) {
    const q = item.questionItem?.question;

    if (!q) continue;

    result.push({
      itemId: item.itemId,
      questionId: q.questionId,
      title: item.title || "Pertanyaan",
      required: !!q.required,
      type: q.choiceQuestion
        ? "choice"
        : q.textQuestion
        ? "text"
        : "other",
      options:
        q.choiceQuestion?.options?.map(x => x.value) || []
    });
  }

  return result;
}

function questionText(q, index, total) {
  let text =
    `📋 Pertanyaan ${index + 1}/${total}\n\n${q.title}`;

  if (q.required) text += " *";

  if (q.options.length) {
    text += "\n\nPilihan:";
    q.options.forEach((x, i) => {
      text += `\n${i + 1}. ${x}`;
    });
  }

  return text;
}

bot.start(async ctx => {
  const token = await redis.get(tokenKey(ctx.chat.id));

  if (token) {
    return ctx.reply(
      `🤖 Botgogle\n\nGoogle: ✅ Terhubung\nAkun: ${
        token.email || "-"
      }\n\nKirim link Google Form.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🔓 Ganti Akun",
            "google_login"
          )
        ],
        [
          Markup.button.callback(
            "❌ Putuskan Google",
            "google_logout"
          )
        ]
      ])
    );
  }

  const url = await loginUrl(ctx.chat.id);

  await ctx.reply(
    "🤖 Botgogle\n\nGoogle: ❌ Belum terhubung",
    Markup.inlineKeyboard([
      [
        Markup.button.url(
          "🔐 Login Google",
          url
        )
      ]
    ])
  );
});

bot.action("google_login", async ctx => {
  await ctx.answerCbQuery();

  const url = await loginUrl(ctx.chat.id);

  await ctx.reply(
    "🔐 Login menggunakan akun Google:",
    Markup.inlineKeyboard([
      [
        Markup.button.url(
          "Login Google",
          url
        )
      ]
    ])
  );
});

bot.action("google_logout", async ctx => {
  await redis.del(tokenKey(ctx.chat.id));
  await ctx.answerCbQuery("Google diputuskan");
  await ctx.reply("✅ Akun Google sudah diputuskan.");
});

bot.command("cancel", async ctx => {
  await redis.del(`session:${ctx.chat.id}`);
  await ctx.reply("❌ Sesi dibatalkan.");
});

bot.on("message", async ctx => {
  const text =
    ctx.message.text ||
    ctx.message.caption ||
    "";

  const chatId = ctx.chat.id;

  if (text.includes("docs.google.com/forms/")) {
    let token = await redis.get(tokenKey(chatId));

    if (!token) {
      const url = await loginUrl(chatId);

      return ctx.reply(
        "❌ Login Google dulu.",
        Markup.inlineKeyboard([
          [
            Markup.button.url(
              "🔐 Login Google",
              url
            )
          ]
        ])
      );
    }

    await ctx.reply("🔍 Sedang membaca Google Form...");

    try {
      const form = await readForm(chatId, text);
      const fields = questions(form);

      if (!fields.length) {
        return ctx.reply(
          "❌ Form terbaca, tapi pertanyaan tidak ditemukan."
        );
      }

      const profile = await getProfile(
        await getAuth(chatId)
      );

      await redis.set(
        `session:${chatId}`,
        {
          formId: getFormId(text),
          title: form.info?.title || "Google Form",
          fields,
          currentIndex: 0,
          answers: {},
          email: profile.email
        },
        { ex: 3600 }
      );

      return ctx.reply(
        `✅ Form berhasil dibaca!\n\n📋 ${
          form.info?.title || "Google Form"
        }\n👤 ${profile.email}\n📝 ${
          fields.length
        } pertanyaan\n\n${questionText(
          fields[0],
          0,
          fields.length
        )}`
      );
    } catch (err) {
      console.error(err);

      if (err.code === "GOOGLE_LOGIN") {
        const url = await loginUrl(chatId);

        return ctx.reply(
          "❌ Login Google diperlukan.",
          Markup.inlineKeyboard([
            [
              Markup.button.url(
                "🔐 Login Google",
                url
              )
            ]
          ])
        );
      }

      return ctx.reply(
        `❌ Gagal membaca formulir.\n\n${err.message}`
      );
    }
  }

  const session = await redis.get(
    `session:${chatId}`
  );

  if (!session || !text) return;

  const field =
    session.fields[session.currentIndex];

  if (!field) return;

  session.answers[field.questionId] = text;
  session.currentIndex++;

  if (
    session.currentIndex <
    session.fields.length
  ) {
    await redis.set(
      `session:${chatId}`,
      session,
      { ex: 3600 }
    );

    const next =
      session.fields[session.currentIndex];

    return ctx.reply(
      questionText(
        next,
        session.currentIndex,
        session.fields.length
      )
    );
  }

  await redis.del(`session:${chatId}`);

  await ctx.reply(
    `✅ Semua pertanyaan selesai dijawab.\n\n` +
    `📋 ${session.title}\n` +
    `📝 ${session.fields.length} jawaban`
  );
});

module.exports = async (req, res) => {
  try {
    if (
      req.method === "GET" &&
      req.query?.code &&
      req.query?.state
    ) {
      const chatId = await redis.get(
        stateKey(req.query.state)
      );

      if (!chatId) {
        return res.status(400).send(
          "Login expired. Kembali ke Telegram."
        );
      }

      await redis.del(
        stateKey(req.query.state)
      );

      const auth = oauthClient();

      const { tokens } =
        await auth.getToken(req.query.code);

      auth.setCredentials(tokens);

      const profile =
        await getProfile(auth);

      const old =
        await redis.get(tokenKey(chatId));

      await redis.set(
        tokenKey(chatId),
        {
          ...tokens,
          refresh_token:
            tokens.refresh_token ||
            old?.refresh_token,
          email: profile.email,
          name: profile.name
        }
      );

      await bot.telegram.sendMessage(
        chatId,
        `✅ Google berhasil terhubung!\n\n` +
        `👤 ${profile.name || "-"}\n` +
        `📧 ${profile.email || "-"}\n\n` +
        `Sekarang kirim link Google Form.`
      );

      return res.status(200).send(`
        <html>
        <head>
        <meta name="viewport" content="width=device-width">
        <style>
        body{background:#111;color:white;font-family:Arial;text-align:center;padding:60px 20px}
        div{max-width:400px;margin:auto;background:#222;padding:30px;border-radius:20px}
        </style>
        </head>
        <body>
        <div>
        <h1>✅</h1>
        <h2>Google Berhasil Terhubung</h2>
        <p>${escapeHtml(profile.email || "")}</p>
        <p>Kembali ke Telegram.</p>
        </div>
        </body>
        </html>
      `);
    }

    if (req.method === "POST") {
      await bot.handleUpdate(req.body, res);
      return;
    }

    res.status(200).send(
      "Botgogle API berjalan."
    );
  } catch (err) {
    console.error(err);
    res.status(500).send(
      "Server Error"
    );
  }
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}          
