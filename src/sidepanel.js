import { $, h, tokenSummary, fmtCountdown, download, copy } from './lib/util.js';
import { ArmClient, AuthError } from './lib/arm.js';
import { ApimService, parseServiceRef, discoverServices, API_VERSIONS, DEFAULT_API_VERSION } from './lib/apim.js';
import { loadCatalog, resolveApi, toExport, toReport } from './lib/resolver.js';
import {
  loadTargetIndex,
  compareApi,
  comparisonToText,
  DEFAULT_ENV_PATTERN
} from './lib/compare.js';

const SETTINGS_KEY = 'settings';
const MANUAL_TOKEN_KEY = 'manualToken';
const CAPTURED_KEY = 'capturedToken';
const SEEN_KEY = 'captureSeen';
const DETECTED_KEY = 'detectedService';

const state = {
  token: '',
  captured: null,
  captureSeen: null,
  detectedTab: null,
  detectedTraffic: null,
  service: null,
  apiVersion: DEFAULT_API_VERSION,
  apis: [],
  catalog: null,
  resolved: new Map(),
  lastExpanded: null,
  targetService: null,
  targetIndex: null,
  inFlight: new Set(),
  filter: ''
};

const client = new ArmClient({ getToken: () => state.token });

const els = {
  setup: $('#setup'),
  toggleSetup: $('#toggle-setup'),
  token: $('#token'),
  capture: $('#capture'),
  useCaptured: $('#use-captured'),
  tokenStatus: $('#token-status'),
  service: $('#service'),
  apiVersion: $('#api-version'),
  discover: $('#discover'),
  discovered: $('#discovered'),
  compareEnabled: $('#compare-enabled'),
  compareFields: $('#compare-fields'),
  targetService: $('#target-service'),
  envPattern: $('#env-pattern'),
  targetStatus: $('#target-status'),
  includeOperations: $('#include-operations'),
  includeProducts: $('#include-products'),
  fetch: $('#fetch'),
  clearCache: $('#clear-cache'),
  setupError: $('#setup-error'),
  toolbar: $('#toolbar'),
  search: $('#search'),
  export: $('#export'),
  results: $('#results'),
  progress: $('#progress'),
  counters: $('#counters')
};

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

for (const version of API_VERSIONS) {
  els.apiVersion.append(h('option', { value: version, selected: version === DEFAULT_API_VERSION }, version));
}

init();

async function init() {
  const local = await chrome.storage.local.get([SETTINGS_KEY, 'captureEnabled']);
  const settings = local[SETTINGS_KEY] || {};
  els.service.value = settings.service || '';
  els.apiVersion.value = settings.apiVersion || DEFAULT_API_VERSION;
  els.compareEnabled.checked = !!settings.compareEnabled;
  els.compareFields.hidden = !settings.compareEnabled;
  els.targetService.value = settings.targetService || '';
  els.envPattern.value = settings.envPattern || DEFAULT_ENV_PATTERN;
  els.includeOperations.checked = settings.includeOperations !== false;
  els.includeProducts.checked = settings.includeProducts !== false;
  els.capture.checked = !!local.captureEnabled;

  const session = await chrome.storage.session.get([
    MANUAL_TOKEN_KEY,
    CAPTURED_KEY,
    SEEN_KEY,
    DETECTED_KEY
  ]);
  if (session[MANUAL_TOKEN_KEY]) {
    els.token.value = session[MANUAL_TOKEN_KEY];
    state.token = session[MANUAL_TOKEN_KEY];
  }
  state.captured = session[CAPTURED_KEY] || null;
  state.captureSeen = session[SEEN_KEY] || null;
  state.detectedTraffic = session[DETECTED_KEY] || null;

  refreshTokenStatus();
  setInterval(refreshTokenStatus, 1000);
  pollActiveTab();
  setInterval(pollActiveTab, 2000);
  window.addEventListener('focus', pollActiveTab);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes[CAPTURED_KEY]) state.captured = changes[CAPTURED_KEY].newValue || null;
  if (changes[SEEN_KEY]) state.captureSeen = changes[SEEN_KEY].newValue || null;
  if (changes[DETECTED_KEY]) {
    state.detectedTraffic = changes[DETECTED_KEY].newValue || null;
    updateDetected();
  }
  if (changes[CAPTURED_KEY] || changes[SEEN_KEY]) refreshTokenStatus();
});

// ---------------------------------------------------------------------------
// instance detection
// ---------------------------------------------------------------------------

const detectedLine = h('p', { class: 'status' });
els.discovered.before(detectedLine);

const serviceIdOf = (ref) =>
  `/subscriptions/${ref.subscriptionId}/resourceGroups/${ref.resourceGroup}` +
  `/providers/Microsoft.ApiManagement/service/${ref.serviceName}`;

/**
 * Reads the active tab's URL. The portal keeps the resource ID in the hash, and
 * the manifest's portal host permissions are what make tab.url visible here —
 * no "tabs" permission, so no browsing-history warning at install.
 */
async function pollActiveTab() {
  if (els.setup.hidden) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    // Guard against loose matches on unrelated URLs.
    const ref = url.includes('Microsoft.ApiManagement') ? parseServiceRef(url) : null;
    state.detectedTab = ref ? { ...ref, id: serviceIdOf(ref), source: 'portal tab' } : null;
  } catch {
    state.detectedTab = null;
  }
  updateDetected();
}

function updateDetected() {
  const detected = state.detectedTab || state.detectedTraffic;
  if (!detected) {
    detectedLine.replaceChildren();
    return;
  }

  const current = els.service.value.trim();
  if (!current) {
    els.service.value = detected.id;
    saveSettings();
    detectedLine.className = 'status good';
    detectedLine.replaceChildren(`Filled from the ${detected.source}.`);
    return;
  }

  const currentRef = parseServiceRef(current);
  if (currentRef && serviceIdOf(currentRef).toLowerCase() === detected.id.toLowerCase()) {
    detectedLine.className = 'status good';
    detectedLine.replaceChildren(`Matches the ${detected.source}.`);
    return;
  }

  detectedLine.className = 'status';
  detectedLine.replaceChildren(
    `${detected.serviceName} is open in the ${detected.source}. `,
    h(
      'button',
      {
        class: 'link',
        type: 'button',
        onClick: () => {
          els.service.value = detected.id;
          saveSettings();
          updateDetected();
        }
      },
      'use it'
    )
  );
}

function saveSettings() {
  chrome.storage.local.set({
    [SETTINGS_KEY]: {
      service: els.service.value.trim(),
      apiVersion: els.apiVersion.value,
      compareEnabled: els.compareEnabled.checked,
      targetService: els.targetService.value.trim(),
      envPattern: els.envPattern.value.trim(),
      includeOperations: els.includeOperations.checked,
      includeProducts: els.includeProducts.checked
    }
  });
}

// ---------------------------------------------------------------------------
// token
// ---------------------------------------------------------------------------

els.token.addEventListener('input', () => {
  state.token = els.token.value.trim();
  chrome.storage.session.set({ [MANUAL_TOKEN_KEY]: state.token });
  refreshTokenStatus();
});

els.capture.addEventListener('change', () => {
  chrome.storage.local.set({ captureEnabled: els.capture.checked });
  refreshTokenStatus();
});

els.useCaptured.addEventListener('click', () => {
  if (!state.captured?.token) return;
  els.token.value = state.captured.token;
  state.token = state.captured.token;
  chrome.storage.session.set({ [MANUAL_TOKEN_KEY]: state.token });
  refreshTokenStatus();
});

// Diagnostics line under the capture checkbox. Built here so the markup stays
// declarative and this stays a single-file change.
const captureStatus = h('p', { class: 'status' });
els.capture.closest('.row').after(captureStatus);

function ago(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function updateCaptureStatus() {
  const inUse = state.captured?.token && state.captured.token === state.token;
  els.useCaptured.disabled = !state.captured?.token || inUse;
  els.useCaptured.title = inUse
    ? 'The captured token is already in the box'
    : 'Copy the captured token into the box';

  if (!els.capture.checked) {
    captureStatus.className = 'status';
    captureStatus.textContent = 'Capture off.';
    return;
  }
  if (state.captured?.token) {
    captureStatus.className = 'status good';
    captureStatus.textContent = `Captured ${ago(state.captured.capturedAt)} from ${state.captured.url}`;
    return;
  }
  if (state.captureSeen) {
    captureStatus.className = 'status';
    captureStatus.textContent =
      `Saw an ARM request ${ago(state.captureSeen.at)} with no Authorization header. ` +
      'Trigger a portal action that reads a resource.';
    return;
  }
  captureStatus.className = 'status';
  captureStatus.textContent =
    'Capture on, no ARM traffic seen yet. Open or reload an Azure portal tab.';
}

function refreshTokenStatus() {
  updateCaptureStatus();

  const info = tokenSummary(state.token);
  if (!state.token) {
    els.tokenStatus.className = 'status';
    els.tokenStatus.textContent = state.captured?.token
      ? 'A token was captured from portal traffic. Click “Use captured”.'
      : 'No token yet.';
    return;
  }
  if (!info?.valid) {
    els.tokenStatus.className = 'status bad';
    els.tokenStatus.textContent = 'That does not decode as a JWT. Paste the value after "Bearer ".';
    return;
  }
  const parts = [];
  if (info.user) parts.push(info.user);
  parts.push(fmtCountdown(info.expiresInMs));
  if (!info.audienceOk) parts.push(`audience ${info.audience} — not an ARM token`);
  els.tokenStatus.className = 'status ' + (info.expired || !info.audienceOk ? 'bad' : 'good');
  els.tokenStatus.textContent = parts.join(' · ');
}

// ---------------------------------------------------------------------------
// service selection
// ---------------------------------------------------------------------------

els.toggleSetup.addEventListener('click', () => {
  els.setup.hidden = !els.setup.hidden;
});

els.discover.addEventListener('click', async () => {
  els.discovered.replaceChildren(h('div', { class: 'loading' }, 'Listing subscriptions'));
  try {
    const services = await discoverServices(client, els.apiVersion.value);
    if (!services.length) {
      els.discovered.replaceChildren(h('div', { class: 'note' }, 'No API Management instances visible to this token.'));
      return;
    }
    els.discovered.replaceChildren(
      ...services.map((svc) =>
        h(
          'button',
          {
            type: 'button',
            onClick: () => {
              els.service.value = svc.id;
              els.discovered.replaceChildren();
              saveSettings();
            }
          },
          `${svc.serviceName} · ${svc.resourceGroup} · ${svc.location}`
        )
      )
    );
  } catch (err) {
    showError(err);
    els.discovered.replaceChildren();
  }
});

els.compareEnabled.addEventListener('change', () => {
  els.compareFields.hidden = !els.compareEnabled.checked;
  saveSettings();
});

for (const field of [els.targetService, els.envPattern]) {
  field.addEventListener('change', () => {
    // A new target or pattern invalidates everything already compared.
    state.targetIndex = null;
    state.targetService = null;
    for (const resolved of state.resolved.values()) resolved.comparison = null;
    saveSettings();
    render();
  });
}

// Discovery for the target field, mirroring the source instance picker.
const targetDiscovered = h('div', { class: 'discovered' });
const targetDiscoverButton = h(
  'button',
  {
    class: 'ghost small',
    type: 'button',
    onClick: async () => {
      targetDiscovered.replaceChildren(h('div', { class: 'loading' }, 'Listing subscriptions'));
      try {
        const services = await discoverServices(client, els.apiVersion.value);
        if (!services.length) {
          targetDiscovered.replaceChildren(
            h('div', { class: 'note' }, 'No API Management instances visible to this token.')
          );
          return;
        }
        targetDiscovered.replaceChildren(
          ...services.map((svc) =>
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  els.targetService.value = svc.id;
                  targetDiscovered.replaceChildren();
                  state.targetIndex = null;
                  state.targetService = null;
                  for (const resolved of state.resolved.values()) resolved.comparison = null;
                  saveSettings();
                  render();
                }
              },
              `${svc.serviceName} · ${svc.resourceGroup} · ${svc.location}`
            )
          )
        );
      } catch (err) {
        targetDiscovered.replaceChildren(h('div', { class: 'note' }, err.message));
      }
    }
  },
  'Find target'
);
els.envPattern.parentElement.append(targetDiscoverButton);
els.targetStatus.before(targetDiscovered);

/** Builds the target index once, then reuses it for every API compared. */
async function ensureTargetIndex(onProgress) {
  if (!els.compareEnabled.checked) return null;
  const ref = parseServiceRef(els.targetService.value);
  if (!ref) {
    els.targetStatus.className = 'status bad';
    els.targetStatus.textContent = 'Target instance not recognised.';
    return null;
  }
  if (state.targetIndex) return state.targetIndex;

  state.targetService = new ApimService(client, ref, els.apiVersion.value);
  state.targetIndex = await loadTargetIndex(state.targetService, onProgress);

  const counts = state.targetIndex.counts;
  els.targetStatus.className = 'status good';
  els.targetStatus.textContent =
    `${state.targetIndex.serviceName}: ${counts.namedValues} named values, ` +
    `${counts.backends} backends, ${counts.fragments} fragments, ${counts.products} products`;
  return state.targetIndex;
}

els.clearCache.addEventListener('click', () => {
  client.clearCache();
  state.catalog = null;
  state.targetIndex = null;
  state.resolved.clear();
  render();
  setProgress('Cache cleared');
});

// ---------------------------------------------------------------------------
// fetch APIs
// ---------------------------------------------------------------------------

els.fetch.addEventListener('click', fetchApis);
els.search.addEventListener('input', () => {
  state.filter = els.search.value.trim().toLowerCase();
  render();
});
els.export.addEventListener('click', exportResolved);

async function fetchApis() {
  hideError();
  const ref = parseServiceRef(els.service.value);
  if (!ref) {
    showError(new Error('Could not read an API Management resource ID from that value.'));
    return;
  }
  if (!state.token) {
    showError(new Error('Paste a bearer token first.'));
    return;
  }

  saveSettings();
  state.apiVersion = els.apiVersion.value;
  state.service = new ApimService(client, ref, state.apiVersion);
  state.catalog = null;
  state.resolved.clear();

  els.fetch.disabled = true;
  setProgress('Listing APIs');
  els.results.replaceChildren(h('p', { class: 'loading' }, 'Listing APIs'));

  try {
    state.apis = await state.service.listApis();
    state.apis.sort((a, b) =>
      (a.properties?.displayName || a.name).localeCompare(b.properties?.displayName || b.name)
    );
    els.toolbar.hidden = false;
    els.setup.hidden = true;
    setProgress('');
    render();
  } catch (err) {
    showError(err);
    els.results.replaceChildren();
  } finally {
    els.fetch.disabled = false;
    updateCounters();
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function render() {
  const apis = state.apis.filter((api) => {
    if (!state.filter) return true;
    const haystack = [
      api.properties?.displayName,
      api.name,
      api.properties?.path,
      api.properties?.serviceUrl
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(state.filter);
  });

  if (!state.apis.length) {
    els.results.replaceChildren(
      h('p', { class: 'empty' }, 'No APIs returned. Check the instance and that the token can read it.')
    );
    updateCounters();
    return;
  }

  els.results.replaceChildren(...apis.map(renderApiRow));
  updateCounters();
}

function renderApiRow(api) {
  const apiId = api.name;
  const resolved = state.resolved.get(apiId);
  const displayName = api.properties?.displayName || apiId;

  const details = h('details', { class: 'api', dataset: { apiId } });
  const summary = h(
    'summary',
    null,
    h('span', { class: 'chev' }, '▸'),
    h(
      'span',
      null,
      h(
        'span',
        { class: 'api-name' },
        displayName,
        api.properties?.apiVersion ? h('span', { class: 'tag' }, api.properties.apiVersion) : null,
        api.properties?.isCurrent === false ? h('span', { class: 'tag' }, 'rev ' + api.properties.apiRevision) : null
      ),
      h('span', { class: 'api-meta' }, `/${api.properties?.path ?? ''}`)
    ),
    resolved ? fingerprint(resolved) : h('span', { class: 'api-meta' }, '')
  );

  const body = h('div', { class: 'body' });
  details.append(summary, body);

  if (resolved) body.replaceChildren(renderResolved(resolved));

  details.addEventListener('toggle', () => {
    if (!details.open) return;
    state.lastExpanded = apiId;
    if (state.resolved.has(apiId) || state.inFlight.has(apiId)) return;
    expandApi(api, body, summary);
  });

  return details;
}

function fingerprint(resolved) {
  // Letters beat bar heights here: a bar only says one thing is bigger than
  // another, a chip says what it is and how many.
  const chips = [
    ['BE', 'backends', 'var(--c-backend)', 'backends'],
    ['PR', 'products', 'var(--c-product)', 'products'],
    ['FR', 'fragments', 'var(--c-fragment)', 'policy fragments'],
    ['NV', 'namedValues', 'var(--c-namedvalue)', 'named values'],
    ['KV', 'keyVault', 'var(--c-vault)', 'Key Vault secrets']
  ];
  const wrap = h('span', { class: 'fingerprint' });

  for (const [label, key, color, title] of chips) {
    const n = resolved.counts[key] || 0;
    if (!n) continue;
    add(wrap, h('span', { class: 'fp', style: `color:${color}`, title: `${n} ${title}` }, `${label}${n}`));
  }

  if (resolved.counts.issues) {
    add(
      wrap,
      h(
        'span',
        { class: 'fp', style: 'color:var(--c-issue)', title: `${resolved.counts.issues} broken reference(s)` },
        `!${resolved.counts.issues}`
      )
    );
  }

  if (resolved.comparison) {
    const blocking = resolved.comparison.blocking;
    add(
      wrap,
      h(
        'span',
        {
          class: 'fp',
          style: `color:${blocking ? 'var(--c-issue)' : 'var(--c-namedvalue)'}`,
          title: blocking
            ? `${blocking} gap(s) against ${resolved.comparison.target}`
            : `matches ${resolved.comparison.target}`
        },
        blocking ? `GAP${blocking}` : 'OK'
      )
    );
  }
  return wrap;
}

async function expandApi(api, body, summary) {
  const apiId = api.name;
  state.inFlight.add(apiId);
  const line = h('div', { class: 'loading' }, 'Reading API policy');
  body.replaceChildren(line);

  const onProgress = (message) => {
    line.textContent = message;
    setProgress(`${api.properties?.displayName || apiId}: ${message}`);
  };

  try {
    if (!state.catalog) {
      state.catalog = await loadCatalog(state.service, onProgress);
    }
    const resolved = await resolveApi(
      state.service,
      state.catalog,
      api,
      {
        includeOperations: els.includeOperations.checked,
        includeProducts: els.includeProducts.checked
      },
      onProgress
    );
    if (els.compareEnabled.checked) {
      const index = await ensureTargetIndex(onProgress);
      if (index) {
        onProgress(`Comparing against ${index.serviceName}`);
        resolved.comparison = await compareApi(state.targetService, index, resolved, {
          pattern: els.envPattern.value.trim() || undefined
        });
      }
    }

    state.resolved.set(apiId, resolved);
    state.lastExpanded = apiId;
    body.replaceChildren(renderResolved(resolved));
    const old = summary.querySelector('.fingerprint, .api-meta:last-child');
    if (old) old.replaceWith(fingerprint(resolved));
    setProgress('');
  } catch (err) {
    body.replaceChildren(h('p', { class: 'error' }, err.message));
    if (err instanceof AuthError) {
      els.setup.hidden = false;
      refreshTokenStatus();
    }
  } finally {
    state.inFlight.delete(apiId);
    updateCounters();
  }
}

function occurrences(list, label = 'references') {
  if (!list?.length) return null;
  const text = list
    .map((o) => `${o.scope || ''} ${o.section ? `[${o.section}]` : ''} ${o.where || ''}\n  ${o.snippet || ''}`)
    .join('\n\n');
  return h(
    'details',
    { class: 'occurrences' },
    h('summary', null, `${list.length} ${label}`),
    h('pre', null, text)
  );
}

function copyButton(label, getText) {
  const button = h(
    'button',
    {
      class: 'link',
      type: 'button',
      style: 'margin-left:auto',
      onClick: async () => {
        await copy(getText());
        button.textContent = 'copied';
        setTimeout(() => {
          button.textContent = label;
        }, 1200);
      }
    },
    label
  );
  return button;
}

function group(title, className, count, children, note) {
  if (!children || (Array.isArray(children) && !children.length)) return null;
  const section = h('section', { class: `group ${className}` });
  const button = copyButton('copy', () =>
    [...section.querySelectorAll('.item > .head > .name')].map((n) => n.textContent).join('\n')
  );
  add(section, 
    h('h3', null, title, h('span', { class: 'count' }, count), button),
    note ? h('p', { class: 'note' }, note) : null,
    ...(Array.isArray(children) ? children : [children])
  );
  return section;
}

/** Plain-text rollup, one dependency per line, ready to paste into a ticket. */
function toText(r) {
  const lines = [];
  lines.push(`API: ${r.apiLabel}  [${r.apiId}]`);
  lines.push(`Path: /${r.path || ''}`);
  if (r.serviceUrl) lines.push(`Service URL: ${r.serviceUrl}`);
  lines.push('');

  const section = (title, entries) => {
    if (!entries.length) return;
    lines.push(`${title} (${entries.length})`);
    for (const entry of entries) lines.push(`  ${entry}`);
    lines.push('');
  };

  section(
    'BACKENDS',
    r.backends.map((b) =>
      b.dynamic
        ? `${b.id}  [DYNAMIC -> ${b.candidates?.map((c) => c.id).join(', ') || 'no match'}]`
        : `${b.id}${b.url ? `  ${b.url}` : ''}${b.exists ? '' : '  [MISSING]'}`
    )
  );
  section(
    'PRODUCTS',
    r.products.map((p) => `${p.displayName}  [${p.id}]${p.state ? `  ${p.state}` : ''}`)
  );
  section(
    'POLICY FRAGMENTS',
    r.fragments.map(
      (f) =>
        `${f.id}${f.depth ? `  (nested ${f.depth})` : ''}` +
        `${f.actualName ? `  [defined as ${f.actualName}]` : ''}${f.exists ? '' : '  [MISSING]'}`
    )
  );
  section(
    'NAMED VALUES',
    r.namedValues.map((n) => {
      const suffix = n.keyVault
        ? `  [key vault ${n.keyVault.vaultName}/${n.keyVault.secretName}]`
        : n.secret
        ? '  [secret]'
        : '';
      return `${n.token}${suffix}${n.exists ? '' : '  [MISSING]'}`;
    })
  );
  section(
    'KEY VAULT SECRETS',
    r.keyVault.flatMap((v) => v.secrets.map((sec) => `${v.vaultName}/${sec.secretName}  via ${sec.source}`))
  );
  section(
    'CERTIFICATES',
    r.certificates.map((c) => `${c.id}${c.expiry ? `  expires ${c.expiry.slice(0, 10)}` : ''}`)
  );
  section(
    'VARIABLES',
    r.variables.map((v) => `${v.name}${v.readOnly ? '  [read only]' : ''}`)
  );
  section('BROKEN LINKS', [
    ...r.unresolvedNamedValues.map((u) => `{{${u.name}}}  named value not defined`),
    ...r.variableLookalikes.map((u) => `{{${u.name}}}  variable referenced as a named value`),
    ...r.backends.filter((b) => !b.exists).map((b) => `${b.id}  backend not defined`),
    ...r.fragments.filter((f) => !f.exists).map((f) => `${f.id}  fragment not defined`)
  ]);
  if (r.comparison) {
    lines.push(comparisonToText(r.comparison, r.apiLabel));
    lines.push('');
  }

  section(
    'OPERATIONS WITH THEIR OWN POLICY',
    r.operations.map((o) => `${o.method || ''} ${o.urlTemplate || ''}  ${o.displayName}`.trim())
  );

  return lines.join('\n').trimEnd();
}

/**
 * Native Element.append() stringifies null into a literal "null" text node.
 * Every group that had no note, and every category that produced no items,
 * printed one. This skips them instead.
 */
function add(parent, ...nodes) {
  for (const node of nodes) {
    if (node === null || node === undefined || node === false) continue;
    parent.append(node);
  }
  return parent;
}

/** Explains a resolved-but-differently-spelled or list-missed reference. */
function matchNote(entry) {
  const notes = [];
  if (entry.casingDiffers || entry.actualName) {
    notes.push(`defined as “${entry.actualName || entry.id}” — the policy spells it differently`);
  }
  if (entry.confirmedByLookup) {
    notes.push('not in the list response, confirmed by direct lookup');
  }
  return notes.length ? notes.join(' · ') : null;
}

/** Distinct policy documents a dependency was found in. */
function sourcesOf(refs) {
  const scopes = [...new Set((refs || []).map((o) => o.scope).filter(Boolean))];
  if (!scopes.length) return null;
  if (scopes.length <= 3) return `used in ${scopes.join(', ')}`;
  return `used in ${scopes.slice(0, 3).join(', ')} and ${scopes.length - 3} more`;
}

function item(name, opts = {}) {
  const { sub, why, missing, pill, pillColor, refs, onCopy } = opts;
  const sources = sourcesOf(refs);
  return h(
    'div',
    { class: `item${missing ? ' missing' : ''}` },
    h(
      'div',
      { class: 'head' },
      h('span', { class: 'name' }, name),
      pill ? h('span', { class: 'pill', style: pillColor ? `color:${pillColor}` : null }, pill) : null
    ),
    sub ? h('div', { class: 'sub' }, sub) : null,
    why ? h('div', { class: 'why' }, why) : null,
    sources ? h('div', { class: 'why' }, sources) : null,
    onCopy
      ? h('button', { class: 'link', type: 'button', onClick: () => copy(onCopy) }, 'copy id')
      : null,
    occurrences(refs)
  );
}

const VERDICT_TITLES = {
  missing: 'Missing in target',
  broken: 'Present but broken',
  unlinked: 'Present but not linked to this API',
  probable: 'Matched after name normalisation',
  differs: 'Present with differences'
};

function renderComparison(comparison) {
  const wrap = document.createDocumentFragment();
  const { counts } = comparison;
  const clean = comparison.blocking === 0;

  add(wrap, 
    h(
      'div',
      { class: `summary-line${clean ? ' clean' : ''}` },
      `${comparison.checked} dependencies checked against ${comparison.target} · ` +
        `${counts.missing} missing · ${counts.broken} broken · ${counts.unlinked} unlinked · ` +
        `${counts.probable} name-normalised · ` +
        (comparison.apiExistsInTarget
          ? 'the API exists in the target'
          : 'the API is not in the target yet') +
        (comparison.operations
          ? ` · operations ${comparison.operations.sourceCount} here / ` +
            `${comparison.operations.targetCount} there`
          : '')
    )
  );

  if (comparison.indexFailures?.length) {
    add(wrap, 
      h(
        'p',
        { class: 'note' },
        `Could not read ${comparison.indexFailures.join(', ')} from the target. ` +
          'Those checks were skipped rather than reported as missing.'
      )
    );
  }

  const ops = comparison.operations;
  if (ops) {
    add(
      wrap,
      group(
        'Operations missing in target',
        'g-target',
        ops.missingInTarget.length,
        ops.missingInTarget.map((o) =>
          item(o.displayName, { pill: o.method, sub: o.urlTemplate, why: o.id, missing: true })
        ),
        ops.apiAbsent ? 'The API does not exist in the target, so every operation is missing.' : null
      ),
      group(
        'Operations only in target',
        'g-product',
        ops.extraInTarget.length,
        ops.extraInTarget.map((o) =>
          item(o.displayName, {
            pill: o.method,
            sub: o.urlTemplate,
            why: 'present in target but not here — removed from source, or the target is ahead'
          })
        )
      ),
      group(
        'Operations that differ',
        'g-target',
        ops.changed.length,
        ops.changed.map((o) =>
          item(o.displayName, { pill: o.method, sub: o.differences.join(' · '), why: o.id, missing: true })
        ),
        'Same operation id, different routing. This deploys cleanly and routes wrong.'
      )
    );
  }

  if (comparison.settings?.length) {
    add(
      wrap,
      group(
        'API settings that differ',
        'g-plain',
        comparison.settings.length,
        comparison.settings.map((row) =>
          item(row.name, {
            sub: `${row.source}  →  ${row.target}`,
            why: row.expected ? 'usually expected to differ per environment' : 'likely drift',
            missing: !row.expected
          })
        )
      )
    );
  }

  for (const verdict of ['missing', 'broken', 'unlinked', 'probable', 'differs']) {
    const entries = comparison.items.filter((i) => i.verdict === verdict);
    if (!entries.length) continue;
    add(wrap, 
      group(
        VERDICT_TITLES[verdict],
        verdict === 'differs' || verdict === 'probable' ? 'g-plain' : 'g-target',
        entries.length,
        entries.map((entry) =>
          item(entry.name, {
            missing: verdict === 'missing' || verdict === 'broken',
            pill: entry.kind,
            sub: entry.detail || '',
            why: entry.targetName ? `target resource is named “${entry.targetName}”` : null
          })
        )
      )
    );
  }

  const opsClean =
    !ops || (!ops.missingInTarget.length && !ops.extraInTarget.length && !ops.changed.length);
  if (clean && opsClean && !counts.probable && !counts.differs && !comparison.settings?.length) {
    add(
      wrap,
      h('p', { class: 'note' }, 'Every dependency and operation matches in the target instance.')
    );
  }
  return wrap;
}

function renderResolved(r) {
  const frag = document.createDocumentFragment();

  add(frag, 
    h(
      'div',
      { class: 'api-meta' },
      [
        r.serviceUrl ? `serviceUrl ${r.serviceUrl}` : 'no serviceUrl',
        r.hasApiPolicy ? 'API policy' : 'no API policy',
        r.inheritsGlobal ? 'inherits <base/>' : 'no <base/>',
        `rev ${r.revision ?? '1'}`
      ].join(' · ')
    ),
    h(
      'div',
      { class: 'api-meta' },
      `rolled up from ${r.sourcesRead.filter((s) => s.hasPolicy).length} policy document(s): ` +
        `API, ${r.operations.length} operation(s), ${r.products.length} product(s), ` +
        `${r.fragments.length} fragment(s)${r.inheritsGlobal ? ', global' : ''}`
    )
  );

  const repaired = r.sourcesRead.filter((x) => x.repaired || x.parseError).length;
  if (repaired) {
    add(frag, 
      h(
        'p',
        { class: 'note' },
        `${repaired} policy document(s) were not well-formed XML and were read with the repair pass. ` +
          'Open “Policies read” below for the detail.'
      )
    );
  }

  add(frag, 
    h(
      'div',
      { class: 'row' },
      copyButton('Copy list', () => toText(r)),
      copyButton('Copy JSON', () => JSON.stringify(toExport(r), null, 2)),
      r.comparison ? copyButton('Copy gaps', () => comparisonToText(r.comparison, r.apiLabel)) : null,
      h(
        'button',
        {
          class: 'link',
          type: 'button',
          style: 'margin-left:12px',
          onClick: () => openReport([...state.resolved.values()], r.apiId)
        },
        'Open report'
      )
    )
  );

  for (const warning of r.warnings) {
    add(frag, h('p', { class: 'note' }, warning));
  }

  const rail = h('div', { class: 'rail' });
  add(frag, rail);

  if (r.comparison) add(rail, renderComparison(r.comparison));

  add(rail, 
    group(
      'Backends',
      'g-backend',
      r.backends.length,
      r.backends.map((b) =>
        b.dynamic
          ? item(b.id, {
              missing: !b.exists,
              pill: 'dynamic',
              pillColor: 'var(--c-product)',
              sub: b.candidates?.length
                ? `${b.candidates.length} possible: ${b.candidates.map((c) => c.id).join(', ')}`
                : 'built at runtime, no matching backend found',
              why: b.resolvedVia,
              refs: b.usedIn
            })
          : item(b.id, {
          missing: !b.exists,
          sub: b.url || (b.exists ? b.resourceId : 'not defined on this instance'),
          why: [
            b.title,
            matchNote(b),
            b.matchedByUrl ? 'matched from the API serviceUrl' : null,
            b.hasCredentials ? 'has credentials' : null,
            b.certificateIds?.length ? `${b.certificateIds.length} client certificate(s)` : null
          ]
            .filter(Boolean)
            .join(' · '),
          refs: b.usedIn,
          onCopy: b.id
        })
      )
    )
  );

  add(rail, 
    group(
      'Products',
      'g-product',
      r.products.length,
      r.products.map((p) =>
        item(p.displayName, {
          sub: p.id,
          pill: p.state,
          why: [
            p.subscriptionRequired ? 'subscription required' : 'open',
            p.approvalRequired ? 'approval required' : null,
            p.hasPolicy ? 'has product policy' : 'no product policy'
          ]
            .filter(Boolean)
            .join(' · ')
        })
      )
    )
  );

  add(rail, 
    group(
      'Policy fragments',
      'g-fragment',
      r.fragments.length,
      r.fragments.map((f) =>
        item(f.id, {
          missing: !f.exists,
          sub: f.description || (f.exists ? '' : 'referenced but not defined on this instance'),
          why: [f.depth ? `nested ${f.depth} level(s) deep` : 'included directly', matchNote(f)]
            .filter(Boolean)
            .join(' · '),
          refs: f.usedIn,
          onCopy: f.id
        })
      )
    )
  );

  add(rail, 
    group(
      'Named values',
      'g-namedvalue',
      r.namedValues.length,
      r.namedValues.map((nv) =>
        item(nv.token, {
          missing: !nv.exists,
          pill: nv.keyVault ? 'key vault' : nv.secret ? 'secret' : null,
          pillColor: nv.keyVault ? 'var(--c-vault)' : null,
          sub: nv.keyVault
            ? `${nv.keyVault.vaultName} / ${nv.keyVault.secretName}${nv.keyVault.pinnedVersion ? ' (pinned version)' : ''}`
            : nv.secret
            ? '•••••• stored as secret'
            : nv.value ?? (nv.exists ? '' : 'not defined on this instance'),
          why: [matchNote(nv), nv.tags?.length ? `tags: ${nv.tags.join(', ')}` : null]
            .filter(Boolean)
            .join(' · '),
          refs: nv.usedIn
        })
      ),
      'Only {{token}} references outside Liquid templates and expression brace-escapes are listed here.'
    )
  );

  add(rail, 
    group(
      'Azure Key Vault',
      'g-vault',
      r.keyVault.reduce((n, v) => n + v.secrets.length, 0),
      r.keyVault.map((vault) =>
        h(
          'div',
          { class: 'item' },
          h('div', { class: 'head' }, h('span', { class: 'name' }, vault.vaultName || 'unknown vault')),
          h('div', { class: 'sub' }, vault.vaultUri || ''),
          ...vault.secrets.map((s) =>
            h(
              'div',
              { class: 'why' },
              `${s.secretName}${s.version ? `@${s.version.slice(0, 8)}` : ''} — via ${s.source}` +
                (s.identityClientId ? ` · identity ${s.identityClientId}` : '') +
                (s.lastStatus?.code && s.lastStatus.code !== 'Success'
                  ? ` · refresh ${s.lastStatus.code}`
                  : '')
            )
          )
        )
      )
    )
  );

  add(rail, 
    group(
      'Certificates',
      'g-plain',
      r.certificates.length,
      r.certificates.map((c) =>
        item(c.id, {
          missing: !c.exists,
          sub: c.subject || '',
          why: [c.thumbprint, c.expiry ? `expires ${c.expiry.slice(0, 10)}` : null].filter(Boolean).join(' · '),
          refs: c.usedIn
        })
      )
    )
  );

  const issues = [
    ...r.unresolvedNamedValues.map((u) =>
      item(`{{${u.name}}}`, { missing: true, why: u.reason, refs: u.occurrences })
    ),
    ...r.variableLookalikes.map((u) =>
      item(`{{${u.name}}}`, { missing: true, pill: 'variable', why: u.reason, refs: u.occurrences })
    ),
    ...r.backends.filter((b) => !b.exists).map((b) => item(b.id, { missing: true, why: 'backend id not defined' })),
    ...r.fragments.filter((f) => !f.exists).map((f) => item(f.id, { missing: true, why: 'fragment not defined' }))
  ];
  add(rail, group('Broken links', 'g-issue', issues.length, issues));

  add(rail, 
    group(
      'Variables',
      'g-variable',
      r.variables.length,
      r.variables.map((v) =>
        item(v.name, {
          pill: v.readOnly ? 'read only' : 'set + read',
          why: v.readOnly
            ? 'Read but never set in the policies read here — it may come from a parent scope.'
            : `set in ${v.written.length} place(s), read in ${v.read.length}`,
          refs: [...v.written, ...v.read]
        })
      ),
      'Policy variables. These are runtime state, not named values, and are listed separately so they are never counted as configuration dependencies.'
    )
  );

  const excluded = [
    ...r.liquidTokens.map((t) => item(`{{${t.name}}}`, { pill: 'liquid', why: t.reason })),
    ...r.ambiguousTokens.map((t) => item(`{{${t.name}}}`, { pill: 'ignored', why: t.reason }))
  ];
  add(rail, 
    group(
      'Excluded moustaches',
      'g-plain',
      excluded.length,
      excluded,
      'Matched {{ }} that the classifier decided are not named values.'
    )
  );

  const other = [];
  if (r.versionSet) {
    other.push(
      item(r.versionSet.displayName || r.versionSet.id, {
        missing: !r.versionSet.exists,
        pill: 'version set',
        why: r.versionSet.versioningScheme
      })
    );
  }
  for (const a of r.auth) other.push(item(a.id, { missing: !a.exists, pill: a.kind, sub: a.detail }));
  for (const d of r.diagnostics) {
    other.push(
      item(d.loggerId || d.id, {
        pill: d.loggerType || 'logger',
        sub: d.resourceId || '',
        why: d.samplingPercentage != null ? `sampling ${d.samplingPercentage}%` : d.viaPolicy || ''
      })
    );
  }
  for (const c of r.caches) other.push(item(c, { pill: 'cache' }));
  for (const i of r.identities) other.push(item(i.resource, { pill: 'managed identity', sub: i.clientId || 'system-assigned' }));
  for (const u of r.urls) other.push(item(u.url, { pill: 'url', refs: u.usedIn }));
  add(rail, group('Other links', 'g-plain', other.length, other));

  if (r.operations.length) {
    add(rail, 
      group(
        'Operations with their own policy',
        'g-plain',
        r.operations.length,
        r.operations.map((op) =>
          item(op.displayName, {
            sub: `${op.method || ''} ${op.urlTemplate || ''}`.trim(),
            why: [
              op.analysis.namedValues.size ? `${op.analysis.namedValues.size} named value(s)` : null,
              op.analysis.backends.size ? `${op.analysis.backends.size} backend(s)` : null,
              op.analysis.fragments.size ? `${op.analysis.fragments.size} fragment(s)` : null
            ]
              .filter(Boolean)
              .join(' · ')
          })
        )
      )
    );
  }

  const read = r.sourcesRead.filter((x) => x.hasPolicy).length;
  const sourcesGroup = group(
    'Policies read',
    'g-plain',
    read,
    r.sourcesRead.map((source) =>
      item(source.label, {
        pill: source.repaired ? 'repaired' : source.scopeType,
        missing: !!source.parseError,
        sub: source.hasPolicy ? `${source.length} chars` : 'no policy at this scope',
        why: source.parseError
          ? `not well-formed: ${source.parseError.slice(0, 90)}`
          : `${source.found} dependency reference(s) found here`
      })
    ),
    `The instance defines ${r.catalogSummary.namedValues} named values, ` +
      `${r.catalogSummary.backends} backends and ${r.catalogSummary.fragments} fragments.`
  );
  if (sourcesGroup) {
    add(rail, 
      h(
        'details',
        { class: 'occurrences' },
        h('summary', null, `Policies read (${read})`),
        sourcesGroup
      )
    );
  }

  if (!rail.children.length) {
    add(rail, h('p', { class: 'note' }, 'No dependencies found for this API.'));
  }

  return frag;
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

/**
 * The panel is ~400px wide, which is fine for scanning and poor for reading.
 * The report goes to a detached window that can lay the categories out in
 * columns. The payload rides in session storage rather than the URL.
 */
async function openReport(resolvedList, focusApiId = null) {
  if (!resolvedList.length) {
    setProgress('Expand an API first');
    return;
  }
  const key = `report:${Date.now()}`;
  const payload = {
    service: state.service?.ref || null,
    target: state.targetIndex?.ref || null,
    generatedAt: new Date().toISOString(),
    // The window opens on the API you asked for, not whichever resolved first.
    focus: focusApiId,
    apis: resolvedList.map(toReport)
  };

  try {
    // Keep only the newest report so session storage does not accumulate.
    const existing = await chrome.storage.session.get(null);
    const stale = Object.keys(existing).filter((k) => k.startsWith('report:'));
    if (stale.length) await chrome.storage.session.remove(stale);

    await chrome.storage.session.set({ [key]: payload });
    // Fit the display rather than assuming one: a fixed 1180 runs off the edge
    // of a smaller screen and gets clipped.
    const width = Math.max(900, Math.min(1600, (screen.availWidth || 1440) - 120));
    const height = Math.max(600, Math.min(1050, (screen.availHeight || 900) - 80));
    await chrome.windows.create({
      url: chrome.runtime.getURL(`src/report.html?key=${encodeURIComponent(key)}`),
      type: 'popup',
      width,
      height,
      left: 40,
      top: 30
    });
  } catch (err) {
    setProgress(`Could not open the report: ${err.message}`);
  }
}

const reportAllButton = h(
  'button',
  {
    class: 'ghost small',
    type: 'button',
    title: 'Open every resolved API in a report window',
    onClick: () =>
      openReport([...state.resolved.values()], state.lastExpanded || null)
  },
  'Report'
);
els.export.before(reportAllButton);

function setProgress(message) {
  els.progress.textContent = message || '';
}

function updateCounters() {
  const parts = [];
  if (state.apis.length) parts.push(`${state.apis.length} APIs`);
  if (state.resolved.size) parts.push(`${state.resolved.size} resolved`);
  parts.push(`${client.stats.requests} calls`);
  els.counters.textContent = parts.join(' · ');
}

function showError(err) {
  els.setupError.hidden = false;
  els.setupError.textContent = err.message;
  els.setup.hidden = false;
}

function hideError() {
  els.setupError.hidden = true;
}

function exportResolved() {
  if (!state.resolved.size) {
    setProgress('Expand at least one API before exporting');
    return;
  }
  const payload = {
    service: state.service?.ref,
    apiVersion: state.apiVersion,
    generatedAt: new Date().toISOString(),
    target: state.targetIndex?.ref || null,
    apis: [...state.resolved.values()].map((r) => ({
      ...toExport(r),
      targetGaps: r.comparison
        ? {
            target: r.comparison.target,
            apiExistsInTarget: r.comparison.apiExistsInTarget,
            counts: r.comparison.counts,
            items: r.comparison.items.filter((i) => i.verdict !== 'present')
          }
        : null
    }))
  };
  download(
    `apim-dependencies-${state.service?.ref?.serviceName || 'export'}.json`,
    JSON.stringify(payload, null, 2)
  );
}
