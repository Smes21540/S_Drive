// drive.js — Netlify Function (Node 18+)
// Lecture & upload Google Drive via Service Account, CORS stable, stateless, retries.
// Vars requises côté Netlify: GOOGLE_SERVICE_ACCOUNT_JSON (JSON complet) et facultatif: DOMAINS_ALLOWED (CSV)

import { google } from "googleapis";

/* =========================
   Utils: CORS & Retry
   ========================= */

function parseAllowedOrigins(originHeader) {
  // 1) Origines codées en dur (mets tes domaines ici)
  const hardcoded = [
    "https://smes21540.github.io",
    "https://smes21540.netlify.app",
    // Ajoute tes domaines personnalisés ci-dessous :
    "https://app.tondomaine.fr",
    "https://www.tondomaine.fr",
    // Dev local si besoin :
    "http://localhost:5173",
    "http://localhost:3000",
  ];

  // 2) Origines supplémentaires via variable d'env DOMAINS_ALLOWED (CSV)
  const extra = (process.env.DOMAINS_ALLOWED || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const list = Array.from(new Set([...hardcoded, ...extra]));
  const origin = originHeader || "";
  // Si l'origine de la requête est dans la liste, on la renvoie ; sinon on renvoie le premier domaine autorisé
  const allowOrigin = list.includes(origin) ? origin : (list[0] || "*");
  return allowOrigin;
}

function corsResponse({ statusCode = 200, body = "", headers = {} }, allowOrigin) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
      "Access-Control-Max-Age": "600", // 10 min: préflight cache côté navigateur
      ...headers,
    },
    body
  };
}

async function fetchWithRetry(url, options, { attempts = 4, baseDelayMs = 250 } = {}) {
  let lastErr, res;
  for (let i = 0; i < attempts; i++) {
    try {
      res = await fetch(url, options);
      // Retry sur 429 et 5xx
      if (res.ok || ![429, 500, 502, 503, 504].includes(res.status)) return res;
    } catch (e) {
      lastErr = e;
    }
    const jitter = Math.random() * 100;
    await new Promise(r => setTimeout(r, baseDelayMs * 2 ** i + jitter));
  }
  if (!res) throw lastErr || new Error("fetchWithRetry: unknown error");
  return res;
}

/* =========================
   Auth: Service Account
   ========================= */

async function getAccessTokenFromServiceAccount() {
  try {
    const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!json) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON manquant");
    const serviceJson = JSON.parse(json);

    const auth = new google.auth.GoogleAuth({
      credentials: serviceJson,
      scopes: ["https://www.googleapis.com/auth/drive"]
    });

    const client = await auth.getClient();
    const token = await client.getAccessToken();
    return token.token;
  } catch (err) {
    console.error("Erreur génération token service account:", err);
    return null;
  }
}

/* =========================
   Handler Netlify
   ========================= */

export async function handler(event, context) {
  const method = event.httpMethod || "GET";
  const originHeader = event.headers?.origin || event.headers?.Origin || "";
  const allowOrigin = parseAllowedOrigins(originHeader);

  // Préflight CORS
  if (method === "OPTIONS") {
    return corsResponse({
      statusCode: 200,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
      }
    }, allowOrigin);
  }

  // Upload (POST)
  if (method === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      if (!body.upload || !body.parentId || !body.name || !body.content) {
        return corsResponse({ statusCode: 400, body: "Paramètres manquants pour upload" }, allowOrigin);
      }

      const token = await getAccessTokenFromServiceAccount();
      if (!token) {
        return corsResponse({ statusCode: 500, body: "Impossible de générer un token Drive" }, allowOrigin);
      }

      const metadata = {
        name: body.name,
        parents: [body.parentId],
        mimeType: body.mimeType || "text/plain"
      };

      const boundary = "-------smesuploadboundary" + Date.now();
      const multipartBody =
        `--${boundary}\r\n` +
        "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
        JSON.stringify(metadata) + "\r\n" +
        `--${boundary}\r\n` +
        `Content-Type: ${metadata.mimeType}\r\n\r\n` +
        body.content + "\r\n" +
        `--${boundary}--`;

      const uploadUrl = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true";

      const res = await fetchWithRetry(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`
        },
        body: multipartBody
      });

      if (!res.ok) {
        const errTxt = await res.text().catch(() => "");
        console.error("Erreur upload:", res.status, errTxt);
        return corsResponse({ statusCode: res.status, body: "Erreur upload Drive" }, allowOrigin);
      }

      const result = await res.json();
      return corsResponse({
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          // Active aussi le cache CDN Netlify (lecture utile seulement ; ici upload → pas de cache)
        },
        body: JSON.stringify({ success: true, id: result.id })
      }, allowOrigin);

    } catch (err) {
      console.error("Erreur upload proxy:", err);
      return corsResponse({ statusCode: 500, body: "Erreur interne upload" }, allowOrigin);
    }
  }

  // Lecture (GET): list=bool pour lister un dossier ; sinon téléchargement d'un fichier
  if (method === "GET") {
    try {
const qp = event.queryStringParameters || {};
const id = qp.id;
const name = qp.name || "";
const list = String(qp.list || "").toLowerCase() === "true";

// ✅ force download si &download=1 (ou true/yes)
const download = ["1", "true", "yes"].includes(String(qp.download || "").toLowerCase());



      if (!id) {
        return corsResponse({ statusCode: 400, body: "Missing id parameter" }, allowOrigin);
      }

      const token = await getAccessTokenFromServiceAccount();
      if (!token) {
        return corsResponse({ statusCode: 500, body: "Auth Service Account échouée" }, allowOrigin);
      }

if (list) {
  // Liste paginée des fichiers d'un dossier (évite la "limite" 100/1000)
  let allFiles = [];
  let pageToken = undefined;

  do {
    const params = new URLSearchParams();
    // ⚠️ ne pas encodeURIComponent(id) à l'intérieur de q
    params.set("q", `'${id}' in parents and trashed=false`);
params.set(
  "fields",
  "nextPageToken, files(id,name,mimeType,size,createdTime,modifiedTime,shortcutDetails(targetId,targetMimeType))"
);


    params.set("pageSize", "1000");
    params.set("supportsAllDrives", "true");
    params.set("includeItemsFromAllDrives", "true");
    if (pageToken) params.set("pageToken", pageToken);

    const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;

    const response = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!response.ok) {
      const errTxt = await response.text().catch(() => "");
      console.error("Erreur list Drive:", response.status, errTxt);
      return corsResponse({ statusCode: response.status, body: "Erreur list Drive" }, allowOrigin);
    }

    const data = await response.json().catch(() => ({}));
    allFiles.push(...(data.files || []));
    pageToken = data.nextPageToken;

  } while (pageToken);

  return corsResponse({
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, max-age=30, must-revalidate",
    },
    body: JSON.stringify({ files: allFiles })
  }, allowOrigin);
}


      // Téléchargement d'un fichier
      const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`;
      const response = await fetchWithRetry(url, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!response.ok) {
        const errTxt = await response.text().catch(() => "");
        console.error("Erreur Google Drive GET:", response.status, errTxt);
        return corsResponse({ statusCode: response.status, body: "Erreur Google Drive" }, allowOrigin);
      }

      const arrayBuf = await response.arrayBuffer();
      const contentType = response.headers.get("content-type") || "application/octet-stream";

      // Cache court pour les fichiers "du jour"
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const isTodayFile = name.includes(today);
      const cacheSeconds = isTodayFile ? 60 : 3600;

// ✅ helpers filename safe + RFC5987
const safeName = (name || "fichier")
  .replace(/[\/\\:*?"<>|]/g, "_")
  .replace(/"/g, "'")
  .trim() || "fichier";

const encodedName = encodeURIComponent(safeName);

// ✅ Content-Disposition si on veut forcer le download
const contentDisposition = download
  ? `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`
  : `inline; filename="${safeName}"; filename*=UTF-8''${encodedName}`;

// Binaire encodé en Base64 (format Netlify)
return {
  statusCode: 200,
  headers: {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "600",
    "Content-Type": contentType,

    // ✅ le truc qui change tout
    "Content-Disposition": contentDisposition,

    // optionnel mais pratique
    "Content-Length": String(arrayBuf.byteLength),

    "Cache-Control": `public, max-age=${cacheSeconds}, must-revalidate`,
    "Netlify-CDN-Cache-Control": `public, max-age=${cacheSeconds}, must-revalidate`,
  },
  body: Buffer.from(arrayBuf).toString("base64"),
  isBase64Encoded: true
};

    } catch (err) {
      console.error("Erreur proxy Drive (GET):", err);
      return corsResponse({ statusCode: 500, body: "Erreur interne proxy Drive" }, allowOrigin);
    }
  }

  // Méthodes non supportées
  return corsResponse({
    statusCode: 405,
    headers: { "Allow": "GET, POST, OPTIONS" },
    body: "Méthode non autorisée"
  }, allowOrigin);
}
