export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

export function assertString(value, field, maxLength) {
  if (typeof value !== 'string') {
    throw new HttpError(400, `${field} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new HttpError(400, `${field} cannot be empty`);
  }
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${field} is too long`);
  }
  return trimmed;
}

export function optionalString(value, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Expected a string');
  }
  return value.trim().slice(0, maxLength);
}
