import { HttpError } from './errors.js';

const MAX_FORM_SIZE = 14 * 1024 * 1024;

function parseContentDisposition(value) {
  const result = {};
  for (const part of String(value || '').split(';')) {
    const [rawKey, rawValue] = part.trim().split('=');
    if (!rawValue) continue;
    const key = rawKey.toLowerCase();
    result[key] = rawValue.replace(/^"|"$/g, '');
  }
  return result;
}

export async function readMultipartForm(request) {
  const contentType = request.headers['content-type'] || '';
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundaryMatch) throw new HttpError(400, 'Multipart boundary is required');

  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_FORM_SIZE) throw new HttpError(413, 'Upload is too large');
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks);
  const text = body.toString('latin1');
  const fields = {};
  const files = {};

  for (const rawPart of text.split(boundary).slice(1, -1)) {
    const part = rawPart.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;

    const headerText = part.slice(0, headerEnd);
    const bodyText = part.slice(headerEnd + 4);
    const headers = Object.fromEntries(
      headerText.split(/\r\n/).map((line) => {
        const index = line.indexOf(':');
        return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
      })
    );
    const disposition = parseContentDisposition(headers['content-disposition']);
    const name = disposition.name;
    if (!name) continue;

    const value = Buffer.from(bodyText, 'latin1');
    if (disposition.filename !== undefined) {
      files[name] = {
        fileName: disposition.filename,
        contentType: headers['content-type'] || 'application/octet-stream',
        buffer: value
      };
    } else {
      fields[name] = value.toString('utf8');
    }
  }

  return { fields, files };
}
