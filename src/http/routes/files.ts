import type { IncomingMessage } from 'node:http';
import { FileError, MAX_FILE_BYTES, createEnvFromExample, listFiles, readTextFile, writeTextFile, type FileErrorCode } from '../../files/folder-files.ts';
import type { RouteModule } from '../context.ts';
import { HttpError, readJson, sendJson } from '../respond.ts';

/** A 1 MiB file as JSON: escapes can double it; anything beyond this is refused before parsing. */
const MAX_BODY_BYTES = 4 * MAX_FILE_BYTES;

const STATUS: Record<FileErrorCode, number> = {
  file_name: 400,
  file_not_found: 404,
  file_not_regular: 400,
  file_outside: 400,
  file_too_large: 413,
  file_binary: 415,
  file_permission: 403,
  file_changed: 409,
  file_exists: 409,
  file_content: 400,
  file_version: 400,
};

/** Turns a refused file operation into the `{ error, code }` answer the UI translates. */
async function answering<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof FileError) throw new HttpError(STATUS[error.code], error.message, error.code);
    throw error;
  }
}

/**
 * Reads a JSON object body of at most MAX_BODY_BYTES. readJson (respond.ts) caps
 * bodies at 64 KiB, too small for a file; this one also decodes the bytes once,
 * so a multi-byte character split across chunks survives, and refuses bad UTF-8.
 */
async function readFileBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new HttpError(413, 'body too large', 'file_too_large');
    chunks.push(chunk);
  }
  let body: unknown;
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'expected a JSON object');
  return body as Record<string, unknown>;
}

/**
 * File editor (W5). Every folder comes from ctx.resolveFolder(ws, rel); file names
 * are plain names inside it, checked in src/files/folder-files.ts.
 *
 * - GET /api/files?ws=&rel= → { files: FileEntry[], truncated }
 * - GET /api/files/content?ws=&rel=&name= → { name, content, version, size, readOnly }
 * - PUT /api/files/content { ws, rel, name, content, version } → { name, version, size };
 *   409 `file_changed` when the file changed on disk since `version` was read
 * - POST /api/files/env { ws, rel } → 201 { name: '.env', version, size }, copied from
 *   `.env.example`; 409 `file_exists` when anything named `.env` is already there
 *
 * Non-GET requests already passed the Origin and session checks in server.ts.
 * File contents are never logged.
 */
export const fileRoutes: RouteModule = (ctx) => [
  {
    method: 'GET',
    path: '/api/files',
    handler: async ({ res, url }) => {
      const { workspace, path } = await ctx.resolveFolder(url.searchParams.get('ws'), url.searchParams.get('rel'));
      sendJson(res, 200, await answering(() => listFiles(workspace.root, path)));
    },
  },
  {
    method: 'GET',
    path: '/api/files/content',
    handler: async ({ res, url }) => {
      const { workspace, path } = await ctx.resolveFolder(url.searchParams.get('ws'), url.searchParams.get('rel'));
      sendJson(res, 200, await answering(() => readTextFile(workspace.root, path, url.searchParams.get('name'))));
    },
  },
  {
    method: 'PUT',
    path: '/api/files/content',
    handler: async ({ req, res }) => {
      const body = await readFileBody(req);
      const { workspace, path } = await ctx.resolveFolder(body.ws, body.rel);
      sendJson(res, 200, await answering(() => writeTextFile(workspace.root, path, body.name, body.content, body.version)));
    },
  },
  {
    method: 'POST',
    path: '/api/files/env',
    handler: async ({ req, res }) => {
      const body = await readJson(req);
      const { workspace, path } = await ctx.resolveFolder(body.ws, body.rel);
      sendJson(res, 201, await answering(() => createEnvFromExample(workspace.root, path)));
    },
  },
];
