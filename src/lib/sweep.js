/**
 * Instance-wide sweep and reverse dependency index.
 *
 * Everything else in this extension is lazy: you expand one API and it resolves
 * that one. Reverse lookup cannot work that way — to answer "which APIs use
 * backend X" you must have looked at every API. So this is the one deliberately
 * expensive operation, and it is built to be interruptible, resumable and
 * polite to the ARM budget it shares with the user's own portal session.
 *
 * Cost is roughly 1 + N x (API policy + operations list + operation policies +
 * products). Fragments and product policies are cached across APIs by the
 * resolver, so a fragment shared by forty APIs is fetched once.
 */

import { loadCatalog, resolveApi } from './resolver.js';

export const SWEEP_KEY = 'sweepIndex';
export const SWEEP_VERSION = 3;

/** Dependency classes the reverse index covers. */
export const INDEX_KINDS = [
  'backends',
  'namedValues',
  'fragments',
  'products',
  'certificates',
  'keyVault',
  'loggers'
];

const KIND_LABEL = {
  backends: 'backend',
  namedValues: 'named value',
  fragments: 'policy fragment',
  products: 'product',
  certificates: 'certificate',
  keyVault: 'Key Vault secret',
  loggers: 'logger'
};

export const kindLabel = (kind) => KIND_LABEL[kind] || kind;

/**
 * Pulls the indexable references out of one resolved API.
 *
 * `via` records which policy document introduced the reference, so the index
 * can answer "used by 12 APIs, 3 of them only through fragment X" — which is
 * the form a change review actually needs.
 */
function extractReferences(resolved) {
  const out = [];
  const push = (kind, id, entry = {}) => {
    if (!id) return;
    out.push({ kind, id: String(id), ...entry });
  };

  const scopesOf = (usedIn) => [...new Set((usedIn || []).map((o) => o.scope).filter(Boolean))];

  for (const backend of resolved.backends || []) {
    if (backend.dynamic) {
      // A dynamic backend-id can select any candidate at runtime, so every
      // candidate is a real dependency of this API.
      for (const candidate of backend.candidates || []) {
        push('backends', candidate.id, {
          via: scopesOf(backend.usedIn),
          dynamic: true,
          expression: backend.id
        });
      }
      continue;
    }
    push('backends', backend.id, { via: scopesOf(backend.usedIn), missing: !backend.exists });
  }

  for (const nv of resolved.namedValues || []) {
    push('namedValues', nv.token, {
      via: scopesOf(nv.usedIn),
      missing: !nv.exists,
      secret: !!nv.secret,
      keyVault: nv.keyVault ? `${nv.keyVault.vaultName}/${nv.keyVault.secretName}` : null
    });
  }

  for (const fragment of resolved.fragments || []) {
    push('fragments', fragment.id, {
      via: scopesOf(fragment.usedIn),
      missing: !fragment.exists,
      depth: fragment.depth
    });
  }

  for (const product of resolved.products || []) {
    push('products', product.id, { displayName: product.displayName, state: product.state });
  }

  for (const cert of resolved.certificates || []) {
    push('certificates', cert.id, { missing: !cert.exists, expiry: cert.expiry || null });
  }

  for (const vault of resolved.keyVault || []) {
    for (const secret of vault.secrets || []) {
      push('keyVault', `${vault.vaultName}/${secret.secretName}`, {
        source: secret.source,
        refreshStatus: secret.lastStatus?.code || null
      });
    }
  }

  for (const diagnostic of resolved.diagnostics || []) {
    push('loggers', diagnostic.loggerId, { loggerType: diagnostic.loggerType || null });
  }

  return out;
}

/** Compact, serialisable summary of one API. The full resolution is not kept. */
function summarize(resolved) {
  return {
    apiId: resolved.apiId,
    apiLabel: resolved.apiLabel,
    path: resolved.path,
    serviceUrl: resolved.serviceUrl || null,
    operations: (resolved.allOperations || []).length,
    counts: resolved.counts,
    references: extractReferences(resolved)
  };
}

/**
 * Sweeps every API and builds the reverse index.
 *
 * @param {object} options
 * @param {ApimService} options.svc
 * @param {Array} options.apis                list from svc.listApis()
 * @param {boolean} options.includeOperations read operation policies (slower, accurate)
 * @param {object|null} options.resume        a previous partial sweep to continue
 * @param {() => boolean} options.shouldStop  polled between APIs so the UI can cancel
 * @param {(progress) => void} options.onProgress
 */
export async function runSweep({
  svc,
  apis,
  includeOperations = true,
  resume = null,
  shouldStop = () => false,
  onProgress = () => {}
} = {}) {
  const started = Date.now();
  const done = new Map(
    (resume?.apis || []).map((entry) => [entry.apiId, entry])
  );
  const failures = [...(resume?.failures || [])];

  const catalog = await loadCatalog(svc, (message) =>
    onProgress({ phase: 'catalog', message, completed: done.size, total: apis.length })
  );

  let stopped = false;

  for (const [position, api] of apis.entries()) {
    if (shouldStop()) {
      stopped = true;
      break;
    }
    if (done.has(api.name)) continue;

    onProgress({
      phase: 'apis',
      message: api.properties?.displayName || api.name,
      completed: done.size,
      total: apis.length,
      position,
      elapsedMs: Date.now() - started
    });

    try {
      const resolved = await resolveApi(
        svc,
        catalog,
        api,
        { includeOperations, includeProducts: true },
        () => {}
      );
      done.set(api.name, summarize(resolved));
    } catch (err) {
      // A token expiring mid-sweep should stop cleanly and keep what it has,
      // not discard several minutes of work.
      if (err.name === 'AuthError') {
        return {
          ...buildSweep(svc, [...done.values()], failures, { includeOperations, started }),
          complete: false,
          stoppedReason: 'auth',
          error: err.message
        };
      }
      failures.push({ apiId: api.name, label: api.properties?.displayName || api.name, error: err.message });
    }
  }

  return {
    ...buildSweep(svc, [...done.values()], failures, { includeOperations, started }),
    complete: !stopped && done.size + failures.length >= apis.length,
    stoppedReason: stopped ? 'cancelled' : null
  };
}

function buildSweep(svc, apiSummaries, failures, { includeOperations, started }) {
  return {
    version: SWEEP_VERSION,
    service: svc.ref,
    serviceName: svc.ref.serviceName,
    apiVersion: svc.apiVersion,
    includeOperations,
    sweptAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    apis: apiSummaries,
    failures
  };
}

/**
 * Inverts the sweep: dependency -> the APIs that use it.
 * Pure and fast, so it is rebuilt on load rather than persisted.
 */
export function buildReverseIndex(sweep) {
  const index = new Map();
  for (const kind of INDEX_KINDS) index.set(kind, new Map());

  for (const api of sweep.apis || []) {
    for (const ref of api.references || []) {
      const byKind = index.get(ref.kind);
      if (!byKind) continue;
      const key = ref.id.toLowerCase();
      if (!byKind.has(key)) {
        byKind.set(key, { id: ref.id, kind: ref.kind, users: [], flags: {} });
      }
      const entry = byKind.get(key);
      entry.users.push({
        apiId: api.apiId,
        apiLabel: api.apiLabel,
        path: api.path,
        via: ref.via || [],
        dynamic: !!ref.dynamic,
        expression: ref.expression || null
      });
      if (ref.missing) entry.flags.missing = true;
      if (ref.secret) entry.flags.secret = true;
      if (ref.keyVault) entry.flags.keyVault = ref.keyVault;
      if (ref.expiry) entry.flags.expiry = ref.expiry;
      if (ref.refreshStatus && ref.refreshStatus !== 'Success') {
        entry.flags.refreshStatus = ref.refreshStatus;
      }
      if (ref.displayName) entry.flags.displayName = ref.displayName;
      if (ref.loggerType) entry.flags.loggerType = ref.loggerType;
    }
  }
  return index;
}

/** Everything defined on the instance that no API references. */
export function findOrphans(sweep, catalogCounts) {
  const index = buildReverseIndex(sweep);
  const orphans = {};
  for (const [kind, defined] of Object.entries(catalogCounts || {})) {
    if (!Array.isArray(defined)) continue;
    const used = index.get(kind);
    orphans[kind] = defined.filter((name) => !used?.has(String(name).toLowerCase()));
  }
  return orphans;
}

/**
 * Certificates and Key Vault secrets worth attention, with the APIs affected —
 * which is what turns "this expires in 12 days" into an actionable ticket.
 */
export function findExpiringOrBroken(sweep, withinDays = 45) {
  const index = buildReverseIndex(sweep);
  const out = [];

  for (const entry of index.get('certificates')?.values() || []) {
    if (!entry.flags.expiry) continue;
    const days = Math.round((new Date(entry.flags.expiry).getTime() - Date.now()) / 86400000);
    if (days > withinDays) continue;
    out.push({
      kind: 'certificate',
      id: entry.id,
      detail: days < 0 ? `expired ${Math.abs(days)} days ago` : `expires in ${days} days`,
      severity: days < 0 ? 'expired' : days <= 14 ? 'urgent' : 'soon',
      users: entry.users
    });
  }

  for (const entry of index.get('keyVault')?.values() || []) {
    if (!entry.flags.refreshStatus) continue;
    out.push({
      kind: 'Key Vault secret',
      id: entry.id,
      detail: `refresh failing: ${entry.flags.refreshStatus}`,
      severity: 'urgent',
      users: entry.users
    });
  }

  const order = { expired: 0, urgent: 1, soon: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity] || b.users.length - a.users.length);
}

/** Flat, ranked rows for the reverse-lookup table. */
export function queryIndex(sweep, { kind = 'backends', term = '' } = {}) {
  const index = buildReverseIndex(sweep);
  const byKind = index.get(kind);
  if (!byKind) return [];
  const needle = term.trim().toLowerCase();

  return [...byKind.values()]
    .filter((entry) => !needle || entry.id.toLowerCase().includes(needle))
    .map((entry) => {
      const direct = entry.users.filter((u) => u.via.some((v) => /API policy|operation/i.test(v)));
      return {
        ...entry,
        userCount: entry.users.length,
        directCount: direct.length,
        indirectCount: entry.users.length - direct.length
      };
    })
    .sort((a, b) => b.userCount - a.userCount || a.id.localeCompare(b.id));
}

export function sweepToText(sweep, rows, kind) {
  const lines = [
    `REVERSE LOOKUP — ${kindLabel(kind)}s in ${sweep.serviceName}`,
    `Swept ${sweep.apis.length} APIs on ${new Date(sweep.sweptAt).toLocaleString()}` +
      (sweep.includeOperations ? '' : ' (operation policies skipped)'),
    ''
  ];
  for (const row of rows) {
    lines.push(`${row.id}  — used by ${row.userCount} API(s)`);
    for (const user of row.users) {
      lines.push(`    ${user.apiLabel}${user.via.length ? `  [via ${user.via.join(', ')}]` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export async function saveSweep(sweep) {
  await chrome.storage.local.set({ [SWEEP_KEY]: sweep });
}

export async function loadSweep(ref) {
  const stored = await chrome.storage.local.get(SWEEP_KEY);
  const sweep = stored?.[SWEEP_KEY];
  if (!sweep || sweep.version !== SWEEP_VERSION) return null;
  // An index built against a different instance is worse than none.
  if (ref && sweep.service?.serviceName?.toLowerCase() !== ref.serviceName?.toLowerCase()) {
    return null;
  }
  return sweep;
}

export async function clearSweep() {
  await chrome.storage.local.remove(SWEEP_KEY);
}

/** Plain-English age, since a stale index is the main hazard here. */
export function sweepAge(sweep) {
  if (!sweep?.sweptAt) return null;
  const ms = Date.now() - new Date(sweep.sweptAt).getTime();
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
