const {
  Telegraf,
  Markup
} = require("telegraf");

const {
  Redis
} = require("@upstash/redis");

const google = require("./google");

const bot =
  new Telegraf(process.env.BOT_TOKEN);

const redis =
  Redis.fromEnv();

const tokenKey =
  chatId => `google:${chatId}`;

const stateKey =
  state => `oauth:${state}`;

const sessionKey =
  chatId => `session:${chatId}`;

async function login(chatId) {
  const state =
    google.createState();

  await redis.set(
    stateKey(state),
    String(chatId),
    { ex: 600 }
  );

  return google.loginUrl(state);
}

function questionText(
  field,
  index,
  total
) {
  let text =
    `📋 Pertanyaan ${index + 1}/${total}\n\n` +
    field.title;

  if (field.required) {
    text += " *";
  }

  if (field.options.length) {
    text += "\n\nPilihan:";

    field.options.forEach(
      (option, i) => {
        text +=
          `\n${i + 1}. ${option}`;
      }
    );

    if (field.type === 4) {
      text +=
        "\n\nUntuk checkbox, kirim nomor dipisah koma. Contoh: 1,3";
    }
  }

  return text;
}

async function sendQuestion(
  ctx,
  session
) {
  const field =
    session.form.fields[
      session.index
    ];

  return ctx.reply(
    questionText(
      field,
      session.index,
      session.form.fields.length
    )
  );
}

bot.start(async ctx => {
  const account =
    await redis.get(
      tokenKey(ctx.chat.id)
    );

  if (account) {
    return ctx.reply(
      `🤖 Botgogle\n\n` +
      `Google: ✅ Terhubung\n` +
      `👤 ${account.name || "-"}\n` +
      `📧 ${account.email || "-"}\n\n` +
      `Kirim link Google Form.`,
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

  const url =
    await login(ctx.chat.id);

  return ctx.reply(
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

bot.action(
  "google_login",
  async ctx => {
    await ctx.answerCbQuery();

    const url =
      await login(ctx.chat.id);

    await ctx.reply(
      "🔐 Login Google:",
      Markup.inlineKeyboard([
        [
          Markup.button.url(
            "Login dengan Google",
            url
          )
        ]
      ])
    );
  }
);

bot.action(
  "google_logout",
  async ctx => {
    await redis.del(
      tokenKey(ctx.chat.id)
    );

    await redis.del(
      sessionKey(ctx.chat.id)
    );

    await ctx.answerCbQuery(
      "Google diputuskan"
    );

    await ctx.reply(
      "✅ Akun Google sudah diputuskan."
    );
  }
);

bot.command(
  "cancel",
  async ctx => {
    await redis.del(
      sessionKey(ctx.chat.id)
    );

    await ctx.reply(
      "❌ Sesi dibatalkan."
    );
  }
);

bot.on(
  "message",
  async ctx => {
    const text =
      ctx.message.text ||
      ctx.message.caption ||
      "";

    const chatId =
      ctx.chat.id;

    const formUrl =
      google.getFormUrl(text);

    if (formUrl) {
      const account =
        await redis.get(
          tokenKey(chatId)
        );

      if (!account) {
        const url =
          await login(chatId);

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

      await ctx.reply(
        "🔍 Sedang membaca Google Form..."
      );

      try {
        const form =
          await google.readForm(
            formUrl
          );

        const session = {
          form,
          index: 0,
          answers: {}
        };

        await redis.set(
          sessionKey(chatId),
          session,
          { ex: 3600 }
        );

        await ctx.reply(
          `✅ Form berhasil dibaca!\n\n` +
          `📋 ${form.title || "Google Form"}\n` +
          `📝 ${form.fields.length} pertanyaan`
        );

        return sendQuestion(
          ctx,
          session
        );
      } catch (err) {
        console.error(err);

        return ctx.reply(
          `❌ Gagal membaca formulir.\n\n${err.message}`
        );
      }
    }

    const session =
      await redis.get(
        sessionKey(chatId)
      );

    if (
      !session ||
      !text
    ) {
      return;
    }

    const field =
      session.form.fields[
        session.index
      ];

    if (!field) {
      await redis.del(
        sessionKey(chatId)
      );
      return;
    }

    if (
      field.required &&
      !text.trim()
    ) {
      return ctx.reply(
        "❌ Pertanyaan ini wajib diisi."
      );
    }

    session.answers[
      field.entryIds[0]
    ] = text.trim();

    session.index++;

    if (
      session.index <
      session.form.fields.length
    ) {
      await redis.set(
        sessionKey(chatId),
        session,
        { ex: 3600 }
      );

      return sendQuestion(
        ctx,
        session
      );
    }

    await ctx.reply(
      "📤 Mengirim jawaban ke Google Form..."
    );

    try {
      await google.submitForm(
        session.form,
        session.answers
      );

      await redis.del(
        sessionKey(chatId)
      );

      return ctx.reply(
        `✅ Berhasil dikirim!\n\n` +
        `📋 ${session.form.title || "Google Form"}\n` +
        `📝 ${session.form.fields.length} jawaban`
      );
    } catch (err) {
      console.error(err);

      await redis.set(
        sessionKey(chatId),
        session,
        { ex: 3600 }
      );

      return ctx.reply(
        `❌ Gagal mengirim jawaban.\n\n${err.message}`
      );
    }
  }
);

module.exports =
  async (req, res) => {
    try {
      if (
        req.method === "GET" &&
        req.query?.code &&
        req.query?.state
      ) {
        const chatId =
          await redis.get(
            stateKey(
              req.query.state
            )
          );

        if (!chatId) {
          return res
            .status(400)
            .send(
              "Login expired."
            );
        }

        await redis.del(
          stateKey(
            req.query.state
          )
        );

        const result =
          await google.exchange(
            req.query.code
          );

        const old =
          await redis.get(
            tokenKey(chatId)
          );

        await redis.set(
          tokenKey(chatId),
          {
            ...result.tokens,
            refresh_token:
              result.tokens.refresh_token ||
              old?.refresh_token,
            email:
              result.profile.email,
            name:
              result.profile.name
          }
        );

        await bot.telegram.sendMessage(
          chatId,
          `✅ Google berhasil terhubung!\n\n` +
          `👤 ${result.profile.name || "-"}\n` +
          `📧 ${result.profile.email || "-"}\n\n` +
          `Sekarang kirim link Google Form.`
        );

        return res
          .status(200)
          .send(`
<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width">
<title>Botgogle</title>
<style>
body{background:#111;color:#fff;font-family:Arial;text-align:center;padding:60px 20px}
.box{max-width:400px;margin:auto;background:#222;padding:30px;border-radius:20px}
</style>
</head>
<body>
<div class="box">
<h1>✅</h1>
<h2>Google berhasil terhubung</h2>
<p>${escapeHtml(
  result.profile.email || ""
)}</p>
<p>Kembali ke Telegram.</p>
</div>
</body>
</html>
        `);
      }

      if (
        req.method === "POST"
      ) {
        await bot.handleUpdate(
          req.body,
          res
        );
        return;
      }

      return res
        .status(200)
        .send(
          "Botgogle API berjalan."
        );
    } catch (err) {
      console.error(err);

      return res
        .status(500)
        .send(
          "Server Error"
        );
    }
  };

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
        }
