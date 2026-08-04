/**
 * Service worker.
 *
 *  1. Opens the side panel when the toolbar icon is clicked.
 *  2. (Opt-in) Watches requests to management.azure.com and grabs the
 *     Authorization header, so you don't have to copy the JWT out of the
 *     Network tab by hand.
 *
 * The captured token goes to chrome.storage.session — memory only, cleared when
 * Chrome closes — and is only ever sent back to management.azure.com.
 *
 * Note on timing: this worker is torn down after ~30s idle and restarted *by*
 * the request it is observing. Anything read asynchronously at top level is not
 * ready when the first listener fires, so the enabled flag is read inside the
 * handler instead of being cached in a module variable.
 */

const TOKEN_KEY = 'capturedToken';
const SEEN_KEY = 'captureSeen';
const DETECTED_KEY = 'detectedService';
const FLAG_KEY = 'captureEnabled';

const panelBehavior = () =>
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(panelBehavior);
chrome.runtime.onStartup.addListener(panelBehavior);
panelBehavior();

function looksLikeJwt(value) {
  const parts = value.split('.');
  return parts.length === 3 && parts[0].length > 10 && parts[1].length > 10;
}

const SERVICE_RE =
  /\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ApiManagement\/service\/([^/?#]+)/i;

let lastStoredToken = null;
let lastSeenWrite = 0;
let lastDetectedId = null;

/** ARM request paths name the instance being managed, so read it off the URL. */
async function noteDetectedService(url) {
  let match = null;
  try {
    match = decodeURIComponent(url).match(SERVICE_RE);
  } catch {
    match = url.match(SERVICE_RE);
  }
  if (!match) return;
  const id =
    `/subscriptions/${match[1]}/resourceGroups/${match[2]}` +
    `/providers/Microsoft.ApiManagement/service/${match[3]}`;
  if (id === lastDetectedId) return;
  lastDetectedId = id;
  await chrome.storage.session.set({
    [DETECTED_KEY]: { id, serviceName: match[3], at: Date.now(), source: 'ARM traffic' }
  });
}

async function noteSeen(details, hadAuth) {
  // Throttled heartbeat so the panel can say "traffic seen, no token yet"
  // instead of leaving you guessing.
  const now = Date.now();
  if (!hadAuth && now - lastSeenWrite < 2000) return;
  lastSeenWrite = now;
  await chrome.storage.session.set({
    [SEEN_KEY]: {
      at: now,
      url: details.url.split('?')[0],
      initiator: details.initiator || null,
      hadAuth
    }
  });
}

async function handle(details) {
  const { [FLAG_KEY]: enabled } = await chrome.storage.local.get(FLAG_KEY);
  if (!enabled) return;

  const header = (details.requestHeaders || []).find(
    (h) => h.name.toLowerCase() === 'authorization'
  );
  const value = header?.value?.trim() || '';
  const hadAuth = /^bearer\s+/i.test(value);

  await noteSeen(details, hadAuth);
  await noteDetectedService(details.url);
  if (!hadAuth) return;

  const token = value.replace(/^bearer\s+/i, '');
  if (!looksLikeJwt(token) || token === lastStoredToken) return;
  lastStoredToken = token;

  await chrome.storage.session.set({
    [TOKEN_KEY]: {
      token,
      capturedAt: Date.now(),
      url: details.url.split('?')[0],
      initiator: details.initiator || null
    }
  });
}

const filter = { urls: ['https://management.azure.com/*'] };
const extra = ['requestHeaders', 'extraHeaders'];

// Both events are registered because a request that is redirected or served
// from a worker context can surface on one and not the other. handle() is
// idempotent, so a duplicate is harmless.
chrome.webRequest.onBeforeSendHeaders.addListener(handle, filter, extra);
chrome.webRequest.onSendHeaders.addListener(handle, filter, extra);
