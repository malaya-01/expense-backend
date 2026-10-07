/**
 * Server-side safety net for assistant Markdown before it is persisted:
 * - validates ```mermaid blocks with cheap heuristics, auto-fixes common model
 *   mistakes (unquoted labels with punctuation, HTML, `end` node ids, pie
 *   values with symbols, unclosed sequence blocks), and downgrades anything
 *   still invalid to a ```text block so the renderer never chokes;
 * - unwraps mermaid nested inside another code fence;
 * - closes a code fence left open by a truncated reply.
 * Pure (no Nest / DB imports) so it can be unit-tested standalone.
 */

export type MarkdownSanitizeResult = {
  content: string;
  changed: boolean;
  mermaidFixed: number;
  mermaidDowngraded: number;
  fencesClosed: number;
};

type Block = {
  kind: 'text' | 'fence';
  lines: string[];
  indent?: string;
  fence?: string;
  info?: string;
  closed?: boolean;
};

const FENCE_OPEN_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;

const KNOWN_OTHER_DIAGRAMS =
  /^(gantt|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|timeline|mindmap|quadrantChart|xychart-beta|gitGraph|sankey-beta|block-beta)\b/;

function splitBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let text: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const open = line.match(FENCE_OPEN_RE);
    const isOpen =
      open &&
      // Backtick info strings may not contain backticks (CommonMark).
      !(open[2][0] === '`' && open[3].includes('`'));
    if (!isOpen) {
      text.push(line);
      i += 1;
      continue;
    }
    if (text.length) {
      blocks.push({ kind: 'text', lines: text });
      text = [];
    }
    const indent = open![1];
    const fence = open![2];
    const info = open![3].trim();
    const body: string[] = [];
    let closed = false;
    i += 1;
    while (i < lines.length) {
      const candidate = lines[i];
      const close = candidate.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (
        close &&
        close[1][0] === fence[0] &&
        close[1].length >= fence.length
      ) {
        closed = true;
        i += 1;
        break;
      }
      body.push(candidate);
      i += 1;
    }
    blocks.push({ kind: 'fence', lines: body, indent, fence, info, closed });
  }
  if (text.length) blocks.push({ kind: 'text', lines: text });
  return blocks;
}

function dedent(lines: string[], indent: string): string[] {
  if (!indent) return lines;
  return lines.map((line) =>
    line.startsWith(indent) ? line.slice(indent.length) : line.replace(/^\s+/, ''),
  );
}

/** Count bracket balance outside double-quoted strings. */
function bracketsBalanced(line: string): boolean {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== pairs[ch]) return false;
    }
  }
  return !inQuote && stack.length === 0;
}

function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?>/gi, '');
}

const OPENERS: Array<[string, string]> = [
  ['((', '))'],
  ['([', '])'],
  ['[[', ']]'],
  ['[(', ')]'],
  ['{{', '}}'],
  ['[/', '/]'],
  ['[\\', '\\]'],
  ['[', ']'],
  ['(', ')'],
  ['{', '}'],
];

function quoteLabel(label: string): string {
  const cleaned = stripHtml(label)
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return `"${cleaned || ' '}"`;
}

/**
 * Rewrite node shapes so every label is a double-quoted string:
 * `A[Rent (fixed)]` → `A["Rent (fixed)"]`. Returns null when a shape cannot
 * be parsed (unbalanced), which marks the diagram invalid.
 */
function quoteNodeLabels(line: string): string | null {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"') {
      const end = line.indexOf('"', i + 1);
      if (end < 0) return null;
      out += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '|') {
      // Edge label |text|
      const end = line.indexOf('|', i + 1);
      if (end < 0) return null;
      const label = line.slice(i + 1, end);
      const trimmed = label.trim();
      if (/^".*"$/.test(trimmed)) out += `|${trimmed}|`;
      else out += `|${quoteLabel(label)}|`;
      i = end + 1;
      continue;
    }
    const idMatch = line.slice(i).match(/^[A-Za-z0-9_][\w.-]*/);
    if (idMatch && (i === 0 || /[\s>;&|-]/.test(line[i - 1]))) {
      const id = idMatch[0];
      let j = i + id.length;
      const opener = OPENERS.find(([open]) => line.startsWith(open, j));
      // Avoid treating arrows like A-->B or A---B as shapes.
      if (!opener || /-$/.test(id)) {
        out += id === 'end' ? 'End' : id;
        i = j;
        continue;
      }
      const [open, close] = opener;
      j += open.length;
      let label = '';
      if (line[j] === '"') {
        const endQuote = line.indexOf(`"${close}`, j + 1);
        if (endQuote < 0) return null;
        label = line.slice(j + 1, endQuote);
        j = endQuote + 1 + close.length;
      } else {
        let depth = 0;
        let k = j;
        let found = -1;
        while (k < line.length) {
          if (depth === 0 && line.startsWith(close, k)) {
            found = k;
            break;
          }
          const c = line[k];
          if (c === '(' || c === '[' || c === '{') depth += 1;
          else if (c === ')' || c === ']' || c === '}') {
            depth -= 1;
            if (depth < 0) break;
          }
          k += 1;
        }
        if (found < 0) return null;
        label = line.slice(j, found);
        j = found + close.length;
      }
      const safeId = id === 'end' ? 'End' : id;
      out += `${safeId}${open}${quoteLabel(label)}${close}`;
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const FLOW_PASSTHROUGH_RE =
  /^(classDef|class|style|linkStyle|click|direction|%%)\b/;

function fixFlowchart(body: string[]): string[] | null {
  const out: string[] = [];
  let subgraphs = 0;
  let sg = 0;
  let nodeLines = 0;
  for (const raw of body) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed) {
      out.push('');
      continue;
    }
    if (FLOW_PASSTHROUGH_RE.test(trimmed)) {
      // Styling is dropped: it often references undefined classes/colours.
      if (/^%%/.test(trimmed)) out.push(line);
      continue;
    }
    if (/^end\s*;?$/i.test(trimmed)) {
      subgraphs -= 1;
      if (subgraphs < 0) return null;
      out.push(line.replace(/end/i, 'end'));
      continue;
    }
    const sub = trimmed.match(/^subgraph\s+(.*)$/i);
    if (sub) {
      subgraphs += 1;
      const rest = sub[1].trim();
      const indent = line.match(/^\s*/)![0];
      if (/^[\w-]+\s*\[\s*".*"\s*\]$/.test(rest) || /^"[^"]*"$/.test(rest) || /^[\w-]+$/.test(rest)) {
        out.push(line);
      } else {
        const bracket = rest.match(/^([\w-]+)\s*\[(.*)\]$/);
        sg += 1;
        const id = bracket ? bracket[1] : `sg${sg}`;
        const title = bracket ? bracket[2] : rest;
        out.push(`${indent}subgraph ${id}[${quoteLabel(title)}]`);
      }
      continue;
    }
    const fixed = quoteNodeLabels(stripHtmlOutsideQuotes(line));
    if (fixed == null || !bracketsBalanced(fixed)) return null;
    if (/-->|---|-\.->|==>|--[ox]|~~~/.test(fixed) || /\[|\(|\{/.test(fixed)) {
      nodeLines += 1;
    } else if (!/^\s*[A-Za-z0-9_][\w.-]*\s*;?\s*$/.test(fixed)) {
      // Not an edge, a shape or a bare id: unknown syntax.
      return null;
    }
    out.push(fixed);
  }
  if (subgraphs > 0) {
    for (let k = 0; k < subgraphs; k += 1) out.push('end');
  }
  return nodeLines ? out : null;
}

function stripHtmlOutsideQuotes(line: string): string {
  // Labels get HTML stripped when quoted; strip tags elsewhere too.
  return line.replace(/<br\s*\/?>/gi, ' ');
}

function fixPie(header: string, body: string[]): string[] | null {
  const out: string[] = [];
  let slices = 0;
  for (const raw of body) {
    const trimmed = raw.trim();
    if (!trimmed || /^%%/.test(trimmed)) continue;
    if (/^title\s+/i.test(trimmed)) {
      out.push(`    ${stripHtml(trimmed).replace(/"/g, "'")}`);
      continue;
    }
    if (/^showData$/i.test(trimmed)) {
      out.push(`    showData`);
      continue;
    }
    const match = trimmed.match(/^"?([^":]+?)"?\s*:\s*(.+)$/);
    if (!match) return null;
    const label = stripHtml(match[1]).replace(/"/g, "'").trim();
    const numeric = match[2]
      .replace(/(?:rs\.?|inr|usd|eur|gbp|₹|\$|€|£|%|,|\s)/gi, '')
      .trim();
    const value = Number(numeric);
    if (!label || !Number.isFinite(value) || value < 0) return null;
    if (value === 0) continue;
    out.push(`    "${label}" : ${Math.round(value * 100) / 100}`);
    slices += 1;
  }
  if (!slices) return null;
  const head = header.replace(/"/g, '');
  return [head, ...out];
}

const SEQ_LINE_RE =
  /^(participant|actor|autonumber|activate|deactivate|title|note\s+(left|right|over)|Note\s+(left|right|over)|loop|alt|else|opt|par|and|critical|break|rect|box|end|create|destroy|%%)\b/i;
const SEQ_MESSAGE_RE =
  /^([^\s:]+?|"[^"]+")\s*(<<-{1,2}>>|-{1,2}>>|-{1,2}>|-{1,2}x|-{1,2}\))[+-]?\s*([^\s:]+?|"[^"]+")\s*(?::\s*(.*))?$/;

function fixSequence(body: string[]): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let messages = 0;
  for (const raw of body) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (SEQ_LINE_RE.test(trimmed)) {
      if (/^(loop|alt|opt|par|critical|break|rect|box)\b/i.test(trimmed)) depth += 1;
      if (/^end\b/i.test(trimmed)) {
        depth -= 1;
        if (depth < 0) return null;
      }
      out.push(`    ${stripHtml(trimmed).replace(/;/g, ',')}`);
      continue;
    }
    const msg = trimmed.match(SEQ_MESSAGE_RE);
    if (!msg) return null;
    const text = stripHtml(msg[4] || '').replace(/;/g, ',').replace(/#/g, 'No.').trim();
    out.push(`    ${msg[1]}${msg[2]}${msg[3]}: ${text || ' '}`);
    messages += 1;
  }
  for (let k = 0; k < depth; k += 1) out.push('    end');
  return messages ? out : null;
}

/** Validate and auto-fix one mermaid body; null means "render as text". */
export function fixMermaidBody(rawBody: string[]): {
  lines: string[] | null;
  changed: boolean;
} {
  const body = rawBody
    .map((line) => line.replace(/\t/g, '    '))
    // Init directives and stray fences are the most common crash sources.
    .filter((line) => !/^\s*%%\{.*\}%%\s*$/.test(line))
    .filter((line) => !/^\s*(`{3,}|~{3,})/.test(line));
  const firstIdx = body.findIndex(
    (line) => line.trim() && !/^\s*%%/.test(line),
  );
  if (firstIdx < 0) return { lines: null, changed: true };
  const header = body[firstIdx].trim().replace(/;$/, '');
  const rest = body.slice(firstIdx + 1);
  const original = rawBody.join('\n');

  let fixed: string[] | null = null;
  const flow = header.match(/^(flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?\s*$/i);
  if (flow) {
    const direction = (flow[2] || 'TD').toUpperCase();
    const lines = fixFlowchart(rest);
    fixed = lines ? [`flowchart ${direction}`, ...lines] : null;
  } else if (/^pie\b/i.test(header)) {
    fixed = fixPie(header, rest);
  } else if (/^sequenceDiagram\s*$/.test(header)) {
    const lines = fixSequence(rest);
    fixed = lines ? ['sequenceDiagram', ...lines] : null;
  } else if (KNOWN_OTHER_DIAGRAMS.test(header)) {
    const ok = rest.every((line) => {
      const quotes = (line.match(/"/g) || []).length;
      return quotes % 2 === 0 && bracketsBalanced(line.replace(/"[^"]*"/g, ''));
    });
    fixed = ok ? [header, ...rest.map((line) => stripHtml(line))] : null;
  }

  if (!fixed) return { lines: null, changed: true };
  // Trim trailing blank lines.
  while (fixed.length && !fixed[fixed.length - 1].trim()) fixed.pop();
  return { lines: fixed, changed: fixed.join('\n') !== original };
}

/** ```markdown\n```mermaid…```\n``` → the inner mermaid block. */
function unwrapNestedMermaid(text: string): string {
  return text.replace(
    /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*(?:markdown|md|text|plaintext)[ \t]*\n([ \t]*`{3}[ \t]*mermaid[ \t]*\n[\s\S]*?\n[ \t]*`{3}[ \t]*)\n[ \t]*\2[ \t]*(?=\n|$)/gi,
    (_match, lead: string, _fence: string, inner: string) => `${lead}${inner}`,
  );
}

export function sanitizeAssistantMarkdown(markdown: string): MarkdownSanitizeResult {
  const result: MarkdownSanitizeResult = {
    content: markdown,
    changed: false,
    mermaidFixed: 0,
    mermaidDowngraded: 0,
    fencesClosed: 0,
  };
  if (!markdown || !/(`{3,}|~{3,})/.test(markdown)) return result;

  const normalized = unwrapNestedMermaid(markdown.replace(/\r\n/g, '\n'));
  const blocks = splitBlocks(normalized.split('\n'));
  const out: string[] = [];

  for (const block of blocks) {
    if (block.kind === 'text') {
      out.push(...block.lines);
      continue;
    }
    const indent = block.indent || '';
    const fence = block.fence || '```';
    const info = block.info || '';
    if (/^mermaid\b/i.test(info)) {
      const body = dedent(block.lines, indent);
      const { lines, changed } = fixMermaidBody(body);
      if (lines) {
        if (changed || !block.closed || info !== 'mermaid') result.mermaidFixed += 1;
        out.push(`${indent}\`\`\`mermaid`);
        out.push(...lines.map((line) => (line ? `${indent}${line}` : line)));
        out.push(`${indent}\`\`\``);
      } else {
        result.mermaidDowngraded += 1;
        while (body.length && !body[body.length - 1].trim()) body.pop();
        out.push(`${indent}\`\`\`text`);
        out.push(...body.map((line) => (line ? `${indent}${line}` : line)));
        out.push(`${indent}\`\`\``);
      }
      if (!block.closed) result.fencesClosed += 1;
      continue;
    }
    out.push(`${indent}${fence}${info}`);
    out.push(...block.lines);
    if (!block.closed) {
      // Truncated reply: close the fence instead of dropping its content.
      while (out.length && !out[out.length - 1].trim()) out.pop();
      result.fencesClosed += 1;
    }
    out.push(`${indent}${fence}`);
  }

  const content = out.join('\n');
  result.content = content;
  result.changed =
    content !== markdown.replace(/\r\n/g, '\n') ||
    result.mermaidFixed > 0 ||
    result.mermaidDowngraded > 0 ||
    result.fencesClosed > 0;
  return result;
}
