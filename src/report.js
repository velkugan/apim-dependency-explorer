import { $, h, copy } from './lib/util.js';
import { comparisonToText } from './lib/compare.js';
import { ArmClient } from './lib/arm.js';
import { ApimService } from './lib/apim.js';
import { normalizeXml, diffLines, collapseUnchanged, diffStats, diffFields } from './lib/diff.js';
import { buildTemplateBundle } from './lib/arm-templates.js';
import { makeZip, downloadBlob } from './lib/zip.js';

const params = new URLSearchParams(location.search);
const payloadKey = params.get('key');

const state = { payload: null, current: null };

const els = {
  picker: $('#api-picker'),
  title: $('#api-title'),
  meta: $('#api-meta'),
  nav: $('#nav'),
  main: $('#main'),
  filter: $('#filter'),
  explorerTree: $('#explorer-tree'),
  detail: $('#detail'),
  copyList: $('#copy-list'),
  copyJson: $('#copy-json'),
  copyGaps: $('#copy-gaps'),
  genTemplates: $('#gen-templates'),
  print: $('#print')
};

boot();

async function boot() {
  if (!payloadKey) return fail('No report to show. Open one from the side panel.');
  let stored;
  try {
    stored = await chrome.storage.session.get(payloadKey);
  } catch (err) {
    return fail(`Could not read the report: ${err.message}`);
  }
  const payload = stored?.[payloadKey];
  if (!payload?.apis?.length) return fail('That report has expired. Re-open it from the side panel.');

  state.payload = payload;
  document.title = `${payload.service?.serviceName || 'APIM'} dependencies`;

  // Resolve the focus before building the picker, so the option can be marked
  // selected as it is created rather than assigned to afterwards.
  const initial = resolveFocusIndex(payload);

  const ordered = [...payload.apis.entries()].sort((a, b) =>
    a[1].apiLabel.localeCompare(b[1].apiLabel)
  );
  for (const [index, api] of ordered) {
    els.picker.append(
      h('option', { value: String(index), selected: index === initial }, api.apiLabel)
    );
  }
  els.picker.hidden = payload.apis.length < 2;
  els.picker.addEventListener('change', () => show(payload.apis[Number(els.picker.value)]));

  // Belt and braces: setting selectedIndex directly survives any option the
  // browser may have auto-selected first.
  const option = [...els.picker.options].findIndex((o) => Number(o.value) === initial);
  if (option >= 0) els.picker.selectedIndex = option;

  els.filter.addEventListener('input', applyFilter);
  els.print.addEventListener('click', () => window.print());
  els.copyList.addEventListener('click', () => copyWith(els.copyList, () => toText(state.current)));
  els.copyJson.addEventListener('click', () =>
    copyWith(els.copyJson, () => JSON.stringify(state.current, null, 2))
  );
  els.copyGaps.addEventListener('click', () =>
    copyWith(els.copyGaps, () => comparisonToText(state.current.comparison, state.current.apiLabel))
  );
  els.genTemplates.addEventListener('click', generateTemplates);

  els.viewToggle = h(
    'button',
    { class: 'ghost small', type: 'button', onClick: cycleView, title: 'Cards → Tree → Explorer' },
    'Tree view'
  );
  els.copyList.before(els.viewToggle);

  initExplorer(payload);

  show(payload.apis[initial]);
}

/**
 * Which API the window should open on. Matches on id, then case-insensitively,
 * then on label, and falls back to the first API in the payload rather than the
 * alphabetically first, so the fallback is at least predictable.
 */
function resolveFocusIndex(payload) {
  const focus = payload.focus;
  if (!focus) return 0;

  const exact = payload.apis.findIndex((a) => a.apiId === focus);
  if (exact >= 0) return exact;

  const lower = String(focus).toLowerCase();
  const loose = payload.apis.findIndex(
    (a) => String(a.apiId).toLowerCase() === lower || String(a.apiLabel).toLowerCase() === lower
  );
  if (loose >= 0) return loose;

  console.warn('APIM report: focus %o did not match any API in the payload', focus);
  return 0;
}

function fail(message) {
  els.main.replaceChildren(h('p', { class: 'report-empty' }, message));
}

async function copyWith(button, getText) {
  const label = button.textContent;
  await copy(getText());
  button.textContent = 'Copied';
  setTimeout(() => {
    button.textContent = label;
  }, 1200);
}

// ---------------------------------------------------------------------------
// rows and cards
// ---------------------------------------------------------------------------

function occurrences(refs) {
  if (!refs?.length) return null;
  const text = refs
    .map((o) => `${o.scope || ''} ${o.section ? `[${o.section}]` : ''} ${o.where || ''}\n  ${o.snippet || ''}`)
    .join('\n\n');
  return h('details', null, h('summary', null, `${refs.length} reference(s)`), h('pre', null, text));
}

function sourcesOf(refs) {
  const scopes = [...new Set((refs || []).map((o) => o.scope).filter(Boolean))];
  if (!scopes.length) return null;
  return `used in ${scopes.join(', ')}`;
}

function row(name, opts = {}) {
  const { sub, why, pill, pillColor, missing, refs } = opts;
  return h(
    'div',
    { class: `row-item${missing ? ' missing' : ''}`, dataset: { search: `${name} ${sub || ''} ${why || ''}`.toLowerCase() } },
    h('span', { class: 'rname' }, name),
    pill ? h('span', { class: 'pill', style: pillColor ? `color:${pillColor}` : null }, pill) : null,
    sub ? h('span', { class: 'rsub' }, sub) : null,
    why ? h('span', { class: 'rwhy' }, why) : null,
    refs?.length ? h('span', { class: 'rwhy' }, sourcesOf(refs)) : null,
    occurrences(refs)
  );
}

const cards = [];
const ROW_LIMIT = 12;

function card(id, title, stemClass, rows, opts = {}) {
  if (!rows || !rows.length) {
    cards.push({ id, title, count: 0, node: null, stemClass });
    return null;
  }
  const node = h('section', { class: `card ${stemClass}${opts.wide ? ' wide' : ''}`, id });
  const button = h(
    'button',
    {
      class: 'link',
      type: 'button',
      onClick: async () => {
        await copy([...node.querySelectorAll('.rname')].map((n) => n.textContent).join('\n'));
        button.textContent = 'copied';
        setTimeout(() => {
          button.textContent = 'copy';
        }, 1200);
      }
    },
    'copy'
  );
  const rowsWrap = h('div', { class: 'rows' }, ...rows);
  node.append(
    h('header', null, h('h2', null, title), h('span', { class: 'count' }, rows.length), button),
    ...(opts.note ? [h('p', { class: 'card-note' }, opts.note)] : []),
    rowsWrap
  );

  // A 47-row card buries everything under it. Show a readable slice, keep the
  // rest one click away, and let the filter reveal all of it.
  const limit = opts.limit ?? ROW_LIMIT;
  if (rows.length > limit) {
    rowsWrap.classList.add('collapsed');
    for (const extra of rows.slice(limit)) extra.classList.add('extra');
    const more = h(
      'button',
      {
        class: 'show-more',
        type: 'button',
        onClick: () => {
          const collapsed = rowsWrap.classList.toggle('collapsed');
          more.textContent = collapsed ? `Show all ${rows.length}` : 'Show fewer';
        }
      },
      `Show all ${rows.length}`
    );
    node.append(more);
  }

  cards.push({ id, title, count: rows.length, node, stemClass });
  return node;
}

// ---------------------------------------------------------------------------
// render one API
// ---------------------------------------------------------------------------

function show(api) {
  state.current = api;
  cards.length = 0;
  els.copyGaps.hidden = !api.comparison;
  els.genTemplates.hidden = !api.comparison;

  els.title.textContent = api.apiLabel;
  els.meta.textContent = [
    `/${api.path || ''}`,
    api.serviceUrl || 'no serviceUrl',
    `rev ${api.revision ?? '1'}`,
    api.hasApiPolicy ? 'API policy' : 'no API policy',
    api.inheritsGlobal ? 'inherits <base/>' : 'no <base/>',
    `${api.allOperations?.length ?? 0} operations`
  ].join('  ·  ');

  const nodes = [];

  if (api.comparison) nodes.push(gapCard(api.comparison));

  nodes.push(
    card(
      'backends',
      'Backends',
      'g-backend',
      api.backends.map((b) =>
        b.dynamic
          ? row(b.id, {
              missing: !b.exists,
              pill: 'dynamic',
              pillColor: 'var(--c-product)',
              sub: b.candidates?.length
                ? b.candidates.map((c) => `${c.id}${c.url ? ` → ${c.url}` : ''}`).join('\n')
                : 'built at runtime, no matching backend found',
              why: `${b.resolvedVia} · any of these can be selected at runtime`,
              refs: b.usedIn
            })
          : row(b.id, {
          missing: !b.exists,
          sub: b.url || (b.exists ? b.resourceId : 'not defined on this instance'),
          why: [
            b.title,
            b.actualName ? `defined as “${b.actualName}”` : null,
            b.confirmedByLookup ? 'confirmed by direct lookup' : null,
            b.matchedByUrl ? 'matched from the API serviceUrl' : null,
            b.hasCredentials ? 'has credentials' : null
          ]
            .filter(Boolean)
            .join(' · '),
          refs: b.usedIn
        })
      )
    ),
    card(
      'products',
      'Products',
      'g-product',
      api.products.map((p) =>
        row(p.displayName, {
          sub: p.id,
          pill: p.state,
          why: [
            p.subscriptionRequired ? 'subscription required' : 'open',
            p.approvalRequired ? 'approval required' : null,
            p.hasPolicy ? 'has product policy' : 'no product policy',
            p.namedValues?.length ? `${p.namedValues.length} named value(s) in its policy` : null
          ]
            .filter(Boolean)
            .join(' · ')
        })
      )
    ),
    card(
      'fragments',
      'Policy fragments',
      'g-fragment',
      api.fragments.map((f) =>
        row(f.id, {
          missing: !f.exists,
          sub: f.description || (f.exists ? '' : 'referenced but not defined on this instance'),
          why: [
            f.depth ? `nested ${f.depth} level(s) deep` : 'included directly',
            f.actualName ? `defined as “${f.actualName}”` : null,
            f.confirmedByLookup ? 'confirmed by direct lookup' : null,
            f.namedValues?.length ? `brings in ${f.namedValues.length} named value(s)` : null
          ]
            .filter(Boolean)
            .join(' · '),
          refs: f.usedIn
        })
      )
    ),
    card(
      'named-values',
      'Named values',
      'g-namedvalue',
      api.namedValues.map((nv) =>
        row(nv.token, {
          missing: !nv.exists,
          pill: nv.keyVault ? 'key vault' : nv.secret ? 'secret' : null,
          pillColor: nv.keyVault ? 'var(--c-vault)' : null,
          sub: nv.keyVault
            ? `${nv.keyVault.vaultName} / ${nv.keyVault.secretName}${nv.keyVault.pinnedVersion ? ' (pinned version)' : ''}`
            : nv.secret
            ? '•••••• stored as secret'
            : nv.value ?? (nv.exists ? '' : 'not defined on this instance'),
          why: [
            nv.actualName ? `defined as “${nv.actualName}”` : null,
            nv.confirmedByLookup ? 'confirmed by direct lookup' : null,
            nv.tags?.length ? `tags: ${nv.tags.join(', ')}` : null
          ]
            .filter(Boolean)
            .join(' · '),
          refs: nv.usedIn
        })
      ),
      { note: 'Liquid variables and expression brace-escapes are excluded from this list.' }
    ),
    card(
      'key-vault',
      'Azure Key Vault',
      'g-vault',
      api.keyVault.flatMap((vault) =>
        vault.secrets.map((secret) =>
          row(`${vault.vaultName} / ${secret.secretName}`, {
            sub: `via ${secret.source}`,
            why: [
              secret.version ? `version ${secret.version.slice(0, 8)}` : 'latest version',
              secret.identityClientId ? `identity ${secret.identityClientId}` : null,
              secret.lastStatus?.code && secret.lastStatus.code !== 'Success'
                ? `refresh ${secret.lastStatus.code}`
                : null
            ]
              .filter(Boolean)
              .join(' · '),
            missing: secret.lastStatus?.code && secret.lastStatus.code !== 'Success'
          })
        )
      )
    ),
    card(
      'certificates',
      'Certificates',
      'g-plain',
      api.certificates.map((c) =>
        row(c.id, {
          missing: !c.exists,
          sub: c.subject || '',
          why: [c.thumbprint, c.expiry ? `expires ${c.expiry.slice(0, 10)}` : null]
            .filter(Boolean)
            .join(' · '),
          refs: c.usedIn
        })
      )
    ),
    card(
      'broken',
      'Broken links',
      'g-issue',
      [
        ...api.unresolvedNamedValues.map((u) =>
          row(`{{${u.name}}}`, { missing: true, why: u.reason, refs: u.occurrences })
        ),
        ...api.variableLookalikes.map((u) =>
          row(`{{${u.name}}}`, { missing: true, pill: 'variable', why: u.reason, refs: u.occurrences })
        ),
        ...api.backends.filter((b) => !b.exists).map((b) => row(b.id, { missing: true, why: 'backend not defined' })),
        ...api.fragments.filter((f) => !f.exists).map((f) => row(f.id, { missing: true, why: 'fragment not defined' }))
      ]
    ),
    card(
      'variables',
      'Variables',
      'g-variable',
      api.variables.map((v) =>
        row(v.name, {
          pill: v.readOnly ? 'read only' : 'set + read',
          why: v.readOnly
            ? 'read but never set in the policies read here'
            : `set in ${v.written.length} place(s), read in ${v.read.length}`,
          refs: [...v.written, ...v.read]
        })
      ),
      {
        limit: 8,
        note: 'Runtime state, not configuration. Listed separately so it is never counted as a dependency.'
      }
    ),
    card(
      'excluded',
      'Excluded moustaches',
      'g-plain',
      [
        ...api.liquidTokens.map((t) => row(`{{${t.name}}}`, { pill: 'liquid', why: t.reason })),
        ...api.ambiguousTokens.map((t) => row(`{{${t.name}}}`, { pill: 'ignored', why: t.reason }))
      ]
    ),
    card(
      'other',
      'Other links',
      'g-plain',
      [
        api.versionSet
          ? row(api.versionSet.displayName || api.versionSet.id, {
              missing: !api.versionSet.exists,
              pill: 'version set',
              why: api.versionSet.versioningScheme
            })
          : null,
        ...api.auth.map((a) => row(a.id, { missing: !a.exists, pill: a.kind, sub: a.detail })),
        ...api.diagnostics.map((d) =>
          row(d.loggerId || d.id, {
            pill: d.loggerType || 'logger',
            sub: d.resourceId || '',
            why: d.samplingPercentage != null ? `sampling ${d.samplingPercentage}%` : d.viaPolicy || ''
          })
        ),
        ...api.caches.map((c) => row(c, { pill: 'cache' })),
        ...api.identities.map((i) => row(i.resource, { pill: 'managed identity', sub: i.clientId || 'system-assigned' })),
        ...api.urls.map((u) => row(u.url, { pill: 'url', refs: u.usedIn }))
      ].filter(Boolean)
    ),
    card(
      'operations',
      'Operations',
      'g-plain',
      (api.allOperations || []).map((op) => {
        const detail = api.operations.find((o) => o.id === op.id);
        return row(op.displayName, {
          pill: op.method,
          sub: op.urlTemplate,
          why: detail
            ? [
                detail.namedValues?.length ? `${detail.namedValues.length} named value(s)` : null,
                detail.backends?.length ? `${detail.backends.length} backend(s)` : null,
                detail.fragments?.length ? `${detail.fragments.length} fragment(s)` : null
              ]
                .filter(Boolean)
                .join(' · ') || 'has its own policy'
            : 'no operation policy'
        });
      }),
      { wide: true, limit: 40 }
    ),
    card(
      'sources',
      'Policies read',
      'g-plain',
      api.sourcesRead.map((source) =>
        row(source.label, {
          pill: source.repaired ? 'repaired' : source.scopeType,
          missing: !!source.parseError,
          sub: source.hasPolicy ? `${source.length} chars` : 'no policy at this scope',
          why: source.parseError
            ? `not well-formed: ${source.parseError.slice(0, 120)}`
            : `${source.found} dependency reference(s) found here`
        })
      ),
      {
        wide: true,
        note:
          `The instance defines ${api.catalogSummary.namedValues} named values, ` +
          `${api.catalogSummary.backends} backends and ${api.catalogSummary.fragments} fragments.`
      }
    )
  );

  if (api.policyXml) {
    const node = h(
      'section',
      { class: 'card g-plain wide', id: 'policy' },
      h('header', null, h('h2', null, 'API policy XML'), h('span', { class: 'count' }, `${api.policyXml.length} chars`)),
      h('pre', { class: 'policy-pre' }, api.policyXml)
    );
    cards.push({ id: 'policy', title: 'API policy XML', count: 1, node, stemClass: 'g-plain' });
    nodes.push(node);
  }

  const top = h('div', { class: 'report-top' });
  const columns = h('div', { class: 'report-columns' });
  const wide = h('div', { class: 'report-wide' });
  for (const node of nodes.filter(Boolean)) {
    if (node.id === 'gaps') top.append(node);
    else if (node.classList.contains('wide')) wide.append(node);
    else columns.append(node);
  }
  els.main.replaceChildren(top, columns, wide);
  if (state.view === 'explorer') renderExplorer();
  if (document.body.classList.contains('tree-mode')) {
    els.main.append(h('div', { id: 'tree-root', class: 'tree-root' }, buildTree(api)));
  }

  renderNav();
  applyFilter();
}

function gapCard(comparison) {
  const columns = [];
  const sections = [
    ['missing', 'Missing in target', 'g-target'],
    ['broken', 'Present but broken', 'g-target'],
    ['unlinked', 'Not linked to this API', 'g-product'],
    ['probable', 'Matched after normalisation', 'g-plain'],
    ['differs', 'Present with differences', 'g-plain']
  ];

  for (const [verdict, title, stem] of sections) {
    const entries = comparison.items.filter((i) => i.verdict === verdict);
    if (!entries.length) continue;
    columns.push(
      h(
        'section',
        { class: stem },
        h('h3', null, `${title} (${entries.length})`),
        h(
          'div',
          { class: 'rows' },
          ...entries.map((entry) =>
            row(entry.name, {
              pill: entry.kind,
              sub: entry.detail || '',
              why: entry.targetName ? `target resource is named “${entry.targetName}”` : null,
              missing: verdict === 'missing' || verdict === 'broken'
            })
          )
        )
      )
    );
  }

  const ops = comparison.operations;
  if (ops) {
    const opColumn = (title, list, stem, missing) =>
      list.length
        ? columns.push(
            h(
              'section',
              { class: stem },
              h('h3', null, `${title} (${list.length})`),
              h(
                'div',
                { class: 'rows' },
                ...list.map((o) =>
                  row(o.displayName || o.id, {
                    pill: o.method,
                    sub: o.differences ? o.differences.join(' · ') : o.urlTemplate,
                    why: o.id,
                    missing
                  })
                )
              )
            )
          )
        : null;
    opColumn('Operations missing in target', ops.missingInTarget, 'g-target', true);
    opColumn('Operations only in target', ops.extraInTarget, 'g-product', false);
    opColumn('Operations that differ', ops.changed, 'g-target', true);
  }

  if (comparison.settings?.length) {
    columns.push(
      h(
        'section',
        { class: 'g-plain' },
        h('h3', null, `API settings that differ (${comparison.settings.length})`),
        h(
          'div',
          { class: 'rows' },
          ...comparison.settings.map((s) =>
            row(s.name, {
              sub: `${s.source}  →  ${s.target}`,
              why: s.expected ? 'usually expected to differ per environment' : 'likely drift',
              missing: !s.expected
            })
          )
        )
      )
    );
  }

  const counts = comparison.counts;
  const node = h(
    'section',
    { class: 'card g-target wide', id: 'gaps' },
    h(
      'header',
      null,
      h('h2', null, `Target: ${comparison.target}`),
      h(
        'span',
        { class: 'count' },
        `${counts.missing} missing · ${counts.broken} broken · ${counts.unlinked} unlinked · ` +
          `${counts.probable} normalised · ` +
          (comparison.apiExistsInTarget ? 'API present' : 'API absent') +
          (ops ? ` · operations ${ops.sourceCount}/${ops.targetCount}` : '')
      )
    ),
    columns.length
      ? h('div', { class: 'gap-columns' }, ...columns)
      : h('p', { class: 'card-note' }, 'Every dependency and operation matches in the target instance.')
  );

  cards.push({ id: 'gaps', title: `Target: ${comparison.target}`, count: comparison.blocking, node, stemClass: 'g-target' });
  return node;
}

// ---------------------------------------------------------------------------
// tree view
// ---------------------------------------------------------------------------

const KIND_CLASS = {
  backend: 'g-backend',
  product: 'g-product',
  fragment: 'g-fragment',
  'named value': 'g-namedvalue',
  certificate: 'g-plain',
  logger: 'g-plain',
  url: 'g-plain',
  operation: 'g-plain',
  policy: 'g-plain',
  missing: 'g-issue'
};

function treeNode({ label, kind, detail, children, open }) {
  const cls = KIND_CLASS[kind] || 'g-plain';
  const head = h(
    'span',
    { class: 'tnode-head' },
    h('span', { class: 'tkind' }, kind),
    h('span', { class: 'tlabel' }, label),
    detail ? h('span', { class: 'tdetail' }, detail) : null
  );

  if (!children || !children.length) {
    return h('li', { class: `tnode ${cls}` }, head);
  }
  return h(
    'li',
    { class: `tnode ${cls}` },
    h(
      'details',
      open ? { open: true } : null,
      h('summary', null, head, h('span', { class: 'tcount' }, `${children.length}`)),
      h('ul', null, ...children)
    )
  );
}

/**
 * Builds the tree from the per-scope reference lists: each policy document is a
 * branch holding only what it references directly, and a fragment branch expands
 * into that fragment's own document.
 */
function buildTree(api) {
  const scopes = api.scopes || [];
  const scopeByFragment = new Map();
  for (const scope of scopes) {
    if (scope.type === 'fragment') {
      const id = scope.scope.replace(/^fragment:/, '');
      scopeByFragment.set(id.toLowerCase(), scope);
    }
  }
  const fragmentMeta = new Map((api.fragments || []).map((f) => [f.id.toLowerCase(), f]));
  const backendMeta = new Map((api.backends || []).map((b) => [String(b.id).toLowerCase(), b]));
  const nvMeta = new Map((api.namedValues || []).map((n) => [n.token.toLowerCase(), n]));

  const leaves = (scope, seen) => {
    const out = [];
    for (const id of scope.fragments) {
      const key = id.toLowerCase();
      const meta = fragmentMeta.get(key);
      if (seen.has(key)) {
        out.push(treeNode({ label: id, kind: 'fragment', detail: 'already expanded above' }));
        continue;
      }
      const child = scopeByFragment.get(key);
      const nextSeen = new Set(seen).add(key);
      out.push(
        treeNode({
          label: id,
          kind: meta && !meta.exists ? 'missing' : 'fragment',
          detail: meta?.exists === false ? 'not defined' : meta?.description || null,
          children: child ? leaves(child, nextSeen) : []
        })
      );
    }
    for (const entry of scope.backendEntries || scope.backends.map((k) => ({ key: k }))) {
      const meta = backendMeta.get(String(entry.raw || entry.key).toLowerCase());
      out.push(
        treeNode({
          label: entry.raw || entry.key,
          kind: meta && !meta.exists ? 'missing' : 'backend',
          detail: meta?.dynamic
            ? `dynamic → ${meta.candidates?.map((c) => c.id).join(', ') || 'no match'}`
            : meta?.url || null
        })
      );
    }
    for (const token of scope.namedValues) {
      const meta = nvMeta.get(token.toLowerCase());
      out.push(
        treeNode({
          label: token,
          kind: meta && !meta.exists ? 'missing' : 'named value',
          detail: meta?.keyVault
            ? `key vault ${meta.keyVault.vaultName}/${meta.keyVault.secretName}`
            : meta?.secret
            ? 'secret'
            : meta?.value ?? null
        })
      );
    }
    for (const id of scope.certificates) out.push(treeNode({ label: id, kind: 'certificate' }));
    for (const id of scope.loggers) out.push(treeNode({ label: id, kind: 'logger' }));
    for (const url of scope.urls) out.push(treeNode({ label: url, kind: 'url' }));
    for (const name of scope.unresolved) {
      out.push(treeNode({ label: `{{${name}}}`, kind: 'missing', detail: 'named value not defined' }));
    }
    return out;
  };

  const branches = [];
  for (const scope of scopes) {
    if (scope.type === 'fragment') continue; // reached through whoever includes it
    const children = leaves(scope, new Set());
    if (!children.length && !scope.hasPolicy) continue;
    branches.push(
      treeNode({
        label: scope.label,
        kind: scope.type === 'product' ? 'product' : scope.type === 'operation' ? 'operation' : 'policy',
        detail: scope.hasPolicy ? null : 'no policy',
        children,
        open: scope.type === 'api'
      })
    );
  }

  return h(
    'ul',
    { class: 'tree' },
    treeNode({
      label: api.apiLabel,
      kind: 'policy',
      detail: `/${api.path || ''}`,
      children: branches,
      open: true
    })
  );
}

const VIEWS = ['cards', 'tree', 'explorer'];
const NEXT_LABEL = { cards: 'Tree view', tree: 'Explorer', explorer: 'Card view' };

function cycleView() {
  const current = state.view || 'cards';
  setView(VIEWS[(VIEWS.indexOf(current) + 1) % VIEWS.length]);
}

function setView(view) {
  state.view = view;
  document.body.classList.toggle('tree-mode', view === 'tree');
  document.body.classList.toggle('explorer-mode', view === 'explorer');
  els.viewToggle.textContent = NEXT_LABEL[view];

  if (view === 'tree' && !$('#tree-root')) {
    els.main.append(h('div', { id: 'tree-root', class: 'tree-root' }, buildTree(state.current)));
  }
  if (view === 'explorer') renderExplorer();
}


// ---------------------------------------------------------------------------
// explorer: tree on the left, source | target detail on the right
// ---------------------------------------------------------------------------

const explorer = {
  client: null,
  source: null,
  target: null,
  selected: null,
  policyCache: new Map(),
  raw: false
};

/**
 * The report window is an extension page, so it holds the same host permissions
 * as the panel and can call ARM directly. The token lives in session storage
 * where the panel put it.
 */
function initExplorer(payload) {
  // payload.apiVersion is written by the panel; fall back if an older report
  // is reopened from session storage.
  explorer.client = new ArmClient({
    getToken: async () => {
      const stored = await chrome.storage.session.get('manualToken');
      return stored?.manualToken || null;
    },
    concurrency: 4
  });
  const version = payload.apiVersion || '2022-08-01';
  if (payload.service) explorer.source = new ApimService(explorer.client, payload.service, version);
  if (payload.target) explorer.target = new ApimService(explorer.client, payload.target, version);
}

/** Cache key covers side + kind + id so nothing collides. */
async function policyFor(side, kind, id, opId) {
  const svc = side === 'target' ? explorer.target : explorer.source;
  if (!svc) return { xml: null, unavailable: 'no instance configured' };

  const key = `${side}:${kind}:${id}:${opId || ''}`;
  if (explorer.policyCache.has(key)) return explorer.policyCache.get(key);

  const load = async () => {
    try {
      if (kind === 'api') return { xml: await svc.getApiPolicy(id) };
      if (kind === 'operation') return { xml: await svc.getOperationPolicy(id, opId) };
      if (kind === 'product') return { xml: await svc.getProductPolicy(id) };
      if (kind === 'fragment') return { xml: await svc.getFragmentPolicy(id) };
      return { xml: null };
    } catch (err) {
      if (err.name === 'AuthError') return { xml: null, unavailable: err.message };
      return { xml: null, unavailable: err.message };
    }
  };

  const promise = load();
  explorer.policyCache.set(key, promise);
  return promise;
}

async function resourceFor(side, kind, id) {
  const svc = side === 'target' ? explorer.target : explorer.source;
  if (!svc) return null;
  try {
    if (kind === 'backend') return await svc.getBackend(id);
    if (kind === 'named value') return await svc.getNamedValue(id);
    if (kind === 'certificate') return await svc.getCertificate(id);
  } catch {
    return null;
  }
  return null;
}

// --- selectable tree --------------------------------------------------------

function explorerNode(entry, depth = 0) {
  const cls = KIND_CLASS[entry.kind] || 'g-plain';
  const head = h(
    'button',
    {
      class: `xnode-head ${cls}`,
      type: 'button',
      style: `padding-left:${8 + depth * 13}px`,
      onClick: () => selectNode(entry)
    },
    h('span', { class: 'tkind' }, entry.kind),
    h('span', { class: 'tlabel' }, entry.label),
    entry.badge ? h('span', { class: 'xbadge' }, entry.badge) : null
  );
  entry.el = head;

  if (!entry.children?.length) return h('li', { class: 'xnode' }, head);
  return h(
    'li',
    { class: 'xnode' },
    h(
      'details',
      entry.open ? { open: true } : null,
      h('summary', null, head),
      h('ul', null, ...entry.children.map((child) => explorerNode(child, depth + 1)))
    )
  );
}

/** Flat, selectable model of everything worth opening a detail pane on. */
function explorerModel(api) {
  const children = [];

  children.push({
    kind: 'policy',
    label: 'API policy',
    detailKind: 'policy',
    policy: { kind: 'api', id: api.apiId },
    open: true
  });

  if (api.allOperations?.length) {
    children.push({
      kind: 'operation',
      label: `Operations (${api.allOperations.length})`,
      detailKind: 'summary',
      summary: 'operations',
      children: api.allOperations.map((op) => ({
        kind: 'operation',
        label: op.displayName,
        badge: op.method,
        detailKind: 'policy',
        policy: { kind: 'operation', id: api.apiId, opId: op.id },
        meta: op
      }))
    });
  }

  if (api.products?.length) {
    children.push({
      kind: 'product',
      label: `Products (${api.products.length})`,
      detailKind: 'summary',
      summary: 'products',
      children: api.products.map((p) => ({
        kind: 'product',
        label: p.displayName,
        badge: p.state,
        detailKind: 'policy',
        policy: { kind: 'product', id: p.id },
        meta: p
      }))
    });
  }

  if (api.fragments?.length) {
    children.push({
      kind: 'fragment',
      label: `Policy fragments (${api.fragments.length})`,
      detailKind: 'summary',
      summary: 'fragments',
      children: api.fragments.map((f) => ({
        kind: f.exists ? 'fragment' : 'missing',
        label: f.id,
        badge: f.depth ? `L${f.depth}` : null,
        detailKind: 'policy',
        policy: { kind: 'fragment', id: f.id },
        meta: f
      }))
    });
  }

  if (api.backends?.length) {
    children.push({
      kind: 'backend',
      label: `Backends (${api.backends.length})`,
      detailKind: 'summary',
      summary: 'backends',
      children: api.backends.map((b) => ({
        kind: b.exists ? 'backend' : 'missing',
        label: b.id,
        badge: b.dynamic ? 'dyn' : null,
        detailKind: 'resource',
        resource: { kind: 'backend', id: b.dynamic ? b.candidates?.[0]?.id : b.id },
        meta: b
      }))
    });
  }

  if (api.namedValues?.length) {
    children.push({
      kind: 'named value',
      label: `Named values (${api.namedValues.length})`,
      detailKind: 'summary',
      summary: 'namedValues',
      children: api.namedValues.map((n) => ({
        kind: n.exists ? 'named value' : 'missing',
        label: n.token,
        badge: n.keyVault ? 'kv' : n.secret ? 'sec' : null,
        detailKind: 'resource',
        resource: { kind: 'named value', id: n.id || n.token },
        meta: n
      }))
    });
  }

  if (api.certificates?.length) {
    children.push({
      kind: 'certificate',
      label: `Certificates (${api.certificates.length})`,
      detailKind: 'summary',
      summary: 'certificates',
      children: api.certificates.map((c) => ({
        kind: c.exists ? 'certificate' : 'missing',
        label: c.id,
        detailKind: 'resource',
        resource: { kind: 'certificate', id: c.id },
        meta: c
      }))
    });
  }

  return {
    kind: 'policy',
    label: api.apiLabel,
    badge: `/${api.path || ''}`,
    detailKind: 'overview',
    open: true,
    children
  };
}

// --- detail rendering -------------------------------------------------------

function diffPane(rows, side) {
  const wrap = h('div', { class: 'diff-pane' });
  for (const rowEntry of rows) {
    if (rowEntry.type === 'gap') {
      wrap.append(h('div', { class: 'dline gap' }, `⋯ ${rowEntry.count} unchanged`));
      continue;
    }
    const isLeft = side === 'source';
    // A line added on the right has no left counterpart, and vice versa; render
    // a spacer so the two panes stay aligned as you scroll.
    const blank = (isLeft && rowEntry.type === 'add') || (!isLeft && rowEntry.type === 'del');
    const no = isLeft ? rowEntry.leftNo : rowEntry.rightNo;
    wrap.append(
      h(
        'div',
        { class: `dline ${blank ? 'blank' : rowEntry.type}` },
        h('span', { class: 'dno' }, blank ? '' : String(no ?? '')),
        h('span', { class: 'dtext' }, blank ? '' : rowEntry.text)
      )
    );
  }
  return wrap;
}

function detailHeader(title, subtitle, extra) {
  return h(
    'div',
    { class: 'detail-head' },
    h('h2', null, title),
    subtitle ? h('span', { class: 'detail-sub' }, subtitle) : null,
    extra || null
  );
}

async function showPolicyDetail(entry) {
  const pane = els.detail;
  pane.replaceChildren(
    detailHeader(entry.label, entry.kind),
    h('p', { class: 'loading' }, 'Reading policy')
  );

  const spec = entry.policy;
  const [source, target] = await Promise.all([
    policyFor('source', spec.kind, spec.id, spec.opId),
    explorer.target ? policyFor('target', spec.kind, spec.id, spec.opId) : Promise.resolve(null)
  ]);

  if (state.detailToken !== entry) return; // a newer selection won the race

  const normSource = explorer.raw
    ? { text: source.xml || '', ok: true }
    : normalizeXml(source.xml || '');
  const normTarget = target
    ? explorer.raw
      ? { text: target.xml || '', ok: true }
      : normalizeXml(target.xml || '')
    : null;

  const rawToggle = h(
    'button',
    {
      class: 'link',
      type: 'button',
      onClick: () => {
        explorer.raw = !explorer.raw;
        selectNode(entry);
      }
    },
    explorer.raw ? 'normalised view' : 'raw view'
  );

  if (!normTarget) {
    // No target configured: single pane.
    pane.replaceChildren(
      detailHeader(entry.label, entry.kind, rawToggle),
      source.unavailable
        ? h('p', { class: 'note' }, source.unavailable)
        : source.xml
        ? h('pre', { class: 'policy-pre' }, normSource.text)
        : h('p', { class: 'note' }, 'No policy defined at this scope.')
    );
    return;
  }

  const rows = diffLines(normSource.text, normTarget.text);
  const stats = diffStats(rows);
  const shown = stats.identical ? rows : collapseUnchanged(rows, 4);

  const verdict = stats.identical
    ? h('span', { class: 'verdict same' }, 'identical')
    : h('span', { class: 'verdict diff' }, `+${stats.added} / −${stats.removed}`);

  pane.replaceChildren(
    detailHeader(entry.label, entry.kind, h('span', { class: 'head-extra' }, verdict, rawToggle)),
    h(
      'div',
      { class: 'diff-grid' },
      h(
        'div',
        { class: 'diff-col' },
        h('h3', null, 'Source', h('span', { class: 'diff-sub' }, explorer.source?.label || '')),
        source.xml ? diffPane(shown, 'source') : h('p', { class: 'note' }, 'No policy at this scope.')
      ),
      h(
        'div',
        { class: 'diff-col' },
        h('h3', null, 'Target', h('span', { class: 'diff-sub' }, explorer.target?.label || '')),
        target.unavailable
          ? h('p', { class: 'note' }, target.unavailable)
          : target.xml
          ? diffPane(shown, 'target')
          : h('p', { class: 'note' }, 'Not defined in the target.')
      )
    )
  );
}

const BACKEND_FIELDS = [
  { key: 'url', label: 'URL' },
  { key: 'protocol', label: 'Protocol' },
  { key: 'title', label: 'Title' },
  { key: 'description', label: 'Description' },
  { key: 'resourceId', label: 'Resource ID' }
];

async function showResourceDetail(entry) {
  const pane = els.detail;
  pane.replaceChildren(detailHeader(entry.label, entry.kind), h('p', { class: 'loading' }, 'Reading resource'));

  const kind = entry.resource.kind;
  const id = entry.resource.id;
  const [source, target] = await Promise.all([
    resourceFor('source', kind, id),
    explorer.target ? resourceFor('target', kind, id) : Promise.resolve(null)
  ]);
  if (state.detailToken !== entry) return;

  let fields;
  if (kind === 'backend') {
    fields = diffFields(source?.properties, target?.properties, [
      ...BACKEND_FIELDS,
      {
        key: 'credentials',
        label: 'Credentials',
        format: (v) => (v ? Object.keys(v).join(', ') : null)
      }
    ]);
  } else if (kind === 'named value') {
    // Secrets are never shown side by side; only whether they match.
    const mask = (props) =>
      props
        ? {
            value: props.secret ? '••••••' : props.value,
            secret: props.secret ? 'yes' : 'no',
            keyVault: props.keyVault?.secretIdentifier || null,
            identity: props.keyVault?.identityClientId || null,
            refresh: props.keyVault?.lastStatus?.code || null,
            tags: props.tags?.join(', ') || null
          }
        : null;
    fields = diffFields(mask(source?.properties), mask(target?.properties), [
      { key: 'value', label: 'Value' },
      { key: 'secret', label: 'Secret' },
      { key: 'keyVault', label: 'Key Vault secret' },
      { key: 'identity', label: 'Identity' },
      { key: 'refresh', label: 'Last refresh' },
      { key: 'tags', label: 'Tags' }
    ]);
    for (const row of fields) {
      if (row.key === 'value' && source?.properties?.secret) {
        row.differs = false;
        row.note = 'secret values are not compared';
      }
    }
  } else {
    fields = diffFields(source?.properties, target?.properties, [
      { key: 'subject', label: 'Subject' },
      { key: 'thumbprint', label: 'Thumbprint' },
      { key: 'expirationDate', label: 'Expires' }
    ]);
  }

  const meta = entry.meta || {};
  const extras = [];
  if (meta.dynamic) {
    extras.push(
      h(
        'p',
        { class: 'note' },
        `Selected at runtime (${meta.resolvedVia}). Candidates: ${
          meta.candidates?.map((c) => c.id).join(', ') || 'none matched'
        }`
      )
    );
  }
  if (meta.usedIn?.length) {
    const scopes = [...new Set(meta.usedIn.map((o) => o.scope).filter(Boolean))];
    if (scopes.length) extras.push(h('p', { class: 'note' }, `Used in ${scopes.join(', ')}`));
  }

  const differing = fields.filter((f) => f.differs).length;
  pane.replaceChildren(
    detailHeader(
      entry.label,
      entry.kind,
      explorer.target
        ? differing
          ? h('span', { class: 'verdict diff' }, `${differing} field(s) differ`)
          : h('span', { class: 'verdict same' }, 'identical')
        : null
    ),
    ...extras,
    h(
      'table',
      { class: 'field-table' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, 'Field'),
          h('th', null, 'Source'),
          explorer.target ? h('th', null, 'Target') : null
        )
      ),
      h(
        'tbody',
        null,
        ...fields.map((f) =>
          h(
            'tr',
            { class: f.differs ? 'differs' : null },
            h('td', null, f.label),
            h('td', null, f.source ?? '—'),
            explorer.target ? h('td', null, f.note || (f.target ?? '—')) : null
          )
        )
      )
    ),
    !source && !target ? h('p', { class: 'note' }, 'Not found in either instance.') : null
  );
}

function showOverview(api) {
  const c = api.counts || {};
  els.detail.replaceChildren(
    detailHeader(api.apiLabel, `/${api.path || ''}`),
    h(
      'p',
      { class: 'note' },
      'Pick anything on the left to see its detail. Policies show a source/target diff; ' +
        'backends, named values and certificates show a field comparison.'
    ),
    h(
      'table',
      { class: 'field-table' },
      h(
        'tbody',
        null,
        ...[
          ['Service URL', api.serviceUrl || '—'],
          ['Revision', api.revision ?? '1'],
          ['Operations', String(api.allOperations?.length ?? 0)],
          ['Backends', String(c.backends ?? 0)],
          ['Products', String(c.products ?? 0)],
          ['Fragments', String(c.fragments ?? 0)],
          ['Named values', String(c.namedValues ?? 0)],
          ['Key Vault secrets', String(c.keyVault ?? 0)],
          ['Broken references', String(c.issues ?? 0)]
        ].map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, v)))
      )
    )
  );
}

function showSummary(entry, api) {
  const map = {
    operations: api.allOperations || [],
    products: api.products || [],
    fragments: api.fragments || [],
    backends: api.backends || [],
    namedValues: api.namedValues || [],
    certificates: api.certificates || []
  };
  const list = map[entry.summary] || [];
  els.detail.replaceChildren(
    detailHeader(entry.label, 'group'),
    h('p', { class: 'note' }, 'Select an item on the left to compare it.'),
    h(
      'ul',
      { class: 'plain-list' },
      ...list.map((x) =>
        h('li', null, x.displayName || x.token || x.id || String(x))
      )
    )
  );
}

async function selectNode(entry) {
  state.detailToken = entry;
  explorer.selected = entry;

  for (const el of document.querySelectorAll('.xnode-head.selected')) {
    el.classList.remove('selected');
  }
  entry.el?.classList.add('selected');

  try {
    if (entry.detailKind === 'policy') await showPolicyDetail(entry);
    else if (entry.detailKind === 'resource') await showResourceDetail(entry);
    else if (entry.detailKind === 'summary') showSummary(entry, state.current);
    else showOverview(state.current);
  } catch (err) {
    els.detail.replaceChildren(
      detailHeader(entry.label, entry.kind),
      h('p', { class: 'error' }, err.message)
    );
  }
}

function renderExplorer() {
  const api = state.current;
  const root = explorerModel(api);

  els.explorerTree.replaceChildren(h('ul', { class: 'xtree' }, explorerNode(root)));
  els.detail.replaceChildren();
  selectNode(root);
}

// ---------------------------------------------------------------------------
// ARM template generation
// ---------------------------------------------------------------------------

/**
 * Emits one ARM template per resource that the target is missing. Definitions
 * are read from the source instance rather than the report payload, so the
 * templates carry every property (credentials, tls, proxy) rather than only the
 * subset the dependency view needed.
 */
async function generateTemplates() {
  const api = state.current;
  const comparison = api?.comparison;
  if (!comparison) return;

  const label = els.genTemplates.textContent;
  els.genTemplates.textContent = 'Generating…';
  els.genTemplates.disabled = true;

  try {
    const missing = comparison.items.filter((i) => i.verdict === 'missing');
    const wantNamedValues = missing.filter((i) => i.kind === 'named value').map((i) => i.name);
    const wantBackends = missing
      .filter((i) => i.kind === 'backend' || i.kind === 'backend (dynamic)')
      .flatMap((i) =>
        i.kind === 'backend (dynamic)'
          ? // A dynamic backend lists its absent candidates in the detail text.
            (api.backends.find((b) => b.id === i.name)?.candidates || []).map((c) => c.id)
          : [i.name]
      );
    const wantFragments = missing.filter((i) => i.kind === 'policy fragment').map((i) => i.name);

    if (!wantNamedValues.length && !wantBackends.length && !wantFragments.length) {
      els.genTemplates.textContent = 'Nothing missing';
      setTimeout(() => {
        els.genTemplates.textContent = label;
      }, 1600);
      return;
    }

    const [namedValues, backends, fragments] = await Promise.all([
      Promise.all(wantNamedValues.map((name) => resourceFor('source', 'named value', name))),
      Promise.all(wantBackends.map((name) => resourceFor('source', 'backend', name))),
      Promise.all(
        wantFragments.map(async (name) => {
          const xml = await policyFor('source', 'fragment', name);
          const meta = api.fragments.find((f) => f.id === name);
          return { name, description: meta?.description || '', xml: xml?.xml || '' };
        })
      )
    ]);

    const files = buildTemplateBundle({
      namedValues: namedValues.filter(Boolean),
      backends: backends.filter(Boolean),
      fragments: fragments.filter((f) => f && f.xml !== undefined),
      apiVersion: state.payload?.apiVersion || '2022-08-01',
      context: {
        source: explorer.source?.label || state.payload?.service?.serviceName,
        target: comparison.target,
        api: api.apiLabel
      }
    });

    if (!files.length) {
      els.genTemplates.textContent = 'Nothing to write';
      setTimeout(() => {
        els.genTemplates.textContent = label;
      }, 1600);
      return;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(
      `apim-templates-${safeName(comparison.target)}-${safeName(api.apiId)}-${stamp}.zip`,
      makeZip(files)
    );

    const counts = files.filter((f) => f.name.endsWith('.json') && f.name.includes('/')).length;
    els.genTemplates.textContent = `${counts} template(s)`;
    setTimeout(() => {
      els.genTemplates.textContent = label;
    }, 2200);
  } catch (err) {
    els.genTemplates.textContent = 'Failed';
    console.error('APIM template generation failed', err);
    setTimeout(() => {
      els.genTemplates.textContent = label;
    }, 2200);
  } finally {
    els.genTemplates.disabled = false;
  }
}

const safeName = (value) => String(value || 'apim').replace(/[^A-Za-z0-9._-]+/g, '-');

function renderNav() {
  els.nav.replaceChildren(
    ...cards
      .filter((c) => c.node)
      .map((c) =>
        h(
          'a',
          { href: `#${c.id}`, class: c.stemClass },
          c.title,
          h('span', { class: 'n' }, String(c.count))
        )
      )
  );
}

function applyFilter() {
  const term = els.filter.value.trim().toLowerCase();
  for (const entry of cards) {
    if (!entry.node) continue;

    // A filtered search must be able to reach rows hidden behind "show all".
    const rowsWrap = entry.node.querySelector('.rows');
    const more = entry.node.querySelector('.show-more');
    if (rowsWrap?.querySelector('.extra')) {
      if (term) {
        rowsWrap.classList.remove('collapsed');
        more?.classList.add('hidden-by-filter');
      } else {
        rowsWrap.classList.add('collapsed');
        more?.classList.remove('hidden-by-filter');
        if (more) more.textContent = `Show all ${rowsWrap.children.length}`;
      }
    }

    let visible = 0;
    for (const item of entry.node.querySelectorAll('.row-item')) {
      const match = !term || (item.dataset.search || '').includes(term);
      item.classList.toggle('hidden-by-filter', !match);
      if (match) visible++;
    }
    const hasRows = entry.node.querySelector('.row-item');
    entry.node.classList.toggle('hidden-by-filter', !!term && !!hasRows && visible === 0);
  }
}

// ---------------------------------------------------------------------------
// text export
// ---------------------------------------------------------------------------

function toText(api) {
  const lines = [`API: ${api.apiLabel}  [${api.apiId}]`, `Path: /${api.path || ''}`];
  if (api.serviceUrl) lines.push(`Service URL: ${api.serviceUrl}`);
  lines.push('');

  const section = (title, entries) => {
    if (!entries.length) return;
    lines.push(`${title} (${entries.length})`);
    for (const entry of entries) lines.push(`  ${entry}`);
    lines.push('');
  };

  section('BACKENDS', api.backends.map((b) => `${b.id}${b.url ? `  ${b.url}` : ''}${b.exists ? '' : '  [MISSING]'}`));
  section('PRODUCTS', api.products.map((p) => `${p.displayName}  [${p.id}]`));
  section('POLICY FRAGMENTS', api.fragments.map((f) => `${f.id}${f.exists ? '' : '  [MISSING]'}`));
  section(
    'NAMED VALUES',
    api.namedValues.map(
      (n) =>
        `${n.token}${n.keyVault ? `  [key vault ${n.keyVault.vaultName}/${n.keyVault.secretName}]` : n.secret ? '  [secret]' : ''}${n.exists ? '' : '  [MISSING]'}`
    )
  );
  section(
    'KEY VAULT SECRETS',
    api.keyVault.flatMap((v) => v.secrets.map((s) => `${v.vaultName}/${s.secretName}  via ${s.source}`))
  );
  section('CERTIFICATES', api.certificates.map((c) => c.id));
  section('VARIABLES', api.variables.map((v) => `${v.name}${v.readOnly ? '  [read only]' : ''}`));
  section('OPERATIONS', (api.allOperations || []).map((o) => `${o.method} ${o.urlTemplate}  [${o.id}]`));

  if (api.comparison) {
    lines.push(comparisonToText(api.comparison, api.apiLabel));
  }
  return lines.join('\n').trimEnd();
}
