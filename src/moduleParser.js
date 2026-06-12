import { inflateRawSync } from 'node:zlib';
import { HttpError } from './errors.js';

const MAX_MODULE_SIZE = 12 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['txt', 'pdf', 'docx']);
const ALLOWED_MIME_TYPES = new Set([
  'text/plain',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream'
]);

function extensionFromName(fileName) {
  const match = /\.([a-z0-9]+)$/i.exec(String(fileName || ''));
  return match ? match[1].toLowerCase() : '';
}

function sanitizeFileName(fileName) {
  return String(fileName || 'module')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || 'module';
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/[ \u00a0]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function xmlDecode(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function decodePdfString(value) {
  return value
    .replace(/\\([nrtbf()\\])/g, (_, char) => {
      const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
      return map[char] || char;
    })
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function extractPdfText(buffer) {
  const source = buffer.toString('latin1');
  const pieces = [];
  const textString = /\((?:\\.|[^\\)])*\)\s*Tj/g;
  const textArray = /\[((?:.|\n)*?)\]\s*TJ/g;

  for (const match of source.matchAll(textString)) {
    pieces.push(decodePdfString(match[0].replace(/\s*Tj$/, '').slice(1, -1)));
  }

  for (const match of source.matchAll(textArray)) {
    for (const item of match[1].matchAll(/\((?:\\.|[^\\)])*\)/g)) {
      pieces.push(decodePdfString(item[0].slice(1, -1)));
    }
  }

  return normalizeText(pieces.join('\n'));
}

function findZipEntry(buffer, wantedName) {
  let offset = 0;
  while (offset + 30 < buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      offset += 1;
      continue;
    }

    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const dataEnd = dataStart + compressedSize;

    if (name === wantedName) {
      const data = buffer.subarray(dataStart, dataEnd);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { finishFlush: 2 });
      throw new HttpError(415, 'Unsupported DOCX compression method');
    }

    offset = Math.max(dataEnd, offset + 30);
    if (uncompressedSize > 50 * 1024 * 1024) throw new HttpError(413, 'DOCX entry too large');
  }

  return null;
}

function extractDocxText(buffer) {
  const documentXml = findZipEntry(buffer, 'word/document.xml');
  if (!documentXml) throw new HttpError(422, 'DOCX text could not be extracted');
  const xml = documentXml.toString('utf8');
  const withBreaks = xml
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n');
  const pieces = [];
  for (const match of withBreaks.matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/gs)) {
    pieces.push(xmlDecode(match[1]));
  }
  return normalizeText(pieces.join(' '));
}

export function validateModuleFile({ fileName, contentType, buffer }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HttpError(400, 'Module file is required');
  }
  if (buffer.length > MAX_MODULE_SIZE) {
    throw new HttpError(413, 'Module file is too large');
  }

  const extension = extensionFromName(fileName);
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new HttpError(415, 'Only TXT, PDF, and DOCX modules are supported');
  }
  if (contentType && !ALLOWED_MIME_TYPES.has(contentType)) {
    throw new HttpError(415, 'Unsupported module content type');
  }

  if (extension === 'pdf' && buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new HttpError(415, 'Invalid PDF file');
  }
  if (extension === 'docx' && buffer.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new HttpError(415, 'Invalid DOCX file');
  }

  return {
    originalName: sanitizeFileName(fileName),
    extension,
    contentType: contentType || 'application/octet-stream',
    size: buffer.length
  };
}

export function extractModuleText({ extension, buffer }) {
  if (extension === 'txt') return normalizeText(buffer.toString('utf8'));
  if (extension === 'docx') return extractDocxText(buffer);
  if (extension === 'pdf') return extractPdfText(buffer);
  throw new HttpError(415, 'Unsupported module file type');
}

export function segmentModuleText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const headingPattern = /^(#{1,6}\s+.+|第[一二三四五六七八九十百零0-9]+[章节幕场].*|场景\s*[:：].+|Scene\s+\d+.*|Chapter\s+\d+.*)$/gim;
  const headings = [...normalized.matchAll(headingPattern)];
  const sections = [];

  if (headings.length === 0) {
    sections.push({ title: '正文', content: normalized });
  } else {
    for (let index = 0; index < headings.length; index += 1) {
      const heading = headings[index];
      const next = headings[index + 1];
      const title = heading[0].replace(/^#{1,6}\s+/, '').trim();
      const contentStart = heading.index + heading[0].length;
      const contentEnd = next ? next.index : normalized.length;
      sections.push({
        title,
        content: normalizeText(normalized.slice(contentStart, contentEnd))
      });
    }
  }

  const segments = [];
  for (const section of sections) {
    const paragraphs = section.content.split(/\n{2,}/).filter(Boolean);
    let chunk = '';
    let chunkIndex = 1;
    const flush = () => {
      const content = normalizeText(chunk);
      if (content) {
        segments.push({
          title: section.title,
          scene: `${section.title} #${chunkIndex}`,
          content
        });
        chunkIndex += 1;
      }
      chunk = '';
    };

    for (const paragraph of paragraphs) {
      if ((chunk + '\n\n' + paragraph).length > 1800) flush();
      chunk = chunk ? `${chunk}\n\n${paragraph}` : paragraph;
    }
    flush();
  }

  return segments.slice(0, 400);
}

export function scoreModuleSegment(segment, query) {
  const normalizedQuery = String(query || '').toLowerCase();
  const terms = normalizedQuery
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 2)
    .slice(0, 30);
  const cjkTerms = [...normalizedQuery.matchAll(/[\p{Script=Han}]{2,}/gu)]
    .flatMap((match) => {
      const value = match[0];
      const grams = [];
      for (let index = 0; index < value.length - 1; index += 1) {
        grams.push(value.slice(index, index + 2));
      }
      return grams;
    })
    .slice(0, 40);
  const allTerms = [...new Set([...terms, ...cjkTerms])];
  if (allTerms.length === 0) return 0;

  const haystack = `${segment.title}\n${segment.scene}\n${segment.content}`.toLowerCase();
  return allTerms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

export { MAX_MODULE_SIZE };
