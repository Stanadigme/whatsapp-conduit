import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";

import type { Config } from "../config.js";
import { dashboardApi, type DashboardContext } from "./api.js";
import {
  createDashboardSession,
  DASHBOARD_SESSION_COOKIE,
  readDashboardToken,
  verifyDashboardSession,
} from "./token.js";

const INDEX_HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>whatsapp-conduit — Configuration</title><link rel="stylesheet" href="/styles.css"></head>
<body><main><header><h1>whatsapp-conduit</h1><p>Configuration locale, lecture seule par défaut.</p></header>
<section class="card"><h2>Accès local</h2><label>Jeton du dashboard <input id="token" type="password" autocomplete="off"></label><button id="connect">Se connecter</button><p id="auth" class="muted"></p></section>
<section class="card"><h2>Connexion</h2><p id="pairing-status">Non connecté</p><div id="qr" class="qr" hidden></div><button id="pairing-start">Afficher un QR d’appairage</button><button id="pairing-stop" hidden>Arrêter</button></section>
<section class="card"><h2>Contacts et groupes</h2><div class="toolbar"><input id="search" placeholder="Rechercher un nom ou un identifiant"><select id="kind"><option value="">Tous</option><option value="contact">Contacts</option><option value="group">Groupes</option></select><button id="refresh">Actualiser</button></div><div id="chats" class="list"></div></section>
<section class="card"><h2>Synchronisation historique</h2><p class="muted">Autorisez d’abord une discussion, puis choisissez la date la plus ancienne à récupérer. Les messages historiques sont ajoutés à SQLite sans être affichés ici.</p><label>Depuis <input id="history-since" type="date"></label><p id="history-status" class="muted">Aucune synchronisation lancée.</p></section>
<p class="muted">Le contenu des messages n’est jamais affiché ici. Le JID reste la référence technique.</p></main><script src="/app.js"></script></body></html>`;

const APP_JS = `(() => {
let token = '';
const $ = (id) => document.getElementById(id);
async function api(path, options = {}) { const response = await fetch(path, { ...options, headers: { ...(options.headers || {}), Authorization: 'Bearer ' + token } }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Erreur'); return data; }
function showError(error) { $('auth').textContent = error.message; $('auth').className = 'error'; }
let historyPoll = 0;
function historySince() { const value = $('history-since').value; if (!value) throw new Error('Choisissez une date de début.'); const timestamp = Math.floor(Date.parse(value + 'T00:00:00Z') / 1000); if (!Number.isFinite(timestamp)) throw new Error('Date de début invalide.'); return timestamp; }
function historyLabel(job) { const progress = job.progressPercent === null ? '' : ' — ' + job.progressPercent + '%'; const reason = job.errorCode === 'no_anchor' ? ' — impossible : aucun message de cette discussion n’est enregistré localement. Un message envoyé avant la connexion, ou non reçu par ce linked device, ne suffit pas ; faites recevoir un nouveau message après la connexion de l’ingestion, puis relancez.' : ''; return 'Synchronisation ' + job.status + ' (' + job.phase + ')' + progress + ', ' + job.messagesInserted + ' message(s) ajouté(s).' + reason; }
async function pollHistory(jobId) { clearTimeout(historyPoll); try { const job = await api('/api/history/' + encodeURIComponent(jobId)); $('history-status').textContent = historyLabel(job); $('history-status').className = job.status === 'failed' ? 'error' : 'muted'; if (job.status === 'queued' || job.status === 'waiting_connection' || job.status === 'running') historyPoll = setTimeout(() => pollHistory(jobId), 2000); } catch (error) { showError(error); } }
async function refreshHistory() { try { const active = await api('/api/history/active'); if (active.job) { $('history-status').textContent = historyLabel(active.job); pollHistory(active.job.id); } } catch (error) { showError(error); } }
async function refresh() { if (!token) return; try { const chats = await api('/api/chats?query=' + encodeURIComponent($('search').value) + '&kind=' + encodeURIComponent($('kind').value)); $('chats').innerHTML = chats.map(chat => '<article class="chat"><div><strong>' + escapeHtml(chat.name) + '</strong><small>' + escapeHtml(chat.jid) + '</small></div><span>' + (chat.allowed ? 'Autorisé' : chat.blocked ? 'Bloqué' : 'Découvert') + '</span><div class="chat-actions"><button data-action="' + (chat.allowed ? 'block' : 'allow') + '" data-jid="' + encodeURIComponent(chat.jid) + '">' + (chat.allowed ? 'Retirer' : 'Autoriser') + '</button><button data-action="history" data-jid="' + encodeURIComponent(chat.jid) + '"' + (chat.allowed ? '' : ' disabled') + '>Synchroniser</button></div></article>').join('') || '<p class="muted">Aucune conversation découverte.</p>'; await refreshHistory(); } catch (error) { showError(error); } }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char])); }
function updatePairingControls(state) { const disabled = state.status === 'disabled'; $('pairing-status').textContent = disabled ? 'Désactivé dans Docker Compose' : state.status; $('pairing-start').hidden = disabled; $('pairing-stop').hidden = disabled || state.status !== 'waiting_qr'; if (disabled) $('qr').hidden = true; }
$('connect').onclick = () => { token = $('token').value; $('auth').textContent = 'Jeton conservé uniquement en mémoire.'; $('auth').className = 'muted'; refresh(); api('/api/pairing/status').then(updatePairingControls).catch(showError); };
$('refresh').onclick = refresh; $('search').oninput = refresh; $('kind').onchange = refresh;
$('chats').onclick = async (event) => { const button = event.target.closest('button[data-action]'); if (!button) return; try { if (button.dataset.action === 'history') { const result = await api('/api/chats/' + button.dataset.jid + '/history?since=' + historySince(), { method: 'POST' }); $('history-status').textContent = 'Synchronisation démarrée (' + result.status + ').'; await pollHistory(result.jobId); return; } await api('/api/chats/' + button.dataset.jid + '/' + button.dataset.action, { method: 'POST' }); await refresh(); } catch (error) { showError(error); } };
$('pairing-start').onclick = async () => { try { await api('/api/pairing/start', { method: 'POST' }); $('pairing-start').hidden = true; $('pairing-stop').hidden = false; await pollPairing(); } catch (error) { showError(error); } };
$('pairing-stop').onclick = async () => { try { await api('/api/pairing/stop', { method: 'POST' }); $('pairing-start').hidden = false; $('pairing-stop').hidden = true; $('qr').hidden = true; } catch (error) { showError(error); } };
async function pollPairing() { try { const state = await api('/api/pairing/status'); $('pairing-status').textContent = state.status; if (state.status === 'waiting_qr') { const qr = await api('/api/pairing/qr'); $('qr').innerHTML = qr.qr; $('qr').hidden = false; } if (state.status === 'waiting_qr' || state.status === 'starting') setTimeout(pollPairing, 2000); } catch (error) { showError(error); } }
})();`;

const STYLES_CSS = `:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;background:#f4f5f7;color:#1f2933}main{max-width:960px;margin:0 auto;padding:24px}header{margin-bottom:20px}.card{background:white;border:1px solid #d9dee5;border-radius:10px;padding:18px;margin:14px 0;box-shadow:0 1px 2px #0001}h1,h2{margin-top:0}label{display:flex;gap:12px;align-items:center}input,select,button{font:inherit;padding:8px;border:1px solid #bbc4cf;border-radius:6px}button{cursor:pointer;background:#155eef;border-color:#155eef;color:#ffffff;font-weight:600}button:hover{background:#004eeb;border-color:#004eeb}button:focus-visible{outline:3px solid #84adff;outline-offset:2px}.toolbar{display:flex;gap:8px;margin-bottom:12px}.toolbar input{flex:1}.chat{display:flex;gap:12px;align-items:center;justify-content:space-between;border-top:1px solid #e5e7eb;padding:12px 0}.chat div{display:flex;flex-direction:column}.chat small{color:#68737d}.chat span{font-size:.9em;color:#68737d}.qr{background:#fff;color:#000;font:12px/1 monospace;overflow:auto;padding:12px;white-space:pre}.muted{color:#68737d}.error{color:#b42318}@media(prefers-color-scheme:dark){body{background:#111827;color:#e5e7eb}.card{background:#1f2937;border-color:#374151}.chat{border-color:#374151}.qr{background:#fff;color:#000}input,select{background:#111827;color:#e5e7eb;border-color:#4b5563}}`;

const DIRECT_INDEX_HTML = INDEX_HTML.replace(
  /<label>Jeton du dashboard <input id="token" type="password" autocomplete="off"><\/label><button id="connect">[^<]*<\/button>/,
  '<p id="auth" class="muted">Authentification automatique de la session locale.</p>',
).replace(
  "</main>",
  `<section id="conversation" class="card" hidden>
<p><a href="/" id="conversation-back">← Retour aux discussions</a></p>
<h2 id="conversation-title">Discussion</h2><p id="conversation-jid" class="muted"></p>
<div id="conversation-messages" class="message-list"></div>
<div class="conversation-actions"><button id="conversation-older" hidden>Charger les messages plus anciens</button><button id="conversation-refresh">Actualiser</button></div>
<p id="conversation-status" class="muted"></p></section></main>`,
);

/* eslint-disable no-useless-escape -- embedded JavaScript uses escaped HTML quotes. */
const DIRECT_APP_JS = APP_JS.replace(
  /async function api\(path, options = \{\}\) \{.*?\n/,
  "async function api(path, options = {}) { const response = await fetch(path, { ...options, credentials: 'same-origin' }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Erreur'); return data; }\n",
)
  .replace("let token = '';\n", "")
  .replace(
    "async function refresh() { if (!token) return;",
    "async function refresh() { try { const chats = await api('/api/chats?query=' + encodeURIComponent($('search').value) + '&kind=' + encodeURIComponent($('kind').value)); $('chats').innerHTML = chats.map(chat => { const read = chat.allowed ? '<a class=\"chat-link\" href=\"/conversation/' + encodeURIComponent(chat.jid) + '\">Lire la discussion</a>' : ''; return '<article class=\"chat\"><div><strong>' + escapeHtml(chat.name) + '</strong><small>' + escapeHtml(chat.jid) + '</small></div><span>' + (chat.allowed ? 'Autorisé' : chat.blocked ? 'Bloqué' : 'Découvert') + '</span><div class=\"chat-actions\">' + read + '<button data-action=\"' + (chat.allowed ? 'block' : 'allow') + '\" data-jid=\"' + encodeURIComponent(chat.jid) + '\">' + (chat.allowed ? 'Retirer' : 'Autoriser') + '</button><button data-action=\"history\" data-jid=\"' + encodeURIComponent(chat.jid) + '\"' + (chat.allowed ? '' : ' disabled') + '>Synchroniser</button></div></article>'; }).join('') || '<p class=\"muted\">Aucune conversation découverte.</p>'; await refreshHistory(); } catch (error) { showError(error); }",
  )
  .replace(/\$\('connect'\)\.onclick = .*?\n/, "bootstrap();\n")
  .replace(
    "\n})();",
    `
let conversationState = null;
function conversationJid() { const match = /^\\/conversation\\/(.+)$/.exec(window.location.pathname); return match ? decodeURIComponent(match[1]) : null; }
function formatTimestamp(value) { return value === null ? 'Date inconnue' : new Date(value * 1000).toLocaleString('fr-FR'); }
function metadataRow(label, value) { return value === null || value === undefined || value === '' ? '' : '<dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(String(value)) + '</dd>'; }
function renderMessage(message) { const text = message.text === null ? '' : '<p class=\"message-text\">' + escapeHtml(message.text) + '</p>'; const transcript = message.textCorrected !== null || (message.messageType === 'audio' && message.textRaw !== null) ? '<div class=\"transcript\"><strong>Transcription brute</strong><p>' + escapeHtml(message.textRaw || 'Indisponible') + '</p><strong>Correction</strong><p>' + escapeHtml(message.textCorrected || 'Non disponible') + '</p></div>' : ''; const metadata = '<details><summary>Détails</summary><dl>' + metadataRow('Date', formatTimestamp(message.timestamp ?? message.receivedAt)) + metadataRow('Expéditeur', message.senderName || message.senderJid || (message.fromMe ? 'Moi' : 'Inconnu')) + metadataRow('Type', message.messageType) + metadataRow('Source', message.ingestionSource) + metadataRow('Média', message.hasMedia ? (message.durationS === null ? 'présent' : 'présent, ' + message.durationS + ' s') : 'aucun') + metadataRow('Message ID', message.messageId) + metadataRow('Message cité', message.quotedMessageId) + metadataRow('Sender cité', message.quotedSenderJid) + metadataRow('Message édité', message.editedMessageId) + metadataRow('Supprimé le', message.deletedAt === null ? null : formatTimestamp(message.deletedAt)) + '</dl></details>'; return '<article class=\"message' + (message.fromMe ? ' message-from-me' : '') + (message.deletedAt !== null ? ' message-deleted' : '') + '\"><header><strong>' + escapeHtml(message.senderName || message.senderJid || (message.fromMe ? 'Moi' : 'Inconnu')) + '</strong><time>' + escapeHtml(formatTimestamp(message.timestamp ?? message.receivedAt)) + '</time></header>' + text + transcript + metadata + '</article>'; }
function renderConversation() { if (!conversationState) return; const container = $('conversation-messages'); container.innerHTML = conversationState.items.map(renderMessage).join('') || '<p class=\"muted\">Aucun message enregistré pour cette discussion.</p>'; $('conversation-older').hidden = !conversationState.nextCursor; $('conversation-status').textContent = conversationState.nextCursor ? '' : 'Fin de l’historique local.'; }
async function loadConversation(reset = false) { if (!conversationState || conversationState.loading) return; conversationState.loading = true; const container = $('conversation-messages'); const oldHeight = container.scrollHeight; const oldTop = container.scrollTop; try { const query = new URLSearchParams({ limit: '50' }); if (!reset && conversationState.nextCursor) query.set('cursor', conversationState.nextCursor); const page = await api('/api/chats/' + encodeURIComponent(conversationState.jid) + '/messages?' + query.toString()); const items = page.items.slice().reverse(); conversationState.items = reset ? items : items.concat(conversationState.items); conversationState.nextCursor = page.nextCursor; renderConversation(); if (reset) container.scrollTop = container.scrollHeight; else container.scrollTop = oldTop + (container.scrollHeight - oldHeight); } catch (error) { showError(error); $('conversation-status').textContent = error.message; $('conversation-status').className = 'error'; } finally { conversationState.loading = false; } }
async function showConversation(jid) { document.querySelectorAll('main > section, main > p').forEach(element => { if (element.id !== 'conversation') element.hidden = true; }); $('conversation').hidden = false; conversationState = { jid, items: [], nextCursor: null, loading: false }; $('conversation-jid').textContent = jid; try { const chats = await api('/api/chats?query=' + encodeURIComponent(jid)); const chat = chats.find(item => item.jid === jid); $('conversation-title').textContent = chat ? chat.name : 'Discussion'; } catch (error) { showError(error); } await loadConversation(true); }
function bootstrap() { const jid = conversationJid(); if (jid) { void showConversation(jid); return; } void refresh(); api('/api/pairing/status').then(updatePairingControls).catch(showError); }
$('conversation-older').onclick = () => { void loadConversation(false); };
$('conversation-refresh').onclick = () => { if (conversationState) { conversationState.nextCursor = null; void loadConversation(true); } };
bootstrap();
})();`,
  );
/* eslint-enable no-useless-escape */

const DIRECT_STYLES_CSS =
  STYLES_CSS +
  ".chat-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.chat-link{color:#155eef;font-weight:600}.message-list{display:flex;flex-direction:column;gap:12px;max-height:65vh;overflow:auto;padding:4px}.message{background:#f8fafc;border:1px solid #d9dee5;border-radius:10px;padding:12px;max-width:85%}.message-from-me{align-self:flex-end;background:#eaf2ff}.message-deleted{opacity:.7}.message header{display:flex;justify-content:space-between;gap:16px;font-size:.9em}.message time{color:#68737d}.message-text{white-space:pre-wrap;overflow-wrap:anywhere}.transcript{border-left:3px solid #84adff;padding-left:10px}.transcript p{white-space:pre-wrap;overflow-wrap:anywhere}.message dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;font-size:.85em}.message dd{margin:0;overflow-wrap:anywhere}.conversation-actions{display:flex;gap:8px;margin-top:12px}@media(prefers-color-scheme:dark){.message{background:#1f2937;border-color:#374151}.message-from-me{background:#17315f}.chat-link{color:#84adff}}";

type AuthorizationMethod = "bearer" | "session";

function cookieValue(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    if (key === name) return item.slice(separator + 1).trim();
  }
  return undefined;
}

function authorizationMethod(
  request: IncomingMessage,
  token: string,
): AuthorizationMethod | null {
  const value = request.headers.authorization;
  if (value?.startsWith("Bearer ")) {
    const provided = Buffer.from(value.slice(7), "utf8");
    const expected = Buffer.from(token, "utf8");
    if (
      provided.length === expected.length &&
      timingSafeEqual(provided, expected)
    ) {
      return "bearer";
    }
  }

  const session = cookieValue(request, DASHBOARD_SESSION_COOKIE);
  return session && verifyDashboardSession(token, session) ? "session" : null;
}

function sameOriginRequest(request: IncomingMessage): boolean {
  const host = request.headers.host;
  if (!host) return false;
  const expectedOrigin = `http://${host}`;
  const origin = request.headers.origin;
  if (origin) return origin === expectedOrigin;
  const referer = request.headers.referer;
  if (!referer) return false;
  try {
    return new URL(referer).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  type: string,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'",
    ...extraHeaders,
  });
  response.end(body);
}

async function toRequest(request: IncomingMessage): Promise<Request> {
  const host = request.headers.host ?? "127.0.0.1";
  return new Request(`http://${host}${request.url ?? "/"}`, {
    method: request.method,
    headers: request.headers as Record<string, string>,
  });
}

export interface DashboardServer {
  server: ReturnType<typeof createServer>;
  token: string;
}

export async function createDashboardServer(
  config: Config,
  context: DashboardContext,
): Promise<DashboardServer> {
  const token = readDashboardToken(config.web.tokenFile);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? config.web.host}`,
      );
      if (
        (url.pathname === "/" || url.pathname.startsWith("/conversation/")) &&
        request.method === "GET"
      ) {
        return send(
          response,
          200,
          DIRECT_INDEX_HTML,
          "text/html; charset=utf-8",
          {
            "Set-Cookie": `${DASHBOARD_SESSION_COOKIE}=${createDashboardSession(token)}; Path=/; HttpOnly; SameSite=Strict`,
          },
        );
      }
      if (url.pathname === "/app.js" && request.method === "GET")
        return send(
          response,
          200,
          DIRECT_APP_JS,
          "text/javascript; charset=utf-8",
        );
      if (url.pathname === "/styles.css" && request.method === "GET")
        return send(
          response,
          200,
          DIRECT_STYLES_CSS,
          "text/css; charset=utf-8",
        );
      if (!url.pathname.startsWith("/api/"))
        return send(response, 404, "Not found\n", "text/plain; charset=utf-8");
      const authMethod = authorizationMethod(request, token);
      if (!authMethod)
        return send(
          response,
          401,
          JSON.stringify({ error: "unauthorized" }),
          "application/json; charset=utf-8",
        );
      if (
        authMethod === "session" &&
        request.method !== "GET" &&
        request.method !== "HEAD" &&
        request.method !== "OPTIONS" &&
        !sameOriginRequest(request)
      ) {
        return send(
          response,
          403,
          JSON.stringify({ error: "forbidden" }),
          "application/json; charset=utf-8",
        );
      }
      const result = await dashboardApi(await toRequest(request), context);
      if (!result)
        return send(
          response,
          404,
          JSON.stringify({ error: "not found" }),
          "application/json; charset=utf-8",
        );
      send(
        response,
        result.status,
        await result.text(),
        result.headers.get("Content-Type") ?? "application/json; charset=utf-8",
      );
    } catch {
      send(
        response,
        500,
        JSON.stringify({ error: "dashboard request failed" }),
        "application/json; charset=utf-8",
      );
    }
  });
  return { server, token };
}

export async function startDashboardServer(
  config: Config,
  context: DashboardContext,
): Promise<DashboardServer> {
  const dashboard = await createDashboardServer(config, context);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      dashboard.server.off("error", onError);
      reject(error);
    };
    dashboard.server.once("error", onError);
    dashboard.server.listen(config.web.port, config.web.host, () => {
      dashboard.server.off("error", onError);
      resolve();
    });
  });
  return dashboard;
}
