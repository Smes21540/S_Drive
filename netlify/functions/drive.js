// drive.js — Netlify Function (Node 18+)
// Proxy Google Drive via Service Account + Auth JWT (login), CORS stable, retries.
// Vars Netlify requises :
// - GOOGLE_SERVICE_ACCOUNT_JSON (JSON complet Service Account)
// - JWT_SECRET (string aléatoire, 32+ chars)
// - TENANTS_USERS_JSON (JSON: { "TENANT": { "user":"pass", ... }, ... })
// Optionnel : DOMAINS_ALLOWED (CSV d'origines autorisées)
//
// Endpoints :
// - POST { action:"login", tenant, login, password }  -> { token }
// - GET  ?list=true&id=<folderId>                     -> liste fichiers
// - GET  ?id=<fileId>&name=<filename>                 -> download (base64 Netlify)
// - POST { upload:true, parentId, name, content, mimeType? } -> upload
//
// Côté front : ajoute Authorization: Bearer <token> sur tous les GET/POST (hors login).

import { google } from "googleapis";
import jwt from "jsonwebtoken";

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
    .map((s) => s.trim())
    .filter(Boolean);

  const list = Array.from(new Set([...hardcoded, ...extra]));
  const origin = originHeader || "";
  // Si l'origine de la requête est dans la liste, on la renvoie ; sinon on renvoie le premier domaine autorisé
  const allowOrigin = list.includes(origin) ? origin : list[0] || "*";
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
    body,
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
    await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i + jitter));
  }
  if (!res) throw lastErr || new Error("fetchWithRetry: unknown error");
  return res;
}

/* =========================
   Auth App: Login + JWT
   ========================= */

function getAuthConfig() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET manquant");

  const raw = process.env.TENANTS_USERS_JSON || "{}";
  let tenants = {};
  try {
    tenants = JSON.parse(raw);
  } catch {
    throw new Error("TENANTS_USERS_JSON invalide (JSON mal formé)");
  }
  return { secret, tenants };
}

function makeToken(payload) {
  const { secret } = getAuthConfig();
  // token court = sécurité + pratique
  return jwt.sign(payload, secret, { expiresIn: "12h" });
}

function verifyTokenFromHeader(event) {
  const h = event.headers?.authorization || event.headers?.Authorization || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  try {
    const { secret } = getAuthConfig();
    return jwt.verify(token, secret); // retourne payload
  } catch {
    return null;
  }
}

/* =========================
   Auth: Service Account -> Access Token Drive
   ========================= */

async function getAccessTokenFromServiceAccount() {
  try {
    const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!json) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON manquant");
    const serviceJson = JSON.parse(json);

    const auth = new google.auth.GoogleAuth({
      credentials: serviceJson,
      scopes: ["https://www.googleapis.com/auth/drive"],
    });

    const client = await auth.getClient();
    const token = await client.getAccessToken();
    return token?.token || null;
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
    return corsResponse(
      {
        statusCode: 200,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        },
      },
      allowOrigin
    );
  }

  // POST: login OU upload
  if (method === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");

      // ✅ 1) LOGIN (appelé par ton index)
      if (body.action === "login") {
        const tenant = String(body.tenant || "").trim();
        const login = String(body.login || "").trim();
        const password = String(body.password || "");

        if (!tenant || !login || !password) {
          return corsResponse({ statusCode: 400, body: "Champs login manquants" }, allowOrigin);
        }

        let cfg;
        try {
          cfg = getAuthConfig();
        } catch (e) {
          console.error("Config auth invalide:", e);
          return corsResponse({ statusCode: 500, body: "Config auth invalide" }, allowOrigin);
        }

        const users = cfg.tenants?.[tenant];
        if (!users || !users[login] || users[login] !== password) {
          return corsResponse({ statusCode: 401, body: "Connexion refusée" }, allowOrigin);
        }

        const token = makeToken({ tenant, login });
        return corsResponse(
          {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
          },
          allowOrigin
        );
      }

      // ✅ 2) Upload protégé (Bearer obligatoire)
      const auth = verifyTokenFromHeader(event);
      if (!auth) {
        return corsResponse({ statusCode: 401, body: "Unauthorized" }, allowOrigin);
      }

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
        mimeType: body.mimeType || "text/plain",
      };

      const boundary = "-------smesuploadboundary" + Date.now();
      const multipartBody =
        `--${boundary}\r\n` +
        "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
        JSON.stringify(metadata) +
        "\r\n" +
        `--${boundary}\r\n` +
        `Content-Type: ${metadata.mimeType}\r\n\r\n` +
        body.content +
        "\r\n" +
        `--${boundary}--`;

      const uploadUrl =
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true";

      const res = await fetchWithRetry(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body: multipartBody,
      });

      if (!res.ok) {
        const errTxt = await res.text().catch(() => "");
        console.error("Erreur upload:", res.status, errTxt);
        return corsResponse({ statusCode: res.status, body: "Erreur upload Drive" }, allowOrigin);
      }

      const result = await res.json();
      return corsResponse(
        {
          statusCode: 200,
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ success: true, id: result.id }),
        },
        allowOrigin
      );
    } catch (err) {
      console.error("Erreur POST proxy:", err);
      return corsResponse({ statusCode: 500, body: "Erreur interne POST" }, allowOrigin);
    }
  }

  // GET: list folder OU download file (Bearer obligatoire)
  if (method === "GET") {
    try {
      const auth = verifyTokenFromHeader(event);
      if (!auth) {
        return corsResponse({ statusCode: 401, body: "Unauthorized" }, allowOrigin);
      }

      const qp = event.queryStringParameters || {};
      const id = qp.id;
      const name = qp.name || "";
      const list = String(qp.list || "").toLowerCase() === "true";

      if (!id) {
        return corsResponse({ statusCode: 400, body: "Missing id parameter" }, allowOrigin);
      }

      const token = await getAccessTokenFromServiceAccount();
      if (!token) {
        return corsResponse({ statusCode: 500, body: "Auth Service Account échouée" }, allowOrigin);
      }

      if (list) {
        // Liste des fichiers d'un dossier
        const q = `'${id}' in parents and trashed=false`;
        const url =
          `https://www.googleapis.com/drive/v3/files` +
          `?q=${encodeURIComponent(q)}` +
          `&fields=${encodeURIComponent("files(id,name,mimeType,size,createdTime,modifiedTime,parents)")}` +
          `&supportsAllDrives=true&includeItemsFromAllDrives=true`;

        const response = await fetchWithRetry(url, {
          headers: { Authorization: `Bearer ${token}` },
        });

        const data = await response.json().catch(() => ({}));

        return corsResponse(
          {
            statusCode: response.ok ? 200 : response.status,
            headers: {
              "Content-Type": "application/json",
              // Cache light côté CDN & navigateur
              "Cache-Control": "public, max-age=30, must-revalidate",
              "Netlify-CDN-Cache-Control": "public, max-age=30, must-revalidate",
            },
            body: JSON.stringify(data),
          },
          allowOrigin
        );
      }

      // Téléchargement d'un fichier
      const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        id
      )}?alt=media&supportsAllDrives=true`;

      const response = await fetchWithRetry(url, {
        headers: { Authorization: `Bearer ${token}` },
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
      const isTodayFile = String(name).includes(today);
      const cacheSeconds = isTodayFile ? 60 : 3600;

      // Binaire encodé en Base64 (format Netlify)
      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": allowOrigin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
          "Access-Control-Max-Age": "600",
          "Content-Type": contentType,
          "Cache-Control": `public, max-age=${cacheSeconds}, must-revalidate`,
          "Netlify-CDN-Cache-Control": `public, max-age=${cacheSeconds}, must-revalidate`,
        },
        body: Buffer.from(arrayBuf).toString("base64"),
        isBase64Encoded: true,
      };
    } catch (err) {
      console.error("Erreur proxy Drive (GET):", err);
      return corsResponse({ statusCode: 500, body: "Erreur interne proxy Drive" }, allowOrigin);
    }
  }

  // Méthodes non supportées
  return corsResponse(
    {
      statusCode: 405,
      headers: { Allow: "GET, POST, OPTIONS" },
      body: "Méthode non autorisée",
    },
    allowOrigin
  );
}
