import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { HttpError } from './errors.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

export function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

export function sendError(response, error) {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  const message = statusCode === 500 ? 'Internal server error' : error.message;
  if (statusCode === 500) console.error(error);
  sendJson(response, statusCode, { error: message });
}

export async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1024 * 1024) {
      throw new HttpError(413, 'Payload too large');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

export function serveStatic(request, response, publicDir) {
  const url = new URL(request.url, 'http://localhost');
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const normalized = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const filePath = resolve(join(publicDir, normalized));
  const publicRoot = resolve(publicDir);

  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${sep}`)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  const target = existsSync(filePath) && statSync(filePath).isFile()
    ? filePath
    : join(publicDir, 'index.html');

  response.writeHead(200, {
    'Content-Type': MIME_TYPES[extname(target)] || 'application/octet-stream',
    'Cache-Control': target.endsWith('index.html') ? 'no-store' : 'public, max-age=3600'
  });
  createReadStream(target).pipe(response);
}
