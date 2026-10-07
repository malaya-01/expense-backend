/**
 * Fit the twin context into a character budget WITHOUT cutting JSON in half
 * (the old `.slice(0, 48000)` produced invalid JSON and silently dropped
 * whatever came last — often the categories list the model needs for
 * proposals). Arrays are halved largest-first; protected keys go last.
 * Pure (no Nest / DB imports).
 */

export function pruneEmpty(value: unknown, depth = 0): unknown {
  if (value == null) return undefined;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value
      .map((item) => pruneEmpty(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    if (depth > 8) return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = pruneEmpty(item, depth + 1);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return value;
}

type ArrayRef = { holder: any; key: string | number; path: string; size: number };

function collectArrays(value: unknown, path: string, out: ArrayRef[], holder: any, key: string | number, depth: number) {
  if (depth > 4 || value == null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (value.length > 1) {
      out.push({ holder, key, path, size: JSON.stringify(value).length });
    }
    value.forEach((item, index) => collectArrays(item, `${path}[${index}]`, out, value, index, depth + 1));
    return;
  }
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    collectArrays(child, path ? `${path}.${childKey}` : childKey, out, value, childKey, depth + 1);
  }
}

export type FitResult = { json: string; trimmed: string[] };

export function fitJsonToBudget(
  input: Record<string, unknown>,
  maxChars: number,
  options?: { protect?: string[] },
): FitResult {
  const data = (pruneEmpty(input) || {}) as Record<string, unknown>;
  const protect = new Set(options?.protect || []);
  const trimmed: string[] = [];
  const originalLengths = new Map<string, number>();
  let json = JSON.stringify(data);

  for (let guard = 0; json.length > maxChars && guard < 200; guard += 1) {
    const arrays: ArrayRef[] = [];
    collectArrays(data, '', arrays, null, '', 0);
    const isProtected = (path: string) => protect.has(path.split(/[.[]/)[0]);
    const candidates = arrays
      .filter((a) => !isProtected(a.path))
      .sort((a, b) => b.size - a.size);
    const pick = candidates[0] || arrays.sort((a, b) => b.size - a.size)[0];
    if (pick) {
      const arr = pick.holder[pick.key] as unknown[];
      if (!originalLengths.has(pick.path)) originalLengths.set(pick.path, arr.length);
      pick.holder[pick.key] = arr.slice(0, Math.max(1, Math.ceil(arr.length / 2)));
    } else {
      // No arrays left: drop the largest unprotected top-level key.
      const keys = Object.keys(data)
        .filter((key) => !protect.has(key))
        .sort((a, b) => JSON.stringify(data[b]).length - JSON.stringify(data[a]).length);
      if (!keys.length) break;
      trimmed.push(`${keys[0]} (omitted)`);
      delete data[keys[0]];
    }
    json = JSON.stringify(data);
  }

  for (const [path, before] of originalLengths) {
    const parts = path.split('.');
    let node: any = data;
    for (const part of parts) node = node?.[part];
    if (Array.isArray(node) && node.length < before) {
      trimmed.push(`${path}: showing ${node.length} of ${before}`);
    }
  }
  if (trimmed.length) {
    (data as Record<string, unknown>).context_note =
      `Partial data (size limit): ${trimmed.join('; ')}. Do not infer totals from truncated lists — use overview/cash_flow figures.`;
    json = JSON.stringify(data);
  }
  if (json.length > maxChars * 1.15) {
    // Last resort: keep the protected keys only.
    const minimal: Record<string, unknown> = {};
    for (const key of protect) if (key in data) minimal[key] = data[key];
    minimal.context_note = 'Most twin data omitted for size; ask the user to narrow the question.';
    json = JSON.stringify(minimal);
  }
  return { json, trimmed };
}

/** Trim free-text list items (memories, cross-chat snippets) to fit. */
export function fitStringList(items: string[], maxChars: number, perItem = 600): string {
  const out: string[] = [];
  let used = 2;
  for (const raw of items) {
    const item = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, perItem);
    if (!item) continue;
    const cost = JSON.stringify(item).length + 1;
    if (used + cost > maxChars) break;
    out.push(item);
    used += cost;
  }
  return JSON.stringify(out);
}
