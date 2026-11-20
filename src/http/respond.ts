import type { IncomingMessage, ServerResponse } from 'node:http';

export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  // frame-ancestors: another site on any 127.0.0.1 port must not frame this app.
  'content-security-policy':
    "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

/**
 * An error the client should see. `code` is a stable identifier the UI can
 * translate (`error.<code>` in public/i18n); `message` is English for logs and tests.
 */
export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, SECURITY_HEADERS).end();
}

/** Revalidate on every use: `/` (index.html), whose bundle names change with each build. */
export const NO_CACHE = 'no-cache';
/** A content-hashed URL never changes its bytes: the browser keeps it a year without asking again. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';

export type ContentEncoding = 'br' | 'gzip';

/**
 * The compressed copy to answer an Accept-Encoding header with: the highest q of br and gzip (`*`
 * names both), br on a tie; null for identity (no header, q=0, or only codings we do not keep).
 */
export function pickEncoding(header: string | undefined): ContentEncoding | null {
  if (!header) return null;
  const weights = new Map<string, number>();
  for (const part of header.toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map((piece) => piece.trim());
    if (!name) continue;
    const q = params.find((param) => param.startsWith('q='));
    const weight = q ? Number(q.slice(2)) : 1;
    weights.set(name, Number.isFinite(weight) ? weight : 0);
  }
  const weight = (name: ContentEncoding) => weights.get(name) ?? weights.get('*') ?? 0;
  const accepted = (['br', 'gzip'] as const).filter((name) => weight(name) > 0);
  return accepted.sort((a, b) => weight(b) - weight(a))[0] ?? null;
}

const MAX_BODY_BYTES = 64 * 1024;

/** Reads a JSON object body of at most 64 KiB (counted in bytes); anything else is a 400 or 413. */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  // Decode once at the end: a multi-byte character can straddle two chunks.
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks, size).toString('utf8');
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'expected a JSON object');
  return body as Record<string, unknown>;
}
