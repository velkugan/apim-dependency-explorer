/**
 * Policy diffing.
 *
 * Two policies that behave identically can differ in indentation, attribute
 * order and self-closing style. Diffing the raw text paints all of that red and
 * buries the one line that matters, so both sides are normalised first:
 * reparsed, re-indented consistently, attributes sorted.
 *
 * Attribute order is never semantically meaningful in XML, so sorting is safe.
 * Whitespace inside expression bodies and set-body content sometimes is, so
 * text nodes are left alone apart from trimming the outer edges.
 */

const VOID_SAFE = new Set();

function serializeNode(node, depth, out) {
  const indent = '  '.repeat(depth);

  if (node.nodeType === 3 /* text */ || node.nodeType === 4 /* cdata */) {
    const raw = node.nodeValue || '';
    if (!raw.trim()) return;
    // Preserve the interior of an expression or body, but present it at a
    // predictable indentation.
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const trimmed = lines.map((l) => l.trim()).filter((l, i, arr) => l || (i > 0 && i < arr.length - 1));
    for (const line of trimmed) out.push(indent + line);
    return;
  }

  if (node.nodeType === 8 /* comment */) {
    out.push(`${indent}<!--${(node.nodeValue || '').trim()}-->`);
    return;
  }

  if (node.nodeType !== 1) return;

  const tag = node.nodeName;
  const attrs = Array.from(node.attributes || [])
    .map((a) => ({ name: a.name, value: a.value }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const children = Array.from(node.childNodes).filter(
    (c) => c.nodeType === 1 || c.nodeType === 8 || ((c.nodeType === 3 || c.nodeType === 4) && (c.nodeValue || '').trim())
  );

  const attrText = attrs.map((a) => ` ${a.name}="${a.value}"`).join('');

  if (!children.length && !VOID_SAFE.has(tag)) {
    out.push(`${indent}<${tag}${attrText} />`);
    return;
  }

  // A single short text child stays on one line; it reads better and diffs
  // more precisely than splitting it across three.
  if (children.length === 1 && children[0].nodeType !== 1 && children[0].nodeType !== 8) {
    const text = (children[0].nodeValue || '').trim();
    if (text.length <= 80 && !text.includes('\n')) {
      out.push(`${indent}<${tag}${attrText}>${text}</${tag}>`);
      return;
    }
  }

  out.push(`${indent}<${tag}${attrText}>`);
  for (const child of children) serializeNode(child, depth + 1, out);
  out.push(`${indent}</${tag}>`);
}

/**
 * @returns {{ text: string, ok: boolean, error: string|null }}
 */
export function normalizeXml(xml) {
  if (!xml || !xml.trim()) return { text: '', ok: true, error: null };

  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const failure = doc.querySelector('parsererror');
  if (failure || !doc.documentElement) {
    // Fall back to the raw text so a malformed policy can still be compared.
    return {
      text: xml.replace(/\r\n/g, '\n').trimEnd(),
      ok: false,
      error: failure?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 140) || 'could not parse'
    };
  }

  const out = [];
  serializeNode(doc.documentElement, 0, out);
  return { text: out.join('\n'), ok: true, error: null };
}

/**
 * Myers-style LCS over lines, via the classic DP table. Policy documents are
 * small enough (hundreds of lines) that the quadratic table is fine and the
 * code stays readable.
 *
 * @returns {Array<{type: 'same'|'add'|'del', text: string, leftNo: number|null, rightNo: number|null}>}
 */
export function diffLines(leftText, rightText) {
  const left = leftText ? leftText.split('\n') : [];
  const right = rightText ? rightText.split('\n') : [];

  const n = left.length;
  const m = right.length;

  // Trim the common head and tail first; it keeps the table small on the
  // typical case where two policies differ in one block.
  let head = 0;
  while (head < n && head < m && left[head] === right[head]) head++;

  let tail = 0;
  while (tail < n - head && tail < m - head && left[n - 1 - tail] === right[m - 1 - tail]) tail++;

  const midLeft = left.slice(head, n - tail);
  const midRight = right.slice(head, m - tail);

  const rows = midLeft.length;
  const cols = midRight.length;
  const table = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));

  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i][j] =
        midLeft[i] === midRight[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const result = [];
  let leftNo = 1;
  let rightNo = 1;

  for (let i = 0; i < head; i++) {
    result.push({ type: 'same', text: left[i], leftNo: leftNo++, rightNo: rightNo++ });
  }

  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (midLeft[i] === midRight[j]) {
      result.push({ type: 'same', text: midLeft[i], leftNo: leftNo++, rightNo: rightNo++ });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      result.push({ type: 'del', text: midLeft[i], leftNo: leftNo++, rightNo: null });
      i++;
    } else {
      result.push({ type: 'add', text: midRight[j], leftNo: null, rightNo: rightNo++ });
      j++;
    }
  }
  while (i < rows) result.push({ type: 'del', text: midLeft[i++], leftNo: leftNo++, rightNo: null });
  while (j < cols) result.push({ type: 'add', text: midRight[j++], leftNo: null, rightNo: rightNo++ });

  for (let k = 0; k < tail; k++) {
    result.push({ type: 'same', text: left[n - tail + k], leftNo: leftNo++, rightNo: rightNo++ });
  }

  return result;
}

/** Collapses runs of unchanged lines, keeping `context` lines either side. */
export function collapseUnchanged(rows, context = 3) {
  const keep = new Array(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type === 'same') continue;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) {
      keep[j] = true;
    }
  }

  const out = [];
  let skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      if (skipped) {
        out.push({ type: 'gap', count: skipped });
        skipped = 0;
      }
      out.push(rows[i]);
    } else {
      skipped++;
    }
  }
  if (skipped) out.push({ type: 'gap', count: skipped });
  return out;
}

export function diffStats(rows) {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.type === 'add') added++;
    else if (row.type === 'del') removed++;
  }
  return { added, removed, identical: added === 0 && removed === 0 };
}

/** Field-level comparison for non-XML dependencies (backends, named values). */
export function diffFields(left, right, fields) {
  return fields
    .map(({ key, label, format }) => {
      const a = left ? left[key] : undefined;
      const b = right ? right[key] : undefined;
      const fa = a === undefined || a === null || a === '' ? null : format ? format(a) : String(a);
      const fb = b === undefined || b === null || b === '' ? null : format ? format(b) : String(b);
      return { key, label: label || key, source: fa, target: fb, differs: fa !== fb };
    })
    .filter((row) => row.source !== null || row.target !== null);
}
