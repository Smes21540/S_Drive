// drive.js — Netlify Function (Node 18+)
// Proxy Google Drive via Service Account : LIST + DOWNLOAD + UPLOAD
// Robuste: CORS OK, OPTIONS, token cache, timeout réseau, retries intelligents, CSV en texte (pas base64).

import { google } from "googleapis";

/* =========================
   CORS
   ========================= */

function allowedOriginsList() {
  const hardcoded = [
    "https://smes21540.github.io",
    "https://smes21540.netlify.app",
    // Dev local si besoin :
    "http://localhost:5173",
    "http://localhost:3000",
  ];

  const extra = (process.env.DOMAINS_ALLOWED || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return Array.from(new Set([...hardcoded, ...extra]));
}

function getAllowOrigin(originHeader) {
  const list = allowedOriginsList();
  const origin = originHeader || "";
  return list.includes(origin) ? origin : (list[0] || "*");
}

function corsHeaders(allowOrigin) {
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "600",
    // optionnel, utile si tu fais du cookies/auth navigateur (sinon laisse commenté)
    // "Access-Control-Allow-Credentials": "true",
  };
}

function withCors({ statusCode = 200, headers = {}, body = "" }, allowOrigin) {
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

/**
 * Retries légers : on évite de transformer une latence en 504 Netlify.
 * - OK pour LIST et UPLOAD (petites réponses)
 * - Très limité pour DOWNLOAD (alt=media)
 */
async function fetchWithRetry(
  url,
  options,
  {
    attempts = 3,
    baseDelayMs = 200,
    timeoutMs = 8000,
    retryStatuses = [429, 500, 502, 503],
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
   Auth: Service Account (avec cache)
   ========================= */

let cachedToken = null;
let cachedTokenExpMs = 0;

async function getAccessTokenFromServiceAccount() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpMs - 30_000) return cachedToken;

  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON manquant");
  const serviceJson = JSON.parse(json);

  const auth = new google.auth.GoogleAuth({
    credentials: serviceJson,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = tokenResponse?.token;

  if (!token) throw new Error("Token Drive vide");

  cachedToken = token;
  // token Google ~ 1h (on prend 55 min par sécurité)
  cachedTokenExpMs = now + 55 * 60 * 1000;

  return cachedToken;
}

/* =========================
   Utils: cache policy
   ========================= */

function computeCacheSeconds(fileName = "") {
  // Petit cache si fichier du jour, plus long sinon
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return fileName.includes(today) ? 60 : 3600;
}

function isProbablyText(contentType = "") {
  const ct = contentType.toLowerCase();
  return (
    ct.includes("text/") ||
    ct.includes("application/json") ||
    ct.includes("application/xml") ||
    ct.includes("application/csv") ||
    ct.includes("application/vnd.ms-excel") ||
    ct.includes("application/octet-stream") // parfois Drive met octet-stream même pour CSV
  );
}

/* =========================
   Handler
   ========================= */

export async function handler(event) {
  const method = event.httpMethod || "GET";
  const originHeader = event.headers?.origin || event.headers?.Origin || "";
  const allowOrigin = getAllowOrigin(originHeader);

  // Préflight
  if (method === "OPTIONS") {
    return withCors(
      {
        statusCode: 204,
        headers: {
          "Cache-Control": "no-store",
        },
        body: "",
      },
      allowOrigin
    );
  }

  // Méthodes supportées
  if (method !== "GET" && method !== "POST") {
    return withCors(
      {
        statusCode: 405,
        headers: { Allow: "GET, POST, OPTIONS" },
        body: "Méthode non autorisée",
      },
      allowOrigin
    );
  }

  // Token
  let token;
  try {
    token = await getAccessTokenFromServiceAccount();
  } catch (e) {
    console.error("Auth Service Account échouée:", e);
    return withCors({ statusCode: 500, body: "Auth Service Account échouée" }, allowOrigin);
  }

  /* =========================
     POST: Upload multipart
     Body attendu JSON:
     { upload:true, parentId, name, content, mimeType? }
     ========================= */
  if (method === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      if (!body.upload || !body.parentId || !body.name || typeof body.content !== "string") {
        return withCors({ statusCode: 400, body: "Paramètres manquants pour upload" }, allowOrigin);
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

      const res = await fetchWithRetry(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body: multipartBody,
      }, {
        attempts: 3,
        timeoutMs: 10000,
        retryStatuses: [429, 500, 502, 503],
      });

      const txt = await res.text().catch(() => "");
      if (!res.ok) {
        console.error("Erreur upload:", res.status, txt);
        return withCors({ statusCode: res.status, body: "Erreur upload Drive" }, allowOrigin);
      }

      let json = {};
      try { json = JSON.parse(txt); } catch { /* ignore */ }

      return withCors(
        {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ success: true, id: json.id }),
        },
        allowOrigin
      );
    } catch (e) {
      console.error("Erreur upload proxy:", e);
      return withCors({ statusCode: 500, body: "Erreur interne upload" }, allowOrigin);
    }
  }

  /* =========================
     GET:
     - list=true&id=<folderId> : liste du dossier
     - sinon: download fichier id=<fileId>&name=<filename>
     ========================= */
  try {
    const qp = event.queryStringParameters || {};
    const id = qp.id;
    const name = qp.name || "";
    const list = String(qp.list || "").toLowerCase() === "true";

    if (!id) {
      return withCors({ statusCode: 400, body: "Missing id parameter" }, allowOrigin);
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

      const res = await fetchWithRetry(url, {
        headers: { Authorization: `Bearer ${token}` },
      }, {
        attempts: 3,
        timeoutMs: 8000,
        retryStatuses: [429, 500, 502, 503],
      });

      const dataText = await res.text().catch(() => "{}");
      if (!res.ok) {
        console.error("Erreur list Drive:", res.status, dataText);
        return withCors({ statusCode: res.status, body: "Erreur Google Drive (list)" }, allowOrigin);
      }

      return withCors(
        {
          statusCode: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=30, must-revalidate",
            "Netlify-CDN-Cache-Control": "public, max-age=30, must-revalidate",
          },
          body: dataText,
        },
        allowOrigin
      );
    }

    // DOWNLOAD fichier
    const cacheSeconds = computeCacheSeconds(name);
    const url =
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?` +
      new URLSearchParams({
        alt: "media",
        supportsAllDrives: "true",
      }).toString();

    // Important: retries très limités sur media (sinon 504 Netlify)
    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${token}` },
    }, {
      attempts: 2,
      timeoutMs: 10000,
      retryStatuses: [429, 500, 502, 503], // PAS 504 ici
    });

    if (!res.ok) {
      const errTxt = await res.text().catch(() => "");
      console.error("Erreur Drive GET(media):", res.status, errTxt);
      return withCors({ statusCode: res.status, body: "Erreur Google Drive (download)" }, allowOrigin);
    }

    const contentType = res.headers.get("content-type") || "application/octet-stream";

    // Si c’est du CSV/texte -> on renvoie du texte (beaucoup + stable que base64)
    if (isProbablyText(contentType) || name.toLowerCase().endsWith(".csv")) {
      const text = await res.text();

      // Force CSV si on sait que c’est un csv
      const forcedType = name.toLowerCase().endsWith(".csv")
        ? "text/csv; charset=utf-8"
        : contentType;

      return withCors(
        {
          statusCode: 200,
          headers: {
            "Content-Type": forcedType,
            "Cache-Control": `public, max-age=${cacheSeconds}, must-revalidate`,
            "Netlify-CDN-Cache-Control": `public, max-age=${cacheSeconds}, must-revalidate`,
          },
          body: text,
        },
        allowOrigin
      );
    }

    // Sinon binaire -> base64 (Netlify format)
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
    console.error("Erreur proxy Drive (GET):", e);
    return withCors({ statusCode: 500, body: "Erreur interne proxy Drive" }, allowOrigin);
  }
}
