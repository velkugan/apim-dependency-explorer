/**
 * Policy XML analysis.
 *
 * The whole point of this file is to tell three lookalike things apart:
 *
 *   {{MyNamedValue}}                     -> a named value reference
 *   {{ order.customer.name }}            -> a Liquid template variable (inside
 *                                           <set-body template="liquid">)
 *   @{ return $"{{\"id\":\"{id}\"}}"; }  -> C# interpolated-string brace escaping
 *                                           that a naive regex reads as a named value
 *   context.Variables["x"]               -> a policy variable, never a named value
 *
 * Rules applied, in order:
 *  1. Text inside a Liquid-templated <set-body> is walked as Liquid. Every
 *     moustache there is a Liquid variable and is excluded from named values.
 *  2. Policy expression bodies (@{...} and @(...)) are located with a
 *     brace/paren-balanced scan that respects string literals. Moustaches found
 *     inside an expression must both look like a legal named value name AND
 *     exist in the service's named value list, otherwise they are reported as
 *     ambiguous rather than counted as a dependency.
 *  3. Outside expressions, a moustache containing whitespace, a pipe or a
 *     bracket is Liquid-ish syntax, not a named value.
 *  4. A moustache whose name matches a variable declared by <set-variable> and
 *     is not a known named value is flagged as a variable-lookalike: in APIM
 *     that reference will never resolve, so it is surfaced as a policy bug.
 *  5. Anything else that looks like a named value but is not defined on the
 *     service is reported as unresolved — a genuinely broken dependency.
 *
 * Variables are collected separately (declared vs read) and never merged into
 * the named value list.
 */

export const TOKEN_KIND = {
  NAMED_VALUE: 'named-value',
  NAMED_VALUE_UNRESOLVED: 'named-value-unresolved',
  VARIABLE_LOOKALIKE: 'variable-lookalike',
  LIQUID: 'liquid',
  AMBIGUOUS: 'ambiguous'
};

const NV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const MOUSTACHE_RE = /\{\{([^{}]*)\}\}/g;
const LIQUID_SYNTAX_RE = /[\s|[\]]/;

const VAR_READ_PATTERNS = [
  /context\.Variables\s*\[\s*["']([^"']+)["']\s*\]/g,
  /context\.Variables\s*\.\s*GetValueOrDefault[^("']*\(\s*["']([^"']+)["']/g,
  /context\.Variables\s*\.\s*(?:ContainsKey|TryGetValue)\s*\(\s*["']([^"']+)["']/g
];

const VARIABLE_WRITE_ATTRS = [
  'variable-name',
  'output-token-variable-name',
  'response-variable-name',
  'context-variable-name',
  'output-variable-name'
];

const SECTIONS = ['inbound', 'backend', 'outbound', 'on-error'];

// ---------------------------------------------------------------------------
// collection helpers
// ---------------------------------------------------------------------------

function addTo(map, key, occurrence, extra = {}) {
  if (!key) return;
  if (!map.has(key)) map.set(key, { name: key, occurrences: [], ...extra });
  const entry = map.get(key);
  Object.assign(entry, extra);
  if (occurrence) entry.occurrences.push(occurrence);
  return entry;
}

export function emptyAnalysis(meta = {}) {
  return {
    scope: meta.scope || 'unknown',
    scopeType: meta.scopeType || 'unknown',
    label: meta.label || meta.scope || 'unknown',
    ok: true,
    parseError: null,
    hasPolicy: false,
    sections: {},
    namedValues: new Map(),
    unresolvedNamedValues: new Map(),
    variableLookalikes: new Map(),
    liquidTokens: new Map(),
    ambiguousTokens: new Map(),
    variablesWritten: new Map(),
    variablesRead: new Map(),
    backends: new Map(),
    fragments: new Map(),
    certificates: new Map(),
    loggers: new Map(),
    caches: new Map(),
    identities: new Map(),
    urls: new Map(),
    authServers: new Map()
  };
}

const MERGE_KEYS = [
  'namedValues',
  'unresolvedNamedValues',
  'variableLookalikes',
  'liquidTokens',
  'ambiguousTokens',
  'variablesWritten',
  'variablesRead',
  'backends',
  'fragments',
  'certificates',
  'loggers',
  'caches',
  'identities',
  'urls',
  'authServers'
];

export function mergeAnalyses(analyses, meta = {}) {
  const merged = emptyAnalysis({ scope: meta.scope || 'merged', scopeType: 'merged' });
  merged.sources = [];
  for (const a of analyses) {
    if (!a) continue;
    merged.sources.push({ scope: a.scope, scopeType: a.scopeType, label: a.label, hasPolicy: a.hasPolicy });
    merged.hasPolicy = merged.hasPolicy || a.hasPolicy;
    for (const key of MERGE_KEYS) {
      for (const [name, entry] of a[key]) {
        const { occurrences = [], ...rest } = entry;
        const existing = merged[key].get(name);
        if (existing) {
          // Keep every occurrence from every scope — this is what makes the
          // rolled-up list say "used in API policy, operation X and fragment Y"
          // instead of only remembering the scope that was merged last.
          existing.occurrences = existing.occurrences.concat(occurrences);
          for (const [k, v] of Object.entries(rest)) {
            if (existing[k] === undefined) existing[k] = v;
          }
        } else {
          merged[key].set(name, { ...rest, name, occurrences: [...occurrences] });
        }
      }
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// expression scanning
// ---------------------------------------------------------------------------

/**
 * Returns [start, end] index pairs for every @{...} / @(...) region, tracking
 * nesting depth and skipping string literals so JSON braces inside a C#
 * expression cannot terminate the region early.
 */
export function findExpressionRegions(text) {
  const regions = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== '@') continue;
    const open = text[i + 1];
    if (open !== '{' && open !== '(') continue;
    const close = open === '{' ? '}' : ')';
    let depth = 0;
    let inString = null;
    let j = i + 1;
    for (; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (c === '\\') j++;
        else if (c === inString) inString = null;
        continue;
      }
      if (c === '"' || c === "'") {
        inString = c;
        continue;
      }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) break;
      }
    }
    regions.push([i, Math.min(j, text.length - 1)]);
    i = j;
  }
  return regions;
}

const inRegions = (index, regions) => regions.some(([s, e]) => index >= s && index <= e);

/**
 * Classifies a single moustache token.
 * Exported so the rules can be unit tested on their own.
 */
export function classifyToken(rawToken, { inExpression, inLiquid, knownNamedValues, declaredVariables }) {
  const token = rawToken.trim();
  const known = knownNamedValues?.has(token);

  if (inLiquid) {
    // APIM substitutes named values before Liquid renders, so an exact match on
    // a real named value is still a named value — and a Liquid variable of the
    // same name would be clobbered. Everything else here is Liquid.
    if (known && NV_NAME_RE.test(token)) {
      return {
        kind: TOKEN_KIND.NAMED_VALUE,
        name: token,
        reason: 'Inside a Liquid template, but the name matches a named value, which is substituted first.'
      };
    }
    // Policy expression syntax inside a Liquid body is a real bug worth naming:
    // Liquid cannot read context, and {{ }} only substitutes named values, so
    // the token reaches the client verbatim.
    if (/^context\./.test(token) || /^@[({]/.test(token)) {
      return {
        kind: TOKEN_KIND.LIQUID,
        name: token,
        reason:
          'Policy expression syntax inside a Liquid body. Liquid cannot read context, and {{ }} only ' +
          'substitutes named values, so this is emitted literally rather than evaluated.'
      };
    }
    return { kind: TOKEN_KIND.LIQUID, name: token, reason: 'Liquid template variable inside a set-body.' };
  }

  if (!NV_NAME_RE.test(token)) {
    return {
      kind: TOKEN_KIND.AMBIGUOUS,
      name: token,
      reason: LIQUID_SYNTAX_RE.test(rawToken)
        ? 'Contains spaces or Liquid syntax — not a valid named value name.'
        : 'Not a legal named value name. Most likely brace escaping inside an expression.'
    };
  }

  if (known) return { kind: TOKEN_KIND.NAMED_VALUE, name: token };

  if (inExpression) {
    return {
      kind: TOKEN_KIND.AMBIGUOUS,
      name: token,
      reason: 'Found inside a policy expression and not defined on this service. Ignored to avoid a false dependency.'
    };
  }

  if (declaredVariables?.has(token)) {
    return {
      kind: TOKEN_KIND.VARIABLE_LOOKALIKE,
      name: token,
      reason: 'A variable of this name is set in the policy. {{ }} never resolves variables, so this reference will not work.'
    };
  }

  return {
    kind: TOKEN_KIND.NAMED_VALUE_UNRESOLVED,
    name: token,
    reason: 'Referenced as a named value but not defined on this API Management instance.'
  };
}

/**
 * A backend-id can be built at runtime:
 *   backend-id="@("wem-" + context.Variables["site"])"
 *   backend-id="{{backend-prefix}}01"
 * Treating the whole string as a literal name reports a live backend as missing.
 * This turns the value into a glob so the resolver can find every backend it
 * could select.
 */
export function dynamicPattern(value) {
  if (!value || (!value.includes('{{') && !value.includes('@{') && !value.includes('@('))) {
    return null;
  }

  const regions = findExpressionRegions(value);
  let masked = '';
  let cursor = 0;
  for (const [start, end] of regions) {
    masked += value.slice(cursor, start) + '*';
    cursor = end + 1;
  }
  masked += value.slice(cursor);
  masked = masked.replace(/\{\{[^{}]*\}\}/g, '*').replace(/\*+/g, '*');

  const first = masked.indexOf('*');
  if (first === -1) return null;

  // The literal part of a concatenation lives inside the expression, so
  // "wem-st" in @("wem-st" + context.Variables["site"]) has to be mined out of
  // the string literals or every backend on the instance becomes a candidate.
  const hints = [];
  for (const [start, end] of regions) {
    const body = value.slice(start, end + 1);
    for (const match of body.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'/g)) {
      const literal = (match[1] ?? match[2] ?? '').trim();
      if (literal.length >= 2 && /[a-z0-9]/i.test(literal)) hints.push(literal);
    }
  }
  hints.sort((a, b) => b.length - a.length);

  return {
    pattern: masked,
    prefix: masked.slice(0, first),
    suffix: masked.slice(masked.lastIndexOf('*') + 1),
    hints,
    raw: value,
    wholeToken: /^\{\{[^{}]+\}\}$/.test(value.trim()) ? value.trim().slice(2, -2).trim() : null
  };
}

// ---------------------------------------------------------------------------
// main analysis
// ---------------------------------------------------------------------------

export function analyzePolicy(xml, options = {}) {
  const {
    scope = 'unknown',
    scopeType = 'unknown',
    label = scope,
    knownNamedValues = new Set()
  } = options;

  const analysis = emptyAnalysis({ scope, scopeType, label });
  if (!xml || !xml.trim()) return analysis;
  analysis.hasPolicy = true;
  analysis.length = xml.length;

  const parsed = parseWithRepair(xml);
  analysis.repaired = parsed.repaired;

  if (!parsed.doc) {
    // Still extract what we can. A document that will not parse is exactly the
    // case where returning nothing is least helpful.
    analysis.ok = false;
    analysis.degraded = true;
    analysis.parseError = parsed.error || 'Policy XML could not be parsed.';
    analyzeDegraded(xml, { analysis, knownNamedValues });
    return analysis;
  }

  // Pass 1: variables declared anywhere in this document, so a moustache seen
  // before its <set-variable> can still be recognised as a variable lookalike.
  const declaredVariables = new Set();
  collectDeclaredVariables(parsed.doc.documentElement, declaredVariables);

  const ctx = { analysis, knownNamedValues, declaredVariables, section: null, path: [] };
  walk(parsed.doc.documentElement, ctx, false);

  return analysis;
}

function tryParse(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const error = doc.querySelector ? doc.querySelector('parsererror') : null;
  if (error || !doc.documentElement) {
    return { doc: null, error: error?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 160) || null };
  }
  return { doc, error: null };
}

/**
 * Escapes the characters APIM tolerates but XML does not: bare & anywhere, and
 * < or > inside an attribute value. Only used when the document as returned
 * fails to parse, which should be rare now that policies are fetched as
 * format=xml rather than rawxml.
 */
export function repairPolicyXml(xml) {
  let out = '';
  let inTag = false;
  let quote = null;

  for (let i = 0; i < xml.length; i++) {
    const c = xml[i];

    if (quote) {
      if (c === quote) {
        quote = null;
        out += c;
      } else if (c === '<') out += '&lt;';
      else if (c === '>') out += '&gt;';
      else if (c === '&' && !/^&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,7});/.test(xml.slice(i))) {
        out += '&amp;';
      } else out += c;
      continue;
    }

    if (inTag) {
      if (c === '"' || c === "'") quote = c;
      if (c === '>') inTag = false;
      out += c;
      continue;
    }

    if (c === '<') {
      // A < that does not open a tag or comment is literal content.
      if (/^<[/?!]?[a-zA-Z]/.test(xml.slice(i)) || xml.startsWith('<!--', i) || xml.startsWith('<![CDATA[', i)) {
        inTag = !xml.startsWith('<!--', i) && !xml.startsWith('<![CDATA[', i);
        out += c;
      } else {
        out += '&lt;';
      }
      continue;
    }

    if (c === '&' && !/^&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,7});/.test(xml.slice(i))) {
      out += '&amp;';
      continue;
    }

    out += c;
  }
  return out;
}

function parseWithRepair(xml) {
  const first = tryParse(xml);
  if (first.doc) return { doc: first.doc, repaired: false, error: null };

  const second = tryParse(repairPolicyXml(xml));
  if (second.doc) return { doc: second.doc, repaired: true, error: null };

  return { doc: null, repaired: false, error: first.error };
}

/**
 * Text-only extraction for documents that will not parse even after repair.
 * Loses element context, so it is marked degraded, but still finds the
 * dependencies that matter.
 */
function analyzeDegraded(xml, { analysis, knownNamedValues }) {
  const declaredVariables = new Set();
  for (const m of xml.matchAll(/<set-variable\b[^>]*\bname\s*=\s*["']([^"']+)["']/gi)) {
    declaredVariables.add(m[1]);
  }
  for (const attr of VARIABLE_WRITE_ATTRS) {
    const re = new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'gi');
    for (const m of xml.matchAll(re)) declaredVariables.add(m[1]);
  }

  const base = { analysis, knownNamedValues, declaredVariables, section: null, path: ['policy'] };

  // Pull Liquid bodies out first so their moustaches are not read as named values.
  let liquid = '';
  const stripped = xml.replace(
    /<set-body\b[^>]*template\s*=\s*["']liquid["'][^>]*>([\s\S]*?)<\/set-body>/gi,
    (match, body) => {
      liquid += body + '\n';
      return '<set-body/>';
    }
  );

  if (liquid.trim()) scanText(liquid, { ...base, where: 'set-body (liquid)' }, true);
  scanText(stripped, { ...base, where: 'text scan (unparsed policy)' }, false);

  const attrRules = [
    [/\bbackend-id\s*=\s*["']([^"']+)["']/gi, 'backends', 'backend-id'],
    [/\bfragment-id\s*=\s*["']([^"']+)["']/gi, 'fragments', 'include-fragment'],
    [/\bcertificate-id\s*=\s*["']([^"']+)["']/gi, 'certificates', 'certificate-id'],
    [/\blogger-id\s*=\s*["']([^"']+)["']/gi, 'loggers', 'logger-id']
  ];
  for (const [re, key, via] of attrRules) {
    for (const m of xml.matchAll(re)) {
      addTo(analysis[key], m[1], { where: 'text scan (unparsed policy)' }, { via });
    }
  }
  for (const name of declaredVariables) {
    addTo(analysis.variablesWritten, name, { where: 'text scan (unparsed policy)' }, { via: 'set-variable' });
  }
}

function collectDeclaredVariables(node, into) {
  const tag = node.nodeName.toLowerCase();
  if (tag === 'set-variable') {
    const name = node.getAttribute('name');
    if (name) into.add(name);
  }
  for (const attr of VARIABLE_WRITE_ATTRS) {
    const value = node.getAttribute?.(attr);
    if (value) into.add(value);
  }
  for (const child of node.children) collectDeclaredVariables(child, into);
}

function walk(node, ctx, inLiquid) {
  const tag = node.nodeName.toLowerCase();
  const section = SECTIONS.includes(tag) ? tag : ctx.section;
  if (SECTIONS.includes(tag)) {
    ctx.analysis.sections[tag] = ctx.analysis.sections[tag] || { hasBase: false, elements: [] };
  }
  if (tag === 'base' && section && ctx.analysis.sections[section]) {
    ctx.analysis.sections[section].hasBase = true;
  }
  if (section && ctx.analysis.sections[section] && !SECTIONS.includes(tag) && tag !== 'base') {
    const list = ctx.analysis.sections[section].elements;
    if (!list.includes(tag)) list.push(tag);
  }

  const path = [...ctx.path, tag];
  const childCtx = { ...ctx, section, path };

  const isLiquidNode =
    tag === 'set-body' && (node.getAttribute('template') || '').toLowerCase() === 'liquid';
  const childLiquid = inLiquid || isLiquidNode;

  // Attributes are never Liquid, even on a Liquid set-body.
  for (const attr of Array.from(node.attributes || [])) {
    scanText(attr.value, { ...childCtx, where: `${path.join(' > ')}@${attr.name}` }, false);
  }

  extractElement(tag, node, childCtx);

  // Parsers may split a text run into several nodes around entity references,
  // which would cut an expression in half. Join the direct text children first.
  const children = Array.from(node.childNodes);
  const directText = children
    .filter((c) => c.nodeType === Node.TEXT_NODE || c.nodeType === Node.CDATA_SECTION_NODE)
    .map((c) => c.nodeValue || '')
    .join('');
  if (directText.trim()) {
    scanText(directText, { ...childCtx, where: path.join(' > ') }, childLiquid);
  }

  for (const child of children) {
    if (child.nodeType === Node.ELEMENT_NODE) walk(child, childCtx, childLiquid);
  }
}

function scanText(text, ctx, inLiquid) {
  if (!text) return;
  const hasMoustache = text.includes('{{');
  const hasExpression = text.includes('@{') || text.includes('@(');
  if (!hasMoustache && !hasExpression) return;

  const { analysis, knownNamedValues, declaredVariables, where, section } = ctx;
  const regions = findExpressionRegions(text);

  // Variable reads live inside expressions.
  for (const [start, end] of regions) {
    const body = text.slice(start, end + 1);
    for (const pattern of VAR_READ_PATTERNS) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(body))) {
        addTo(analysis.variablesRead, m[1], { where, section, snippet: snippet(body, m.index) });
      }
    }
  }

  MOUSTACHE_RE.lastIndex = 0;
  let match;
  while ((match = MOUSTACHE_RE.exec(text))) {
    const raw = match[1];
    const inExpression = inRegions(match.index, regions);
    const result = classifyToken(raw, {
      inExpression,
      inLiquid,
      knownNamedValues,
      declaredVariables
    });
    const occurrence = {
      where,
      section,
      snippet: snippet(text, match.index),
      inExpression,
      reason: result.reason
    };

    switch (result.kind) {
      case TOKEN_KIND.NAMED_VALUE:
        addTo(analysis.namedValues, result.name, occurrence);
        break;
      case TOKEN_KIND.NAMED_VALUE_UNRESOLVED:
        addTo(analysis.unresolvedNamedValues, result.name, occurrence, { reason: result.reason });
        break;
      case TOKEN_KIND.VARIABLE_LOOKALIKE:
        addTo(analysis.variableLookalikes, result.name, occurrence, { reason: result.reason });
        break;
      case TOKEN_KIND.LIQUID:
        addTo(analysis.liquidTokens, result.name, occurrence, { reason: result.reason });
        break;
      default:
        addTo(analysis.ambiguousTokens, result.name, occurrence, { reason: result.reason });
    }
  }
}

function snippet(text, index, radius = 60) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

function extractElement(tag, node, ctx) {
  const { analysis, section } = ctx;
  const where = ctx.path.join(' > ');
  const at = (name) => node.getAttribute(name);
  const occurrence = { where, section };

  switch (tag) {
    case 'set-backend-service': {
      const backendId = at('backend-id');
      if (backendId) {
        const dynamic = dynamicPattern(backendId);
        addTo(
          analysis.backends,
          dynamic ? dynamic.pattern : backendId,
          occurrence,
          dynamic
            ? { via: 'set-backend-service', dynamic: true, ...dynamic }
            : { via: 'set-backend-service' }
        );
      }
      const baseUrl = at('base-url');
      if (baseUrl) addTo(analysis.urls, baseUrl, occurrence, { via: 'set-backend-service base-url' });
      break;
    }
    case 'include-fragment': {
      const fragmentId = at('fragment-id');
      if (fragmentId) addTo(analysis.fragments, fragmentId, occurrence, { via: 'include-fragment' });
      break;
    }
    case 'authentication-certificate': {
      const id = at('certificate-id') || at('thumbprint');
      if (id) {
        addTo(analysis.certificates, id, occurrence, {
          via: at('certificate-id') ? 'certificate-id' : 'thumbprint'
        });
      }
      break;
    }
    case 'log-to-eventhub': {
      const loggerId = at('logger-id');
      if (loggerId) addTo(analysis.loggers, loggerId, occurrence, { via: 'log-to-eventhub' });
      break;
    }
    case 'trace': {
      const source = at('source');
      if (source) addTo(analysis.loggers, source, occurrence, { via: 'trace source' });
      break;
    }
    case 'authentication-managed-identity': {
      const resource = at('resource');
      if (resource) {
        addTo(analysis.identities, resource, occurrence, {
          via: 'authentication-managed-identity',
          clientId: at('client-id') || null
        });
      }
      break;
    }
    case 'cache-lookup':
    case 'cache-store':
    case 'cache-lookup-value':
    case 'cache-store-value':
    case 'cache-remove-value': {
      const type = (at('caching-type') || 'prefer-external').toLowerCase();
      addTo(analysis.caches, type, occurrence, { via: tag });
      break;
    }
    case 'validate-jwt': {
      for (const child of Array.from(node.children)) {
        if (child.nodeName.toLowerCase() === 'openid-config') {
          const url = child.getAttribute('url');
          if (url) addTo(analysis.urls, url, occurrence, { via: 'validate-jwt openid-config' });
        }
      }
      break;
    }
    case 'validate-azure-ad-token': {
      const tenant = at('tenant-id');
      if (tenant) addTo(analysis.identities, tenant, occurrence, { via: 'validate-azure-ad-token tenant' });
      break;
    }
    case 'send-request':
    case 'send-one-way-request': {
      for (const child of Array.from(node.children)) {
        if (child.nodeName.toLowerCase() === 'set-url') {
          const url = child.textContent?.trim();
          if (url) addTo(analysis.urls, url, occurrence, { via: `${tag} set-url` });
        }
      }
      break;
    }
    case 'proxy': {
      const url = at('url');
      if (url) addTo(analysis.urls, url, occurrence, { via: 'proxy' });
      break;
    }
    case 'set-variable': {
      const name = at('name');
      if (name) addTo(analysis.variablesWritten, name, occurrence, { via: 'set-variable' });
      break;
    }
    case 'azure-openai-semantic-cache-lookup':
    case 'llm-semantic-cache-lookup': {
      addTo(analysis.caches, 'semantic', occurrence, { via: tag });
      break;
    }
    default:
      break;
  }

  // Generic: any element that writes a variable through a *-variable-name attribute.
  for (const attr of VARIABLE_WRITE_ATTRS) {
    const value = at(attr);
    if (value) addTo(analysis.variablesWritten, value, occurrence, { via: `${tag}@${attr}` });
  }

  // Generic: backend-id shows up on several AI gateway policies too.
  if (tag !== 'set-backend-service') {
    const backendId = at('backend-id');
    if (backendId) {
      const dynamic = dynamicPattern(backendId);
      addTo(
        analysis.backends,
        dynamic ? dynamic.pattern : backendId,
        occurrence,
        dynamic ? { via: `${tag}@backend-id`, dynamic: true, ...dynamic } : { via: `${tag}@backend-id` }
      );
    }
  }
}

/** Pulls {{named-value}} references out of a plain string (backend credentials etc). */
export function namedValuesInString(text, knownNamedValues) {
  const found = new Set();
  if (!text) return found;
  MOUSTACHE_RE.lastIndex = 0;
  let m;
  while ((m = MOUSTACHE_RE.exec(text))) {
    const token = m[1].trim();
    if (NV_NAME_RE.test(token) && (!knownNamedValues || knownNamedValues.has(token))) {
      found.add(token);
    }
  }
  return found;
}
