import { analyzePolicy, mergeAnalyses, namedValuesInString } from './policy-analyzer.js';
import { Pool, shortId } from './util.js';

/**
 * Loads the service-wide lookup tables once, then reuses them for every API.
 * Named values must be loaded before any policy is analysed — the classifier
 * needs the real list to tell a named value from a false positive.
 */
export async function loadCatalog(svc, onProgress = () => {}) {
  const step = async (label, fn) => {
    onProgress(label);
    try {
      return await fn();
    } catch (err) {
      if (err.name === 'AuthError') throw err;
      onProgress(`${label} unavailable (${err.message})`);
      return [];
    }
  };

  const [namedValues, backends, fragments, certificates, loggers, authServers, openIdProviders, versionSets, caches] =
    await Promise.all([
      step('Reading named values', () => svc.listNamedValues()),
      step('Reading backends', () => svc.listBackends()),
      step('Reading policy fragments', () => svc.listPolicyFragments()),
      step('Reading certificates', () => svc.listCertificates()),
      step('Reading loggers', () => svc.listLoggers()),
      step('Reading authorization servers', () => svc.listAuthorizationServers()),
      step('Reading OpenID providers', () => svc.listOpenIdConnectProviders()),
      step('Reading version sets', () => svc.listApiVersionSets()),
      step('Reading caches', () => svc.listCaches())
    ]);

  const byName = (items) => new Map(items.map((i) => [i.name, i]));
  const byLowerName = (items) => new Map(items.map((i) => [String(i.name).toLowerCase(), i]));

  const namedValueByToken = new Map();
  for (const nv of namedValues) {
    const token = nv.properties?.displayName || nv.name;
    namedValueByToken.set(token, nv);
    if (nv.name && !namedValueByToken.has(nv.name)) namedValueByToken.set(nv.name, nv);
  }

  const catalog = {
    namedValues,
    namedValueByToken,
    knownNamedValues: new Set(namedValueByToken.keys()),
    backends: byName(backends),
    fragments: byName(fragments),
    certificates: byName(certificates),
    loggers: byName(loggers),
    authServers: byName(authServers),
    openIdProviders: byName(openIdProviders),
    versionSets: byName(versionSets),
    caches,
    // ARM resource names are case-insensitive, so a policy may reference
    // "Common-Auth" while the resource is named "common-auth". Matching only on
    // the exact string reports live dependencies as missing.
    ci: {
      backends: byLowerName(backends),
      fragments: byLowerName(fragments),
      certificates: byLowerName(certificates),
      loggers: byLowerName(loggers),
      authServers: byLowerName(authServers),
      openIdProviders: byLowerName(openIdProviders),
      versionSets: byLowerName(versionSets),
      namedValues: new Map(
        namedValues.map((nv) => [String(nv.properties?.displayName || nv.name).toLowerCase(), nv])
      )
    },
    verified: new Map(),
    fragmentAnalyses: new Map(),
    productAnalyses: new Map(),
    globalAnalysis: null
  };

  onProgress('Reading global policy');
  try {
    const globalXml = await svc.getGlobalPolicy();
    catalog.globalPolicyXml = globalXml;
    catalog.globalAnalysis = stamp(
      analyzePolicy(globalXml, {
        scope: 'global',
        scopeType: 'global',
        label: 'All APIs (global policy)',
        knownNamedValues: catalog.knownNamedValues
      })
    );
  } catch {
    catalog.globalAnalysis = null;
  }

  return catalog;
}

/**
 * Exact match first, then case-insensitive. Returns the item plus whether the
 * reference in the policy is spelled differently from the resource.
 */
export function lookupCatalog(catalog, kind, id) {
  if (!id) return { item: null, casingDiffers: false };
  const exact = catalog[kind]?.get(id);
  if (exact) return { item: exact, casingDiffers: false };
  const loose = catalog.ci?.[kind]?.get(String(id).toLowerCase());
  if (loose) return { item: loose, casingDiffers: true };
  return { item: null, casingDiffers: false };
}

/**
 * Last check before calling a reference broken: ask ARM directly. Covers a list
 * response that was filtered, paged oddly, or is simply stale.
 */
async function confirmExists(catalog, kind, id, fetcher) {
  const key = `${kind}:${String(id).toLowerCase()}`;
  if (catalog.verified.has(key)) return catalog.verified.get(key);
  let result = null;
  try {
    result = await fetcher();
  } catch {
    result = null;
  }
  catalog.verified.set(key, result);
  return result;
}

function stamp(analysis) {
  for (const key of Object.keys(analysis)) {
    const value = analysis[key];
    if (!(value instanceof Map)) continue;
    for (const entry of value.values()) {
      for (const occurrence of entry.occurrences || []) {
        occurrence.scope = occurrence.scope || analysis.label;
        occurrence.scopeType = occurrence.scopeType || analysis.scopeType;
      }
    }
  }
  return analysis;
}

async function analyzeFragment(svc, catalog, fragmentId, depth, seen, out) {
  if (seen.has(fragmentId) || depth > 6) return;
  seen.add(fragmentId);

  const found = lookupCatalog(catalog, 'fragments', fragmentId);

  let analysis = catalog.fragmentAnalyses.get(fragmentId);
  let resource = found.item || null;
  if (!analysis) {
    // One GET gives both the policy body and proof the fragment exists.
    const fetched = await confirmExists(catalog, 'fragments', fragmentId, () =>
      svc.getPolicyFragment(fragmentId)
    );
    resource = resource || fetched;
    analysis = stamp(
      analyzePolicy(fetched?.properties?.value ?? null, {
        scope: `fragment:${fragmentId}`,
        scopeType: 'fragment',
        label: `fragment “${fragmentId}”`,
        knownNamedValues: catalog.knownNamedValues
      })
    );
    catalog.fragmentAnalyses.set(fragmentId, analysis);
    catalog.fragmentResources = catalog.fragmentResources || new Map();
    if (resource) catalog.fragmentResources.set(fragmentId, resource);
  } else {
    resource = resource || catalog.fragmentResources?.get(fragmentId) || null;
  }

  out.push({
    id: fragmentId,
    depth,
    exists: !!resource,
    actualName: resource?.name && resource.name !== fragmentId ? resource.name : null,
    casingDiffers: found.casingDiffers,
    confirmedByLookup: !found.item && !!resource,
    description: resource?.properties?.description || null,
    analysis
  });

  for (const nested of analysis.fragments.keys()) {
    await analyzeFragment(svc, catalog, nested, depth + 1, seen, out);
  }
}

function parseSecretIdentifier(secretIdentifier) {
  try {
    const url = new URL(secretIdentifier);
    const [, kind, secretName, version] = url.pathname.split('/');
    return {
      vaultName: url.hostname.split('.')[0],
      vaultUri: `${url.protocol}//${url.hostname}`,
      kind: kind || 'secrets',
      secretName: secretName || null,
      version: version || null,
      pinnedVersion: !!version
    };
  } catch {
    return { vaultName: null, vaultUri: null, secretName: null, version: null, raw: secretIdentifier };
  }
}

/**
 * Resolves everything one API depends on. Called only when a row is expanded.
 */
export async function resolveApi(svc, catalog, api, opts = {}, onProgress = () => {}) {
  const { includeOperations = true, includeProducts = true } = opts;
  const apiId = api.name;
  const apiLabel = api.properties?.displayName || apiId;
  const pool = new Pool(5);
  const analyses = [];
  const warnings = [];

  onProgress('Reading API policy');
  let apiXml = null;
  try {
    apiXml = await svc.getApiPolicy(apiId);
  } catch (err) {
    if (err.name === 'AuthError') throw err;
    warnings.push(`API policy could not be read: ${err.message}`);
  }
  const apiAnalysis = stamp(
    analyzePolicy(apiXml, {
      scope: `api:${apiId}`,
      scopeType: 'api',
      label: 'API policy',
      knownNamedValues: catalog.knownNamedValues
    })
  );
  analyses.push(apiAnalysis);

  // --- operations -----------------------------------------------------------
  // Always list operations, even when policy reading is off: the list is one
  // call and the target comparison needs the full set, not just the ones that
  // happen to carry a policy.
  const operations = [];
  onProgress('Listing operations');
  let ops = [];
  try {
    ops = await svc.listOperations(apiId);
  } catch (err) {
    warnings.push(`Operations could not be listed: ${err.message}`);
  }
  const allOperations = ops.map((op) => ({
    id: op.name,
    displayName: op.properties?.displayName || op.name,
    method: (op.properties?.method || '').toUpperCase(),
    urlTemplate: op.properties?.urlTemplate || ''
  }));

  if (includeOperations) {
    let done = 0;
    await pool.all(ops, async (op) => {
      let xml = null;
      try {
        xml = await svc.getOperationPolicy(apiId, op.name);
      } catch {
        /* ignore a single failing operation */
      }
      done++;
      onProgress(`Reading operation policies ${done}/${ops.length}`);
      if (!xml) return;
      const analysis = stamp(
        analyzePolicy(xml, {
          scope: `operation:${apiId}/${op.name}`,
          scopeType: 'operation',
          label: `operation “${op.properties?.displayName || op.name}”`,
          knownNamedValues: catalog.knownNamedValues
        })
      );
      analyses.push(analysis);
      operations.push({
        id: op.name,
        displayName: op.properties?.displayName || op.name,
        method: op.properties?.method,
        urlTemplate: op.properties?.urlTemplate,
        analysis
      });
    });
  }

  // --- products -------------------------------------------------------------
  const products = [];
  if (includeProducts) {
    onProgress('Reading products');
    let productList = [];
    try {
      productList = await svc.listApiProducts(apiId);
    } catch (err) {
      warnings.push(`Products could not be listed: ${err.message}`);
    }
    await pool.all(productList, async (product) => {
      let analysis = catalog.productAnalyses.get(product.name);
      if (!analysis) {
        let xml = null;
        try {
          xml = await svc.getProductPolicy(product.name);
        } catch {
          xml = null;
        }
        analysis = stamp(
          analyzePolicy(xml, {
            scope: `product:${product.name}`,
            scopeType: 'product',
            label: `product “${product.properties?.displayName || product.name}”`,
            knownNamedValues: catalog.knownNamedValues
          })
        );
        catalog.productAnalyses.set(product.name, analysis);
      }
      analyses.push(analysis);
      products.push({
        id: product.name,
        displayName: product.properties?.displayName || product.name,
        state: product.properties?.state,
        subscriptionRequired: product.properties?.subscriptionRequired,
        approvalRequired: product.properties?.approvalRequired,
        hasPolicy: analysis.hasPolicy,
        analysis
      });
    });
  }

  // --- fragments (recursive) ------------------------------------------------
  const directFragmentIds = new Set();
  for (const analysis of analyses) {
    for (const id of analysis.fragments.keys()) directFragmentIds.add(id);
  }
  const fragments = [];
  if (directFragmentIds.size) {
    onProgress('Resolving policy fragments');
    const seen = new Set();
    for (const id of directFragmentIds) {
      await analyzeFragment(svc, catalog, id, 0, seen, fragments);
    }
    for (const fragment of fragments) analyses.push(fragment.analysis);
  }

  // --- global policy inheritance -------------------------------------------
  const inheritsGlobal = analyses.some((a) =>
    Object.values(a.sections || {}).some((s) => s.hasBase)
  );
  if (inheritsGlobal && catalog.globalAnalysis?.hasPolicy) {
    analyses.push(catalog.globalAnalysis);
  }

  const merged = mergeAnalyses(analyses, { scope: `api:${apiId}` });

  // Every policy document that fed the rolled-up lists, so an empty result is
  // diagnosable rather than mysterious.
  const sourcesRead = analyses.map((a) => ({
    label: a.label,
    scopeType: a.scopeType,
    hasPolicy: a.hasPolicy,
    length: a.length || 0,
    parseError: a.parseError || null,
    repaired: !!a.repaired,
    degraded: !!a.degraded,
    found:
      a.namedValues.size +
      a.backends.size +
      a.fragments.size +
      a.certificates.size +
      a.loggers.size
  }));

  for (const fragment of fragments) {
    fragment.usedIn = merged.fragments.get(fragment.id)?.occurrences || [];
  }

  // --- backends -------------------------------------------------------------
  const backendNamedValues = new Set();
  const backends = [];
  for (const [id, entry] of merged.backends) {
    const found = lookupCatalog(catalog, 'backends', id);
    let backend = found.item;
    let confirmedByLookup = false;
    if (!backend) {
      backend = await confirmExists(catalog, 'backends', id, () => svc.getBackend(id));
      confirmedByLookup = !!backend;
    }
    const credentials = backend?.properties?.credentials;
    if (credentials) {
      for (const value of JSON.stringify(credentials).match(/\{\{[^{}]*\}\}/g) || []) {
        for (const name of namedValuesInString(value, catalog.knownNamedValues)) {
          backendNamedValues.add(name);
        }
      }
    }
    backends.push({
      id,
      exists: !!backend,
      actualName: backend?.name && backend.name !== id ? backend.name : null,
      casingDiffers: found.casingDiffers,
      confirmedByLookup,
      title: backend?.properties?.title || null,
      url: backend?.properties?.url || null,
      protocol: backend?.properties?.protocol || null,
      resourceId: backend?.properties?.resourceId || null,
      certificateIds: credentials?.certificateIds || [],
      hasCredentials: !!credentials,
      usedIn: entry.occurrences
    });
  }

  // A serviceUrl set directly on the API is a dependency too, even with no policy.
  const serviceUrl = api.properties?.serviceUrl || null;
  if (serviceUrl) {
    const match = [...catalog.backends.values()].find(
      (b) => b.properties?.url && serviceUrl.startsWith(b.properties.url)
    );
    if (match && !backends.some((b) => b.id === match.name)) {
      backends.push({
        id: match.name,
        exists: true,
        title: match.properties?.title || null,
        url: match.properties?.url,
        protocol: match.properties?.protocol,
        matchedByUrl: true,
        certificateIds: match.properties?.credentials?.certificateIds || [],
        usedIn: [{ where: 'API serviceUrl', scope: 'API settings' }]
      });
    }
  }

  // --- named values ---------------------------------------------------------
  const namedValues = [];
  const keyVaultMap = new Map();

  const addKeyVault = (secretIdentifier, source, extra = {}) => {
    if (!secretIdentifier) return null;
    const parsed = parseSecretIdentifier(secretIdentifier);
    const key = parsed.vaultName || secretIdentifier;
    if (!keyVaultMap.has(key)) {
      keyVaultMap.set(key, { vaultName: parsed.vaultName, vaultUri: parsed.vaultUri, secrets: [] });
    }
    keyVaultMap.get(key).secrets.push({
      secretName: parsed.secretName,
      version: parsed.version,
      pinnedVersion: parsed.pinnedVersion,
      secretIdentifier,
      source,
      ...extra
    });
    return parsed;
  };

  const namedValueTokens = new Set([...merged.namedValues.keys(), ...backendNamedValues]);
  for (const token of namedValueTokens) {
    let nv = catalog.namedValueByToken.get(token);
    let casingDiffers = false;
    let confirmedByLookup = false;
    if (!nv) {
      nv = catalog.ci.namedValues.get(String(token).toLowerCase()) || null;
      casingDiffers = !!nv;
    }
    if (!nv) {
      nv = await confirmExists(catalog, 'namedValues', token, () => svc.getNamedValue(token));
      confirmedByLookup = !!nv;
    }
    const keyVault = nv?.properties?.keyVault || null;
    if (keyVault?.secretIdentifier) {
      addKeyVault(keyVault.secretIdentifier, `named value “${token}”`, {
        identityClientId: keyVault.identityClientId || 'system-assigned',
        lastStatus: keyVault.lastStatus || null
      });
    }
    namedValues.push({
      token,
      id: nv?.name || null,
      exists: !!nv,
      actualName:
        nv?.properties?.displayName && nv.properties.displayName !== token
          ? nv.properties.displayName
          : null,
      casingDiffers,
      confirmedByLookup,
      secret: !!nv?.properties?.secret,
      value: nv?.properties?.secret ? null : nv?.properties?.value ?? null,
      tags: nv?.properties?.tags || [],
      keyVault: keyVault
        ? { ...parseSecretIdentifier(keyVault.secretIdentifier), ...keyVault }
        : null,
      viaBackendOnly: !merged.namedValues.has(token),
      usedIn: merged.namedValues.get(token)?.occurrences || [
        { where: 'backend credentials', scope: 'a backend definition' }
      ]
    });
  }
  namedValues.sort((a, b) => a.token.localeCompare(b.token));

  // --- certificates ---------------------------------------------------------
  const certificateIds = new Set(merged.certificates.keys());
  for (const backend of backends) {
    for (const id of backend.certificateIds || []) certificateIds.add(shortId(id));
  }
  const certificates = [];
  for (const id of certificateIds) {
    const cert = lookupCatalog(catalog, 'certificates', id).item;
    if (cert?.properties?.keyVault?.secretIdentifier) {
      addKeyVault(cert.properties.keyVault.secretIdentifier, `certificate “${id}”`, {
        identityClientId: cert.properties.keyVault.identityClientId || 'system-assigned',
        lastStatus: cert.properties.keyVault.lastStatus || null
      });
    }
    certificates.push({
      id,
      usedIn: merged.certificates.get(id)?.occurrences || [],
      exists: !!cert,
      subject: cert?.properties?.subject || null,
      thumbprint: cert?.properties?.thumbprint || null,
      expiry: cert?.properties?.expirationDate || null,
      keyVault: cert?.properties?.keyVault || null
    });
  }

  // --- auth / diagnostics / version set -------------------------------------
  const auth = [];
  const authSettings = api.properties?.authenticationSettings;
  for (const oauth of authSettings?.oAuth2AuthenticationSettings || []) {
    const server = lookupCatalog(catalog, 'authServers', shortId(oauth.authorizationServerId)).item;
    auth.push({
      kind: 'OAuth 2.0 server',
      id: shortId(oauth.authorizationServerId),
      exists: !!server,
      detail: server?.properties?.tokenEndpoint || null
    });
  }
  for (const oidc of authSettings?.openidAuthenticationSettings || []) {
    const provider = lookupCatalog(catalog, 'openIdProviders', shortId(oidc.openidProviderId)).item;
    auth.push({
      kind: 'OpenID provider',
      id: shortId(oidc.openidProviderId),
      exists: !!provider,
      detail: provider?.properties?.metadataEndpoint || null
    });
  }

  onProgress('Reading diagnostics');
  const diagnostics = [];
  try {
    for (const diag of await svc.listApiDiagnostics(apiId)) {
      const loggerId = shortId(diag.properties?.loggerId);
      const logger = lookupCatalog(catalog, 'loggers', loggerId).item;
      diagnostics.push({
        id: diag.name,
        loggerId,
        loggerType: logger?.properties?.loggerType || null,
        resourceId: logger?.properties?.resourceId || null,
        samplingPercentage: diag.properties?.sampling?.percentage ?? null
      });
    }
  } catch {
    /* diagnostics are optional */
  }

  for (const [loggerId, entry] of merged.loggers) {
    const logger = lookupCatalog(catalog, 'loggers', loggerId).item;
    if (!diagnostics.some((d) => d.loggerId === loggerId)) {
      diagnostics.push({
        id: loggerId,
        loggerId,
        loggerType: logger?.properties?.loggerType || null,
        resourceId: logger?.properties?.resourceId || null,
        viaPolicy: entry.occurrences[0]?.where || 'policy'
      });
    }
  }

  const versionSetId = shortId(api.properties?.apiVersionSetId);
  const versionSetItem = lookupCatalog(catalog, 'versionSets', versionSetId).item;
  const versionSet = versionSetId
    ? {
        id: versionSetId,
        exists: !!versionSetItem,
        displayName: versionSetItem?.properties?.displayName || null,
        versioningScheme: versionSetItem?.properties?.versioningScheme || null
      }
    : null;

  // --- variables ------------------------------------------------------------
  const variableNames = new Set([...merged.variablesWritten.keys(), ...merged.variablesRead.keys()]);
  const variables = [...variableNames]
    .map((name) => ({
      name,
      written: merged.variablesWritten.get(name)?.occurrences || [],
      read: merged.variablesRead.get(name)?.occurrences || [],
      readOnly: !merged.variablesWritten.has(name)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const result = {
    apiId,
    apiLabel,
    serviceUrl,
    path: api.properties?.path,
    revision: api.properties?.apiRevision,
    version: api.properties?.apiVersion,
    isCurrent: api.properties?.isCurrent,
    subscriptionRequired: api.properties?.subscriptionRequired,
    protocols: api.properties?.protocols || [],
    inheritsGlobal,
    allOperations,
    sourcesRead,
    catalogSummary: {
      namedValues: catalog.namedValues.length,
      backends: catalog.backends.size,
      fragments: catalog.fragments.size,
      certificates: catalog.certificates.size,
      loggers: catalog.loggers.size
    },
    hasApiPolicy: apiAnalysis.hasPolicy,
    policyXml: apiXml,
    warnings,
    merged,
    operations: operations.sort((a, b) => a.displayName.localeCompare(b.displayName)),
    products: products.sort((a, b) => a.displayName.localeCompare(b.displayName)),
    fragments,
    backends,
    namedValues,
    unresolvedNamedValues: [...merged.unresolvedNamedValues.values()],
    variableLookalikes: [...merged.variableLookalikes.values()],
    ambiguousTokens: [...merged.ambiguousTokens.values()],
    liquidTokens: [...merged.liquidTokens.values()],
    variables,
    certificates,
    keyVault: [...keyVaultMap.values()],
    auth,
    diagnostics,
    versionSet,
    urls: [...merged.urls.entries()].map(([url, entry]) => ({ url, usedIn: entry.occurrences })),
    caches: [...merged.caches.keys()],
    identities: [...merged.identities.entries()].map(([resource, entry]) => ({ resource, ...entry }))
  };

  result.counts = {
    backends: result.backends.length,
    products: result.products.length,
    fragments: result.fragments.length,
    namedValues: result.namedValues.length,
    keyVault: result.keyVault.reduce((n, v) => n + v.secrets.length, 0),
    variables: result.variables.length,
    issues:
      result.unresolvedNamedValues.length +
      result.variableLookalikes.length +
      result.backends.filter((b) => !b.exists).length +
      result.fragments.filter((f) => !f.exists).length
  };

  return result;
}

/**
 * Serialisable projection for the report window. Strips the analysis objects,
 * whose Maps do not survive JSON, but keeps the per-component reference lists
 * that make the wide layout worth having.
 */
export function toReport(r) {
  const keys = (map) => [...map.keys()];
  return {
    apiId: r.apiId,
    apiLabel: r.apiLabel,
    path: r.path,
    serviceUrl: r.serviceUrl,
    revision: r.revision,
    version: r.version,
    protocols: r.protocols,
    subscriptionRequired: r.subscriptionRequired,
    inheritsGlobal: r.inheritsGlobal,
    hasApiPolicy: r.hasApiPolicy,
    warnings: r.warnings,
    counts: r.counts,
    catalogSummary: r.catalogSummary,
    sourcesRead: r.sourcesRead,
    backends: r.backends,
    products: r.products.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      state: p.state,
      subscriptionRequired: p.subscriptionRequired,
      approvalRequired: p.approvalRequired,
      hasPolicy: p.hasPolicy,
      namedValues: keys(p.analysis.namedValues),
      backends: keys(p.analysis.backends),
      fragments: keys(p.analysis.fragments)
    })),
    fragments: r.fragments.map((f) => ({
      id: f.id,
      depth: f.depth,
      exists: f.exists,
      actualName: f.actualName,
      casingDiffers: f.casingDiffers,
      confirmedByLookup: f.confirmedByLookup,
      description: f.description,
      usedIn: f.usedIn,
      namedValues: keys(f.analysis.namedValues),
      backends: keys(f.analysis.backends)
    })),
    namedValues: r.namedValues,
    unresolvedNamedValues: r.unresolvedNamedValues,
    variableLookalikes: r.variableLookalikes,
    ambiguousTokens: r.ambiguousTokens,
    liquidTokens: r.liquidTokens,
    variables: r.variables,
    certificates: r.certificates,
    keyVault: r.keyVault,
    auth: r.auth,
    diagnostics: r.diagnostics,
    versionSet: r.versionSet,
    urls: r.urls,
    caches: r.caches,
    identities: r.identities,
    allOperations: r.allOperations,
    operations: r.operations.map((op) => ({
      id: op.id,
      displayName: op.displayName,
      method: op.method,
      urlTemplate: op.urlTemplate,
      namedValues: keys(op.analysis.namedValues),
      backends: keys(op.analysis.backends),
      fragments: keys(op.analysis.fragments)
    })),
    comparison: r.comparison || null,
    policyXml: r.policyXml || null
  };
}

/** Flattens a resolved API into a plain object suitable for JSON/CSV export. */
export function toExport(resolved) {
  return {
    api: resolved.apiLabel,
    apiId: resolved.apiId,
    path: resolved.path,
    serviceUrl: resolved.serviceUrl,
    backends: resolved.backends.map((b) => ({ id: b.id, url: b.url, missing: !b.exists })),
    products: resolved.products.map((p) => ({ id: p.id, name: p.displayName, state: p.state })),
    fragments: resolved.fragments.map((f) => ({
      id: f.id,
      depth: f.depth,
      missing: !f.exists,
      actualName: f.actualName || null
    })),
    namedValues: resolved.namedValues.map((n) => ({
      name: n.token,
      secret: n.secret,
      missing: !n.exists,
      keyVault: n.keyVault?.secretIdentifier || null
    })),
    keyVault: resolved.keyVault,
    certificates: resolved.certificates.map((c) => ({ id: c.id, expiry: c.expiry })),
    variables: resolved.variables.map((v) => v.name),
    issues: {
      unresolvedNamedValues: resolved.unresolvedNamedValues.map((u) => u.name),
      variableLookalikes: resolved.variableLookalikes.map((u) => u.name),
      ambiguousTokens: resolved.ambiguousTokens.map((u) => u.name)
    }
  };
}
