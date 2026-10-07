import type { ChatMessage } from './types';

/**
 * Automatic continuation for replies that stop on the output-token limit.
 * Pure helpers: shared by the generic provider wrapper (providers/index.ts)
 * and the Opal Free race adapter (omniroute.adapter.ts).
 */

/** Extra requests issued after a max_tokens / length stop (0-4, default 2). */
export const MAX_CONTINUATIONS = Math.max(
  0,
  Math.min(4, Number(process.env.AI_MAX_CONTINUATIONS ?? 2) || 0),
);

/**
 * Sent as a USER turn (never an assistant prefill: newer Anthropic models
 * reject prefill, and a user turn works the same on every provider).
 */
export const CONTINUE_PROMPT =
  'Your previous reply was cut off by the output limit. Continue exactly where you stopped. ' +
  'Do not repeat any earlier text, do not restart, and do not add a preamble or apology. ' +
  'If you stopped inside a table, list or code block, keep going in the same format and do not reopen the code fence. ' +
  'Finish concisely.';

export const TRUNCATION_NOTICE =
  '\n\n_(This reply reached the length limit. Ask me to "continue" for the rest.)_';

export function isTruncationReason(reason: unknown): boolean {
  const value = String(reason ?? '')
    .trim()
    .toLowerCase();
  return (
    value === 'length' ||
    value === 'max_tokens' ||
    value === 'max_output_tokens' ||
    value === 'model_length'
  );
}

export function buildContinuationMessages(
  messages: ChatMessage[],
  partial: string,
): ChatMessage[] {
  return [
    ...messages,
    { role: 'assistant', content: partial },
    { role: 'user', content: CONTINUE_PROMPT },
  ];
}

function countFences(text: string): number {
  let count = 0;
  for (const line of text.split('\n')) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) count += 1;
  }
  return count;
}

/** Longest suffix of `previous` that is also a prefix of `next`. */
export function findOverlap(
  previous: string,
  next: string,
  maxWindow = 400,
  minOverlap = 8,
): number {
  const tail = previous.slice(-maxWindow);
  const max = Math.min(tail.length, next.length);
  for (let len = max; len >= minOverlap; len -= 1) {
    if (tail.endsWith(next.slice(0, len))) return len;
  }
  return 0;
}

const PREAMBLE_RE =
  /^\s*(?:(?:sure|okay|ok|certainly|of course)[,.!]?\s*)?(?:(?:continuing|resuming|picking up)(?:\s+(?:from\s+)?where\s+(?:i|we)\s+(?:left\s+off|stopped))?|here(?:'s| is)\s+the\s+(?:rest|continuation)(?:\s+of\s+[^:\n]*)?)\s*[:.,-]*\s*(?:\n|$)/i;

const SUFFIX_FRAGMENT_RE =
  /^(?:ing|ed|es|s|ly|tion|tions|ment|ments|ness|er|ers|est|al|ity|ies|ive|able|ible)\b/;

/**
 * Turn a raw continuation reply into the exact text to append to `previous`:
 * drops a chatty preamble, a re-opened code fence, any repeated overlap, and
 * restores the separating space when the cut fell between two words.
 */
export function stitchPiece(previous: string, next: string): string {
  let piece = String(next ?? '');
  if (!piece.trim()) return '';

  piece = piece.replace(PREAMBLE_RE, '');

  // Still inside an open fence: the model often re-opens it ("```mermaid").
  if (countFences(previous) % 2 === 1) {
    piece = piece.replace(/^\s*(`{3,}|~{3,})[\w-]*[ \t]*\n/, '');
  }

  const overlap = findOverlap(previous, piece);
  if (overlap) piece = piece.slice(overlap);
  if (!piece) return '';

  const last = previous.slice(-1);
  const first = piece.charAt(0);
  if (/[A-Za-z0-9.,;:!?)\]*_]/.test(last) && /[A-Za-z0-9(\[*_₹$€£]/.test(first)) {
    const midWord = /[A-Za-z]/.test(last) && SUFFIX_FRAGMENT_RE.test(piece);
    if (!midWord) piece = ` ${piece}`;
  }
  return piece;
}

/**
 * Streaming variant: buffers the first characters of a continuation so the
 * overlap / preamble can be removed before anything reaches the client.
 */
export class ContinuationJoiner {
  private buffer = '';
  private released = false;

  constructor(
    private readonly previous: string,
    private readonly holdChars = 200,
  ) {}

  push(delta: string): string {
    if (this.released) return delta;
    this.buffer += delta;
    if (this.buffer.length < this.holdChars) return '';
    return this.release();
  }

  flush(): string {
    if (this.released) return '';
    return this.release();
  }

  private release(): string {
    this.released = true;
    return stitchPiece(this.previous, this.buffer);
  }
}
