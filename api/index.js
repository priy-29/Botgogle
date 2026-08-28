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

function getFormId(url) {
  try {
    const u = new URL(url);

    const match = u.pathname.match(
      /\/forms\/(?:u\/\d+\/)?d\/(?:e\/)?([^/]+)/
    );

    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function getCanonicalUrl(url) {
  const id = getFormId(url);

  if (!id) {
    throw new Error("Link Google Form tidak valid.");
  }

  return `https://docs.google.com/forms/d/e/${id}/viewform`;
}

function getSubmitUrl(url) {
  const id = getFormId(url);

  if (!id) {
    throw new Error("Link Google Form tidak valid.");
  }

  return `https://docs.google.com/forms/d/e/${id}/formResponse`;
}

function extractPublicData(html) {
  const marker = "FB_PUBLIC_LOAD_DATA_";
  const start = html.indexOf(marker);

  if (start === -1) {
    throw new Error(
      "Google Form tidak bisa dibaca. Pastikan Form dapat dibuka tanpa login."
    );
  }

  const equal = html.indexOf("=", start);

  if (equal === -1) {
    throw new Error("Struktur Google Form tidak ditemukan.");
  }

  let i = equal + 1;

  while (/\s/.test(html[i])) i++;

  if (html[i] !== "[") {
    throw new Error("Data Google Form tidak valid.");
  }

  const begin = i;
  let depth = 0;
  let quote = false;
  let escape = false;

  for (; i < html.length; i++) {
    const char = html[i];

    if (quote) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        quote = false;
      }

      continue;
    }

    if (char === '"') {
      quote = true;
      continue;
    }

    if (char === "[") depth++;

    if (char === "]") {
      depth--;

      if (depth === 0) {
        return JSON.parse(
          html.slice(begin, i + 1)
        );
      }
    }
  }

  throw new Error(
    "Data Google Form tidak lengkap."
  );
}

function parseFormData(data) {
  const result = {
    title: "",
    fields: []
  };

  const root =
    Array.isArray(data?.[1])
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

    const title =
      typeof item[1] === "string"
        ? item[1]
        : "Pertanyaan";

    const type = item[3];

    const data =
      Array.isArray(item[4])
        ? item[4]
        : [];

    const entryIds = [];
    const options = [];

    for (const row of data) {
      if (!Array.isArray(row)) continue;

      if (
        row[0] !== undefined &&
        (
          typeof row[0] === "number" ||
          typeof row[0] === "string"
        )
      ) {
        const value = String(row[0]);

        if (value.startsWith("entry.")) {
          entryIds.push(
            value.replace("entry.", "")
          );
        } else if (/^\d+$/.test(value)) {
          entryIds.push(value);
        }
      }

      if (Array.isArray(row[1])) {
        for (const opt of row[1]) {
          if (
            Array.isArray(opt) &&
            typeof opt[0] === "string"
          ) {
            options.push(opt[0]);
          }
        }
      }
    }

    const uniqueIds =
      [...new Set(entryIds)];

    if (!uniqueIds.length) continue;

    result.fields.push({
      title,
      type,
      required: false,
      entryIds: uniqueIds,
      options: [...new Set(options)]
    });
  }

  return result;
}

async function readForm(url) {
  const canonical =
    getCanonicalUrl(url);

  const { data: html } =
    await axios.get(
      canonical,
      {
        timeout: 30000,
        maxRedirects: 10,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
          "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language":
            "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
          "Cache-Control":
            "no-cache"
        },
        validateStatus: status =>
          status >= 200 &&
          status < 400
      }
    );

  const data =
    extractPublicData(html);

  const form =
    parseFormData(data);

  if (!form.fields.length) {
    throw new Error(
      "Pertanyaan Form tidak ditemukan."
    );
  }

  form.id =
    getFormId(url);

  form.viewUrl =
    canonical;

  form.submitUrl =
    getSubmitUrl(url);

  return form;
}

function normalizeAnswer(
  field,
  answer
) {
  const value =
    String(answer || "").trim();

  if (!field.options.length) {
    return value;
  }

  if (/^\d+$/.test(value)) {
    const number =
      Number(value);

    if (
      number >= 1 &&
      number <= field.options.length
    ) {
      return field.options[number - 1];
    }
  }

  return value;
}

async function submitForm(
  form,
  answers
) {
  const params =
    new URLSearchParams();

  for (const field of form.fields) {
    const entry =
      field.entryIds[0];

    const answer =
      answers[entry];

    if (
      answer === undefined ||
      answer === null ||
      answer === ""
    ) {
      continue;
    }

    params.append(
      `entry.${entry}`,
      normalizeAnswer(
        field,
        answer
      )
    );
  }

  const response =
    await axios.post(
      form.submitUrl,
      params.toString(),
      {
        timeout: 30000,
        maxRedirects: 10,
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
          "User-Agent":
            "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36"
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
  const auth =
    oauthClient();

  const { tokens } =
    await auth.getToken(code);

  auth.setCredentials(tokens);

  const oauth2 =
    google.oauth2({
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
  getFormId,
  getFormUrl: text => {
    const match =
      String(text).match(
        /https?:\/\/docs\.google\.com\/forms\/[^\s]+/i
      );

    return match
      ? match[0].replace(/[)\],.!?]+$/, "")
      : null;
  },
  readForm,
  submitForm,
  loginUrl,
  exchange,
  createState,
  oauthClient
};
