// netlify/functions/drive.js (Node 18+)
// Proxy Google Drive via Service Account (LIST / DOWNLOAD / UPLOAD)
// Objectif: stabilité (timeouts/retry) + CORS stable + token cache
// CSV/text: décodage SMART (UTF-8 si OK sinon fallback windows-1252) + renvoi UTF-8
//
// Vars Netlify:
// - GOOGLE_SERVICE_ACCOUNT_JSON (JSON complet service account)
// - (optionnel) DOMAINS_ALLOWED (CSV d'origines supplémentaires)

import { google } from "googleapis";

/* =========================
   CORS
   ========================= */

function getAllowedOrigins() {
  const hardcoded = [
    "https://smes21540.github.io",
    "https://smes21540.netlify.app",
    "http://localhost:5173",
    "http://localhost:3000",
  ];

  const extra = (process.env.DOMAINS_ALLOWED || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return Array.from(new Set([...hardcoded, ...extra]));
}

function pickAllowOrigin(originHeader) {
  const list = getAllowedOrigins();
  const origin = originHeader || "";
  return list.includes(origin) ? origin : (list[0] || "*");
}

function corsHeaders(allowOrigin) {
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "600",
  };
}

function respond(allowOrigin, { statusCode = 200, headers = {}, body = "" }) {
  return {
    statusCode,
    headers: {
      ...corsHeaders(allowOrigin),
      ...headers,
    },
    body,
  };
}

/* =========================
   Fetch: timeout + retry
   ========================= */

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchWithRetry(
  url,
  options,
  {
    attempts = 3,
    timeoutMs = 8000,
    baseDelayMs = 200,
    retryStatuses = [429, 500, 502, 503], // pas 504 sinon ça empile
  } = {}
) {
  let lastErr;
  let res;

  for (let i = 0; i < attempts; i++) {
    try {
      res = await fetchWithTimeout(url, options, timeoutMs);
      if (res.ok) return res;
      if (!retryStatuses.includes(res.status)) return res;
    } catch (e) {
      lastErr = e;
    }

    const jitter = Math.random() * 100;
    await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i + jitter));
  }

  if (!res) throw lastErr || new Error("fetchWithRetry: unknown error");
  return res;
}

/* =========================
   Auth: Service Account (token cache)
   ========================= */

let cachedToken = null;
let cachedTokenExpMs = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpMs - 30_000) return cachedToken;

  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON manquant");
  const creds = JSON.parse(json);

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  const client = await auth.getClient();
  const tokenResp = await client.getAccessToken();
  const token = tokenResp?.token;
  if (!token) throw new Error("Token Drive vide");

  cachedToken = token;
  cachedTokenExpMs = now + 55 * 60 * 1000; // ~55 min
  return cachedToken;
}

/* =========================
   Helpers: cache + text/csv decode
   ========================= */

function computeCacheSeconds(fileName = "") {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return fileName.includes(today) ? 60 : 3600;
}

function isAbortError(e) {
  return e?.name === "AbortError" || String(e).includes("AbortError");
}

function isCsvOrText(contentType = "", name = "") {
  const ct = (contentType || "").toLowerCase();
  const n = (name || "").toLowerCase();
  return (
    n.endsWith(".csv") ||
    ct.startsWith("text/") ||
    ct.includes("csv") ||
    ct.includes("json") ||
    ct.includes("xml")
  );
}

// Décodage SMART:
// - BOM UTF-8 -> UTF-8
// - sinon: tente UTF-8, si présence de caractère de remplacement (�) -> fallback windows-1252
function decodeTextSmart(arrayBuf) {
  const u8 = new Uint8Array(arrayBuf);

  // BOM UTF-8
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(u8);
  }

  const utf8 = new TextDecoder("utf-8").decode(u8);
  const bad = (utf8.match(/\uFFFD/g) || []).length;

  // Sur tes historiques, si ça apparaît, c'est quasi toujours du win-1252
  if (bad >= 1) {
    return new TextDecoder("windows-1252").decode(u8);
  }

  return utf8;
}

// Correction optionnelle "marteau" si un mojibake traîne encore
function fixMojibakeFr(text) {
  return text
    // unités / symboles
    .replace(/Â°C/g, "°C")
    .replace(/Â°/g, "°")

    // "à" mal encodé (souvent avec double espace)
    .replace(/Ã\s\s+/g, "à ")

    // ponctuation typographique
    .replace(/â€™/g, "’")
    .replace(/â€˜/g, "‘")
    .replace(/â€œ/g, "“")
    .replace(/â€/g, "”")
    .replace(/â€ž/g, "„")
    .replace(/â€“/g, "–")
    .replace(/â€”/g, "—")
    .replace(/â€¦/g, "…")
    .replace(/â€¢/g, "•")

    // accents FR (min)
    .replace(/Ã©/g, "é")
    .replace(/Ã¨/g, "è")
    .replace(/Ãª/g, "ê")
    .replace(/Ã«/g, "ë")
    .replace(/Ã§/g, "ç")
    .replace(/Ã®/g, "î")
    .replace(/Ã¯/g, "ï")
    .replace(/Ã´/g, "ô")
    .replace(/Ã¹/g, "ù")
    .replace(/Ã»/g, "û")
    .replace(/Ã¼/g, "ü")

    // majuscules utiles
    .replace(/Ã€/g, "À")
    .replace(/Ã‰/g, "É")
    .replace(/Ãˆ/g, "È")
    .replace(/ÃŠ/g, "Ê")
    .replace(/Ã‡/g, "Ç")

    // nettoyage final des Â restants
    .replace(/Â/g, "");
}

/* =========================
   Handler
   ========================= */

export async function handler(event) {
  const method = event.httpMethod || "GET";
  const originHeader = event.headers?.origin || event.headers?.Origin || "";
  const allowOrigin = pickAllowOrigin(originHeader);

  // Préflight
  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: { ...corsHeaders(allowOrigin), "Cache-Control": "no-store" },
      body: "",
    };
  }

  if (method !== "GET" && method !== "POST") {
    return respond(allowOrigin, {
      statusCode: 405,
      headers: { Allow: "GET, POST, OPTIONS" },
      body: "Méthode non autorisée",
    });
  }

  // Token
  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    console.error("Auth Service Account échouée:", e);
    return respond(allowOrigin, { statusCode: 500, body: "Auth Service Account échouée" });
  }

  /* =========================
     POST upload
     Body JSON:
     { upload:true, parentId, name, content, mimeType? }
     ========================= */
  if (method === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      if (!body.upload || !body.parentId || !body.name || typeof body.content !== "string") {
        return respond(allowOrigin, { statusCode: 400, body: "Paramètres manquants pour upload" });
      }

      const metadata = {
        name: body.name,
        parents: [body.parentId],
        mimeType: body.mimeType || "text/plain",
      };

      const boundary = "-------smesuploadboundary" + Date.now();
      const multipartBody =
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify(metadata) +
        `\r\n--${boundary}\r\n` +
        `Content-Type: ${metadata.mimeType}\r\n\r\n` +
        body.content +
        `\r\n--${boundary}--`;

      const uploadUrl =
        "https://www.googleapis.com/upload/drive/v3/files?" +
        new URLSearchParams({
          uploadType: "multipart",
          supportsAllDrives: "true",
        }).toString();

      const res = await fetchWithRetry(
        uploadUrl,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": `multipart/related; boundary=${boundary}`,
          },
          body: multipartBody,
        },
        { attempts: 3, timeoutMs: 15000 }
      );

      const txt = await res.text().catch(() => "");
      if (!res.ok) {
        console.error("Erreur upload:", res.status, txt);
        return respond(allowOrigin, { statusCode: res.status, body: "Erreur upload Drive" });
      }

      let out = {};
      try {
        out = JSON.parse(txt);
      } catch {
        /* ignore */
      }

      return respond(allowOrigin, {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ success: true, id: out.id }),
      });
    } catch (e) {
      console.error("Erreur upload proxy:", e);
      return respond(allowOrigin, { statusCode: 500, body: "Erreur interne upload" });
    }
  }

  /* =========================
     GET list / download
     ========================= */
  try {
    const qp = event.queryStringParameters || {};
    const id = qp.id;
    const name = qp.name || "";
    const list = String(qp.list || "").toLowerCase() === "true";

    if (!id) {
      return respond(allowOrigin, { statusCode: 400, body: "Missing id parameter" });
    }

    // LIST dossier
    if (list) {
      const q = `'${id}' in parents and trashed=false`;
      const url =
        "https://www.googleapis.com/drive/v3/files?" +
        new URLSearchParams({
          q,
          fields: "files(id,name,mimeType,size,createdTime,modifiedTime)",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
          pageSize: "1000",
        }).toString();

      const res = await fetchWithRetry(
        url,
        { headers: { Authorization: `Bearer ${token}` } },
        { attempts: 3, timeoutMs: 8000 }
      );

      const txt = await res.text().catch(() => "{}");
      if (!res.ok) {
        console.error("Erreur list Drive:", res.status, txt);
        return respond(allowOrigin, { statusCode: res.status, body: "Erreur Google Drive (list)" });
      }

      return respond(allowOrigin, {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=30, must-revalidate",
          "Netlify-CDN-Cache-Control": "public, max-age=30, must-revalidate",
        },
        body: txt,
      });
    }

    // DOWNLOAD fichier
    const cacheSeconds = computeCacheSeconds(name);
    const url =
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?` +
      new URLSearchParams({ alt: "media", supportsAllDrives: "true" }).toString();

    const res = await fetchWithRetry(
      url,
      { headers: { Authorization: `Bearer ${token}` } },
      {
        attempts: 2,
        timeoutMs: 30000,
        retryStatuses: [429, 500, 502, 503],
      }
    );

    if (!res.ok) {
      const errTxt = await res.text().catch(() => "");
      console.error("Erreur Drive GET(media):", res.status, errTxt);
      return respond(allowOrigin, { statusCode: res.status, body: "Erreur Google Drive (download)" });
    }

    const contentType = res.headers.get("content-type") || "application/octet-stream";

    // CSV/texte => decode smart + (option) fix mojibake, renvoi UTF-8
    if (isCsvOrText(contentType, name)) {
      const arrayBuf = await res.arrayBuffer();

      let text = decodeTextSmart(arrayBuf);

      // Si malgré tout un mojibake traîne, on corrige (ne change rien si déjà OK)
      if (/[ÃÂ]|â€™|â€œ|â€|â€“|â€”|â€¦/.test(text)) {
        text = fixMojibakeFr(text);
      }

      const forcedType = name.toLowerCase().endsWith(".csv")
        ? "text/csv; charset=utf-8"
        : (contentType.includes("charset") ? contentType : `${contentType}; charset=utf-8`);

      return respond(allowOrigin, {
        statusCode: 200,
        headers: {
          "Content-Type": forcedType,
          "Cache-Control": `public, max-age=${cacheSeconds}, must-revalidate`,
          "Netlify-CDN-Cache-Control": `public, max-age=${cacheSeconds}, must-revalidate`,
        },
        body: text,
      });
    }

    // Binaire -> base64
    const arrayBuf = await res.arrayBuffer();
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders(allowOrigin),
        "Content-Type": contentType,
        "Cache-Control": `public, max-age=${cacheSeconds}, must-revalidate`,
        "Netlify-CDN-Cache-Control": `public, max-age=${cacheSeconds}, must-revalidate`,
      },
      body: Buffer.from(arrayBuf).toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) {
    if (isAbortError(e)) {
      console.error("Timeout Drive (AbortError):", e);
      return respond(allowOrigin, {
        statusCode: 504,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Timeout Google Drive (download trop lent)" }),
      });
    }

    console.error("Erreur proxy Drive (GET):", e);
    return respond(allowOrigin, { statusCode: 500, body: "Erreur interne proxy Drive" });
  }
}
