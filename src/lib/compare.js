/**
 * Compares the dependencies resolved for one API against a target instance.
 *
 * Checking a target is cheap: the API does not need to exist there, and the
 * whole instance is indexed with one pass of list calls that is reused for
 * every API compared afterwards.
 *
 * Three kinds of gap, in descending order of how much they hurt:
 *   missing  — the dependency is not in the target at all; deployment blocks
 *   broken   — present but unusable: Key Vault refresh failing, cert expiring
 *   unlinked — present, but this API is not attached to it (products)
 *   probable — matched only after environment prefixes were normalised away
 *   differs  — present with a different value or URL; usually expected, worth a look
 */

export const DEFAULT_ENV_PATTERN =
  '(^|[-_.])(dev|develop|development|test|tst|qa|uat|sit|stg|stage|staging|preprod|prod|prd|nonprod)([-_.]|$)';

export const SEVERITY = {
  missing: 0,
  broken: 1,
  unlinked: 2,
  probable: 3,
  differs: 4,
  present: 5
};

/** Lowercases, strips environment tokens, then drops separators. */
export function normalize(name, pattern) {
  let out = String(name || '').toLowerCase();
  if (pattern) {
    try {
      out = out.replace(new RegExp(pattern, 'gi'), '-');
    } catch {
      /* an invalid user pattern should not break the compare */
    }
  }
  return out.replace(/[-_.\s]+/g, '');
}

function buildIndex(items, keyFn) {
  const exact = new Map();
  for (const item of items || []) {
    const key = keyFn(item);
    if (key) exact.set(String(key).toLowerCase(), item);
  }
  return { exact, items: items || [], keyFn, loose: null, loosePattern: null };
}

function lookup(index, name, pattern) {
  if (!index || !name) return { item: null, exact: false };
  const hit = index.exact.get(String(name).toLowerCase());
  if (hit) return { item: hit, exact: true };

  if (!index.loose || index.loosePattern !== pattern) {
    index.loose = new Map();
    index.loosePattern = pattern;
    for (const item of index.items) {
      const key = normalize(index.keyFn(item), pattern);
      if (key && !index.loose.has(key)) index.loose.set(key, item);
    }
  }
  const near = index.loose.get(normalize(name, pattern));
  return { item: near || null, exact: false };
}

const safe = async (fn) => {
  try {
    return await fn();
  } catch {
    return null;
  }
};

/**
 * One pass over the target instance. Reused for every API compared against it.
 */
export async function loadTargetIndex(svc, onProgress = () => {}) {
  onProgress('Indexing target instance');
  const [namedValues, backends, fragments, certificates, loggers, products, versionSets] =
    await Promise.all([
      safe(() => svc.listNamedValues()),
      safe(() => svc.listBackends()),
      safe(() => svc.listPolicyFragments()),
      safe(() => svc.listCertificates()),
      safe(() => svc.listLoggers()),
      safe(() => svc.listProducts()),
      safe(() => svc.listApiVersionSets())
    ]);

  return {
    ref: svc.ref,
    serviceName: svc.ref.serviceName,
    namedValues: buildIndex(namedValues, (nv) => nv.properties?.displayName || nv.name),
    backends: buildIndex(backends, (b) => b.name),
    fragments: buildIndex(fragments, (f) => f.name),
    certificates: buildIndex(certificates, (c) => c.name),
    loggers: buildIndex(loggers, (l) => l.name),
    products: buildIndex(products, (p) => p.name),
    versionSets: buildIndex(versionSets, (v) => v.name),
    counts: {
      namedValues: namedValues?.length ?? 0,
      backends: backends?.length ?? 0,
      fragments: fragments?.length ?? 0,
      certificates: certificates?.length ?? 0,
      loggers: loggers?.length ?? 0,
      products: products?.length ?? 0
    },
    failures: [
      !namedValues && 'named values',
      !backends && 'backends',
      !fragments && 'policy fragments',
      !certificates && 'certificates',
      !loggers && 'loggers',
      !products && 'products'
    ].filter(Boolean)
  };
}

const daysUntil = (iso) => {
  if (!iso) return null;
  return Math.round((new Date(iso).getTime() - Date.now()) / 86400000);
};

/** Two-way operation diff. The API must already be known to exist in target. */
async function diffOperations(targetSvc, resolved) {
  const targetOps = await safe(() => targetSvc.listOperations(resolved.apiId));
  if (!targetOps) return null;

  const shape = (op) => ({
    id: op.name,
    displayName: op.properties?.displayName || op.name,
    method: (op.properties?.method || '').toUpperCase(),
    urlTemplate: op.properties?.urlTemplate || ''
  });

  const source = resolved.allOperations || [];
  const target = targetOps.map(shape);
  const byId = (list) => new Map(list.map((o) => [o.id.toLowerCase(), o]));
  const sourceById = byId(source);
  const targetById = byId(target);

  const missingInTarget = source.filter((o) => !targetById.has(o.id.toLowerCase()));
  const extraInTarget = target.filter((o) => !sourceById.has(o.id.toLowerCase()));

  const changed = [];
  for (const op of source) {
    const match = targetById.get(op.id.toLowerCase());
    if (!match) continue;
    const differences = [];
    if (op.method !== match.method) differences.push(`method ${op.method} vs ${match.method}`);
    if (op.urlTemplate !== match.urlTemplate) {
      differences.push(`template ${op.urlTemplate} vs ${match.urlTemplate}`);
    }
    if (differences.length) changed.push({ ...op, target: match, differences });
  }

  return {
    sourceCount: source.length,
    targetCount: target.length,
    missingInTarget,
    extraInTarget,
    changed
  };
}

/** API-level settings that route traffic, so a mismatch deploys clean and behaves wrong. */
function diffSettings(resolved, targetApi) {
  if (!targetApi) return [];
  const p = targetApi.properties || {};
  const rows = [
    ['path', resolved.path, p.path],
    ['serviceUrl', resolved.serviceUrl, p.serviceUrl],
    ['protocols', (resolved.protocols || []).join(', '), (p.protocols || []).join(', ')],
    ['subscriptionRequired', resolved.subscriptionRequired, p.subscriptionRequired],
    ['apiVersion', resolved.version, p.apiVersion],
    ['apiRevision', resolved.revision, p.apiRevision]
  ];
  return rows
    .filter(([, a, b]) => {
      const left = a === undefined || a === null ? '' : String(a);
      const right = b === undefined || b === null ? '' : String(b);
      return left !== right;
    })
    .map(([name, a, b]) => ({
      name,
      source: a === undefined || a === null || a === '' ? '(not set)' : String(a),
      target: b === undefined || b === null || b === '' ? '(not set)' : String(b),
      // A differing serviceUrl is the point of having environments. A differing
      // path or protocol set is almost always drift.
      expected: name === 'serviceUrl' || name === 'apiRevision'
    }));
}

export async function compareApi(targetSvc, index, resolved, options = {}) {
  const pattern = options.pattern ?? DEFAULT_ENV_PATTERN;
  const expiryWarningDays = options.expiryWarningDays ?? 30;
  const items = [];

  const add = (entry) => items.push(entry);

  const check = (kind, name, indexName, extra = () => ({})) => {
    const { item, exact } = lookup(index[indexName], name, pattern);
    if (!item) {
      add({ kind, name, verdict: 'missing', detail: `not defined in ${index.serviceName}` });
      return null;
    }
    const targetName = index[indexName].keyFn(item);
    const base = {
      kind,
      name,
      targetName: targetName !== name ? targetName : null,
      normalised: !exact,
      verdict: exact ? 'present' : 'probable',
      detail: exact ? null : `matched “${targetName}” after ignoring environment naming`
    };
    const override = extra(item, base) || {};
    // A check that downgrades the verdict must not lose the fact that the names
    // only matched after normalisation.
    if (!exact && override.verdict && override.verdict !== 'probable' && override.detail) {
      override.detail = `${override.detail} · matched after ignoring environment naming`;
    }
    add(Object.assign(base, override));
    return item;
  };

  // --- named values ---------------------------------------------------------
  for (const nv of resolved.namedValues) {
    check('named value', nv.token, 'namedValues', (item, base) => {
      const targetKv = item.properties?.keyVault;
      const status = targetKv?.lastStatus?.code;
      if (targetKv && status && status !== 'Success') {
        return { verdict: 'broken', detail: `Key Vault refresh failing in target: ${status}` };
      }
      if (nv.keyVault && !targetKv) {
        return { verdict: 'differs', detail: 'Key Vault backed in source, plain value in target' };
      }
      if (!nv.keyVault && targetKv) {
        return { verdict: 'differs', detail: 'plain value in source, Key Vault backed in target' };
      }
      if (targetKv && nv.keyVault) {
        const from = `${nv.keyVault.vaultName}/${nv.keyVault.secretName}`;
        const to = targetKv.secretIdentifier || '';
        return { detail: `${base.detail ? base.detail + ' · ' : ''}source secret ${from}`, targetSecret: to };
      }
      const sourceValue = nv.value;
      const targetValue = item.properties?.value;
      if (
        !nv.secret &&
        !item.properties?.secret &&
        sourceValue != null &&
        targetValue != null &&
        sourceValue !== targetValue
      ) {
        return { verdict: 'differs', detail: `value differs: “${sourceValue}” vs “${targetValue}”` };
      }
      return {};
    });
  }

  // --- backends -------------------------------------------------------------
  for (const backend of resolved.backends) {
    check('backend', backend.id, 'backends', (item) => {
      const targetUrl = item.properties?.url;
      if (backend.url && targetUrl && backend.url !== targetUrl) {
        return { verdict: 'differs', detail: `url differs: ${backend.url} vs ${targetUrl}` };
      }
      if (backend.url && targetUrl && backend.url === targetUrl) {
        return { verdict: 'differs', detail: `same url in both instances: ${targetUrl}` };
      }
      return {};
    });
  }

  // --- fragments ------------------------------------------------------------
  for (const fragment of resolved.fragments) {
    check('policy fragment', fragment.id, 'fragments');
  }

  // --- certificates ---------------------------------------------------------
  for (const cert of resolved.certificates) {
    check('certificate', cert.id, 'certificates', (item) => {
      const days = daysUntil(item.properties?.expirationDate);
      if (days !== null && days < 0) {
        return { verdict: 'broken', detail: `expired ${Math.abs(days)} days ago in target` };
      }
      if (days !== null && days <= expiryWarningDays) {
        return { verdict: 'broken', detail: `expires in ${days} days in target` };
      }
      return {};
    });
  }

  // --- loggers --------------------------------------------------------------
  for (const diagnostic of resolved.diagnostics) {
    if (!diagnostic.loggerId) continue;
    check('logger', diagnostic.loggerId, 'loggers');
  }

  // --- version set ----------------------------------------------------------
  if (resolved.versionSet) {
    check('version set', resolved.versionSet.id, 'versionSets');
  }

  // --- products, plus whether this API is actually attached -----------------
  const targetApi = await safe(() => targetSvc.getApi(resolved.apiId));
  let linked = null;
  if (targetApi) {
    const attached = await safe(() => targetSvc.listApiProducts(resolved.apiId));
    linked = new Set((attached || []).map((p) => String(p.name).toLowerCase()));
  }

  for (const product of resolved.products) {
    check('product', product.id, 'products', (item) => {
      if (linked && !linked.has(String(item.name).toLowerCase())) {
        return {
          verdict: 'unlinked',
          detail: `product exists in target but ${resolved.apiId} is not attached to it`
        };
      }
      return {};
    });
  }

  const operations =
    options.compareOperations === false
      ? null
      : targetApi
      ? await diffOperations(targetSvc, resolved)
      : {
          sourceCount: (resolved.allOperations || []).length,
          targetCount: 0,
          missingInTarget: resolved.allOperations || [],
          extraInTarget: [],
          changed: [],
          apiAbsent: true
        };

  const settings = diffSettings(resolved, targetApi);

  items.sort(
    (a, b) =>
      SEVERITY[a.verdict] - SEVERITY[b.verdict] ||
      a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name)
  );

  const counts = { missing: 0, broken: 0, unlinked: 0, probable: 0, differs: 0, present: 0 };
  for (const entry of items) counts[entry.verdict]++;

  return {
    target: index.serviceName,
    targetRef: index.ref,
    apiExistsInTarget: !!targetApi,
    checked: items.length,
    counts,
    blocking:
      counts.missing +
      counts.broken +
      (operations?.missingInTarget.length || 0) +
      (operations?.changed.length || 0),
    items,
    operations,
    settings,
    indexFailures: index.failures
  };
}

/** Plain-text gap report, ready to paste. */
export function comparisonToText(comparison, apiLabel) {
  const lines = [`TARGET GAPS — ${apiLabel} vs ${comparison.target}`];
  lines.push(
    comparison.apiExistsInTarget
      ? 'The API exists in the target.'
      : 'The API does not exist in the target yet.'
  );
  lines.push(
    `${comparison.checked} dependencies checked · ${comparison.counts.missing} missing · ` +
      `${comparison.counts.broken} broken · ${comparison.counts.unlinked} unlinked · ` +
      `${comparison.counts.probable} name-normalised`
  );
  lines.push('');

  const order = ['missing', 'broken', 'unlinked', 'probable', 'differs'];
  const titles = {
    missing: 'MISSING IN TARGET',
    broken: 'PRESENT BUT BROKEN',
    unlinked: 'PRESENT BUT NOT LINKED TO THIS API',
    probable: 'MATCHED AFTER NAME NORMALISATION',
    differs: 'PRESENT WITH DIFFERENCES'
  };

  if (comparison.operations) {
    const ops = comparison.operations;
    lines.push(
      `OPERATIONS — ${ops.sourceCount} here, ${ops.targetCount} in target` +
        (ops.apiAbsent ? ' (the API itself is absent)' : '')
    );
    const opLine = (o) => `  ${o.method} ${o.urlTemplate}  [${o.id}]`;
    if (ops.missingInTarget.length) {
      lines.push(`  Missing in target (${ops.missingInTarget.length}):`);
      for (const o of ops.missingInTarget) lines.push(opLine(o));
    }
    if (ops.extraInTarget.length) {
      lines.push(`  Only in target (${ops.extraInTarget.length}):`);
      for (const o of ops.extraInTarget) lines.push(opLine(o));
    }
    if (ops.changed.length) {
      lines.push(`  Different in target (${ops.changed.length}):`);
      for (const o of ops.changed) lines.push(`  [${o.id}] ${o.differences.join(' · ')}`);
    }
    if (!ops.missingInTarget.length && !ops.extraInTarget.length && !ops.changed.length) {
      lines.push('  Identical.');
    }
    lines.push('');
  }

  if (comparison.settings?.length) {
    lines.push(`API SETTINGS THAT DIFFER (${comparison.settings.length})`);
    for (const row of comparison.settings) {
      lines.push(
        `  ${row.name}: ${row.source} vs ${row.target}${row.expected ? '  (expected per environment)' : ''}`
      );
    }
    lines.push('');
  }

  for (const verdict of order) {
    const group = comparison.items.filter((i) => i.verdict === verdict);
    if (!group.length) continue;
    lines.push(`${titles[verdict]} (${group.length})`);
    for (const entry of group) {
      lines.push(
        `  [${entry.kind}] ${entry.name}` +
          `${entry.targetName ? ` -> ${entry.targetName}` : ''}` +
          `${entry.detail ? `  — ${entry.detail}` : ''}`
      );
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
