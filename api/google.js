const axios = require("axios");
const { google } = require("googleapis");
const crypto = require("crypto");

const SCOPES = [
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

function getFormUrl(text) {
  const m = String(text).match(
    /https?:\/\/docs\.google\.com\/forms\/[^\s]+/i
  );

  if (!m) return null;

  return m[0].replace(/[)\],.!?]+$/, "");
}

function getFormId(url) {
  try {
    const u = new URL(url);

    const m = u.pathname.match(
      /\/forms\/(?:u\/\d+\/)?d\/(?:e\/)?([^/]+)/
    );

    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function responseUrl(url) {
  const u = new URL(url);

  u.pathname = u.pathname.replace(
    /\/viewform\/?$/,
    "/formResponse"
  );

  if (!u.pathname.endsWith("/formResponse")) {
    u.pathname = u.pathname.replace(/\/?$/, "/formResponse");
  }

  u.search = "";

  return u.toString();
}

function extractPublicData(html) {
  const marker = "FB_PUBLIC_LOAD_DATA_";
  const start = html.indexOf(marker);

  if (start === -1) {
    throw new Error(
      "Data Google Form tidak ditemukan. Pastikan Form bisa dibuka publik."
    );
  }

  const eq = html.indexOf("=", start);

  if (eq === -1) {
    throw new Error("Struktur Google Form tidak terbaca.");
  }

  let i = eq + 1;

  while (/\s/.test(html[i])) i++;

  if (html[i] !== "[") {
    throw new Error("Data Google Form tidak valid.");
  }

  const begin = i;
  let depth = 0;
  let quote = false;
  let escape = false;

  for (; i < html.length; i++) {
    const c = html[i];

    if (quote) {
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        quote = false;
      }
      continue;
    }

    if (c === '"') {
      quote = true;
      continue;
    }

    if (c === "[") depth++;

    if (c === "]") {
      depth--;

      if (depth === 0) {
        return JSON.parse(
          html.slice(begin, i + 1)
        );
      }
    }
  }

  throw new Error("Data Form tidak selesai.");
}

function parseFormData(data) {
  const result = {
    title: "",
    fields: []
  };

  const root =
    Array.isArray(data) && Array.isArray(data[1])
      ? data[1]
      : [];

  result.title =
    typeof root[8] === "string"
      ? root[8]
      : "";

  const items =
    Array.isArray(root[1])
      ? root[1]
      : [];

  for (const item of items) {
    if (!Array.isArray(item)) continue;

    const type = item[3];
    const title =
      typeof item[1] === "string"
        ? item[1]
        : "";

    if (type === 8) continue;

    const subs =
      Array.isArray(item[4])
        ? item[4]
        : [];

    const entryIds = [];
    const options = [];

    for (const sub of subs) {
      if (!Array.isArray(sub)) continue;

      if (
        sub.length &&
        (typeof sub[0] === "number" ||
          typeof sub[0] === "string")
      ) {
        entryIds.push(String(sub[0]));
      }

      if (Array.isArray(sub[1])) {
        for (const option of sub[1]) {
          if (
            Array.isArray(option) &&
            option.length &&
            typeof option[0] === "string"
          ) {
            options.push(option[0]);
          }
        }
      }
    }

    if (!entryIds.length) continue;

    const required =
      subs.some(
        x =>
          Array.isArray(x) &&
          (x[2] === true || x[2] === 1)
      );

    result.fields.push({
      title: title || "Pertanyaan",
      type,
      required,
      entryIds,
      options
    });
  }

  return result;
}

async function readForm(url) {
  const formId = getFormId(url);

  if (!formId) {
    throw new Error(
      "Link Google Form tidak valid."
    );
  }

  const u = new URL(url);

  u.search = "";

  if (u.pathname.endsWith("/viewform")) {
    u.pathname = u.pathname.replace(
      /\/viewform$/,
      "/viewform"
    );
  }

  const { data: html } = await axios.get(
    u.toString(),
    {
      timeout: 20000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml"
      }
    }
  );

  const publicData =
    extractPublicData(html);

  const form =
    parseFormData(publicData);

  form.id = formId;
  form.viewUrl = u.toString();
  form.submitUrl =
    responseUrl(u.toString());

  if (!form.fields.length) {
    throw new Error(
      "Pertanyaan Google Form tidak ditemukan."
    );
  }

  return form;
}

function normalizeAnswer(field, answer) {
  const value = String(answer || "").trim();

  if (!field.options.length) {
    return value;
  }

  if (/^\d+$/.test(value)) {
    const n = Number(value);

    if (n >= 1 && n <= field.options.length) {
      return field.options[n - 1];
    }
  }

  if (field.type === 4) {
    return value
      .split(",")
      .map(x => x.trim())
      .filter(Boolean)
      .map(x => {
        if (/^\d+$/.test(x)) {
          const n = Number(x);

          if (
            n >= 1 &&
            n <= field.options.length
          ) {
            return field.options[n - 1];
          }
        }

        return x;
      });
  }

  return value;
}

async function submitForm(form, answers) {
  const params = new URLSearchParams();

  for (const field of form.fields) {
    const answer =
      answers[field.entryIds[0]];

    if (
      answer === undefined ||
      answer === null ||
      answer === ""
    ) {
      continue;
    }

    const value =
      normalizeAnswer(field, answer);

    if (Array.isArray(value)) {
      for (const v of value) {
        params.append(
          `entry.${field.entryIds[0]}`,
          v
        );
      }
    } else {
      params.append(
        `entry.${field.entryIds[0]}`,
        value
      );
    }
  }

  const response =
    await axios.post(
      form.submitUrl,
      params.toString(),
      {
        timeout: 30000,
        maxRedirects: 5,
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
          "User-Agent":
            "Mozilla/5.0"
        },
        validateStatus: () => true
      }
    );

  if (
    response.status < 200 ||
    response.status >= 400
  ) {
    throw new Error(
      `Google menolak pengiriman (${response.status}).`
    );
  }

  return true;
}

function loginUrl(state) {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state
  });
}

async function exchange(code) {
  const auth = oauthClient();

  const { tokens } =
    await auth.getToken(code);

  auth.setCredentials(tokens);

  const oauth2 = google.oauth2({
    auth,
    version: "v2"
  });

  const { data } =
    await oauth2.userinfo.get();

  return {
    tokens,
    profile: data
  };
}

function createState() {
  return crypto
    .randomBytes(32)
    .toString("hex");
}

module.exports = {
  getFormUrl,
  getFormId,
  readForm,
  submitForm,
  loginUrl,
  exchange,
  createState,
  oauthClient
};
