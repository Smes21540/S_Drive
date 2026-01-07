// netlify/functions/drive.js (Node 18+)
// Proxy Google Drive via Service Account (LIST / DOWNLOAD / UPLOAD)
// Objectif: stabilité (timeouts/retry) + CORS stable + token cache
// Texte/CSV: détection encodage (BOM + test UTF-8) puis fallback windows-1252 => renvoi UTF-8
// CSV: ajoute un BOM UTF-8 pour Excel (optionnel mais fortement recommandé)
//
// Dépendance:
//   npm i iconv-lite
//
// Vars Netlify:
// - GOOGLE_SERVICE_ACCOUNT_JSON (JSON complet service account)
// - (optionnel) DOMAINS_ALLOWED (CSV d'origines supplémentaires)

import { google } from "googleapis";
import iconv from "iconv-lite";

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

function isAbortError(e) {
  return e?.name === "AbortError" || String(e).includes("AbortError");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
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
    timeoutMs = 12000,
    baseDelayMs = 250,
    retryStatuses = [429, 500, 502, 503, 504],
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

    const jitter = Math.random() * 120;
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
   Helpers: cache + text/csv
   ========================= */

function computeCacheSeconds(fileName = "") {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return fileName.includes(today) ? 60 : 3600;
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

// Détection & décodage robuste:
// - UTF-8 BOM => utf8
// - UTF-16 BOM => utf16le / utf16be
// - sinon: tente UTF-8, si U+FFFD -> fallback win1252 (ton cas typique)
function decodeTextSmart(arrayBuf) {
  const buf = Buffer.from(arrayBuf);

  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString("utf8");
  }

  // UTF-16 LE BOM
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return iconv.decode(buf.slice(2), "utf16-le");
  }

  // UTF-16 BE BOM
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return iconv.decode(buf.slice(2), "utf16-be");
  }

  const utf8 = buf.toString("utf8");
  if (utf8.includes("\uFFFD")) {
    return iconv.decode(buf, "win1252"); // windows-1252
  }
  return utf8;
}

function ensureCharsetUtf8(contentType = "", name = "") {
  const n = (name || "").toLowerCase();
  if (n.endsWith(".csv")) return "text/csv; charset=utf-8";
  const ct = contentType || "text/plain";
  return ct.toLowerCase().includes("charset=") ? ct : `${ct}; charset=utf-8`;
}

// Excel aime le BOM UTF-8 sur les CSV
function shouldAddBom(name = "", contentType = "") {
  const n = (name || "").toLowerCase();
  const ct = (contentType || "").toLowerCase();
  return n.endsWith(".csv") || ct.includes("csv");
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
     Notes:
       - content doit être une string UTF-8 (côté front, lis correctement le fichier)
       - on force charset=utf-8 sur la partie "fichier" si c'est du texte
     ========================= */
  if (method === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      if (!body.upload || !body.parentId || !body.name || typeof body.content !== "string") {
        return respond(allowOrigin, { statusCode: 400, body: "Paramètres manquants pour upload" });
      }

      const name = String(body.name);
      const baseMime =
        body.mimeType ||
        (name.toLowerCase().endsWith(".csv") ? "text/csv" : "text/plain");

      // Pour la partie fichier (multipart), ajoute charset=utf-8 si texte
      const filePartMime =
        baseMime.toLowerCase().startsWith("text/") && !baseMime.toLowerCase().includes("charset=")
          ? `${baseMime}; charset=utf-8`
          : baseMime;

      const metadata = {
        name,
        parents: [body.parentId],
        mimeType: baseMime, // mimeType Drive (sans charset), ok
      };

      const boundary = "-------smesuploadboundary" + Date.now();
      const multipartBody =
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify(metadata) +
        `\r\n--${boundary}\r\n` +
        `Content-Type: ${filePartMime}\r\n\r\n` +
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
        { attempts: 3, timeoutMs: 20000 }
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
     Query:
       - id=... (obligatoire)
       - list=true pour lister un dossier
       - name=... (optionnel, pour cache & heuristiques)
     ========================= */
  try {
    const qp = event.queryStringParameters || {};
    const id = qp.id;
    const name = qp.name || "";
    const list = String(qp.list || "").toLowerCase() === "true";

    if (!id) return respond(allowOrigin, { statusCode: 400, body: "Missing id parameter" });

    // LIST dossier (pagination) => évite 500/timeout si énormément de fichiers
    if (list) {
      const pageSize = 1000;
      const maxPages = 25; // garde-fou
      const q = `'${id}' in parents and trashed=false`;

      let files = [];
      let pageToken = undefined;

      for (let i = 0; i < maxPages; i++) {
        const url =
          "https://www.googleapis.com/drive/v3/files?" +
          new URLSearchParams({
            q,
            fields: "nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime)",
            supportsAllDrives: "true",
            includeItemsFromAllDrives: "true",
            pageSize: String(pageSize),
            ...(pageToken ? { pageToken } : {}),
          }).toString();

        const res = await fetchWithRetry(
          url,
          { headers: { Authorization: `Bearer ${token}` } },
          { attempts: 3, timeoutMs: 12000 }
        );

        const txt = await res.text().catch(() => "{}");
        if (!res.ok) {
          console.error("Erreur list Drive:", res.status, txt);
          return respond(allowOrigin, { statusCode: res.status, body: "Erreur Google Drive (list)" });
        }

        const data = JSON.parse(txt);
        files.push(...(data.files || []));
        pageToken = data.nextPageToken;
        if (!pageToken) break;
      }

      return respond(allowOrigin, {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=30, must-revalidate",
          "Netlify-CDN-Cache-Control": "public, max-age=30, must-revalidate",
        },
        body: JSON.stringify({ files }),
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
      { attempts: 3, timeoutMs: 30000, retryStatuses: [429, 500, 502, 503, 504] }
    );

    if (!res.ok) {
      const errTxt = await res.text().catch(() => "");
      console.error("Erreur Drive GET(media):", res.status, errTxt);
      return respond(allowOrigin, { statusCode: res.status, body: "Erreur Google Drive (download)" });
    }

    const contentType = res.headers.get("content-type") || "application/octet-stream";

    // CSV/texte => decode smart, renvoi UTF-8 (BOM CSV)
    if (isCsvOrText(contentType, name)) {
      const arrayBuf = await res.arrayBuffer();
      let text = decodeTextSmart(arrayBuf);

      // BOM UTF-8 pour Excel sur CSV
      if (shouldAddBom(name, contentType)) {
        const bom = "\uFEFF";
        if (!text.startsWith(bom)) text = bom + text;
      }

      return respond(allowOrigin, {
        statusCode: 200,
        headers: {
          "Content-Type": ensureCharsetUtf8(contentType, name),
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
        body: JSON.stringify({ error: "Timeout Google Drive" }),
      });
    }

    console.error("Erreur proxy Drive (GET):", e);
    return respond(allowOrigin, { statusCode: 500, body: "Erreur interne proxy Drive" });
  }
}
