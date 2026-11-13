export type UrlValidationReason =
  | 'empty'
  | 'invalid_format'
  | 'https_required'
  | 'invalid_port'
  | 'path_not_allowed';

export type UrlValidationResult =
  | { valid: true; normalizedUrl: string }
  | { valid: false; reason: UrlValidationReason; message: string };

const URL_PATTERN =
  /^(https?):\/\/([a-zA-Z0-9.-]+)(?::(\d{1,5}))?(\/.*)?$/i;

/**
 * Validates and normalizes the Spawnea Mobile API base URL.
 *
 * HTTPS is required in all builds, except explicit loopback HTTP
 * (`http://127.0.0.1` or `http://localhost`) when `allowDebugLoopback` is true.
 */
export function validateServerUrl(
  rawUrl: string,
  allowDebugLoopback: boolean,
): UrlValidationResult {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return {
      valid: false,
      reason: 'empty',
      message: 'Server URL is required.',
    };
  }

  if (/\s|[@?#]/.test(trimmed)) {
    return {
      valid: false,
      reason: 'invalid_format',
      message: 'Enter a valid base URL without credentials, query, or fragment.',
    };
  }

  const match = URL_PATTERN.exec(trimmed);
  if (!match) {
    return {
      valid: false,
      reason: 'invalid_format',
      message: 'Enter a valid URL starting with https://.',
    };
  }

  const scheme = match[1].toLowerCase();
  const host = match[2].toLowerCase();
  const portText = match[3];
  const rawPath = match[4] ?? '';

  if (
    !host ||
    host.startsWith('.') ||
    host.endsWith('.') ||
    host.includes('..')
  ) {
    return {
      valid: false,
      reason: 'invalid_format',
      message: 'Enter a valid server hostname or IP address.',
    };
  }

  if (portText !== undefined) {
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return {
        valid: false,
        reason: 'invalid_port',
        message: 'Port must be between 1 and 65535.',
      };
    }
  }

  const normalizedPath = rawPath.replace(/\/+$/, '');
  if (normalizedPath.length > 0) {
    return {
      valid: false,
      reason: 'path_not_allowed',
      message: 'Server URL must be a base origin without a path.',
    };
  }

  const isLoopbackHost = host === '127.0.0.1' || host === 'localhost';
  if (scheme === 'http' && !(allowDebugLoopback && isLoopbackHost)) {
    return {
      valid: false,
      reason: 'https_required',
      message: allowDebugLoopback
        ? 'HTTPS is required (HTTP is only allowed for 127.0.0.1 or localhost in debug builds).'
        : 'HTTPS is required for server connections.',
    };
  }

  const portSuffix = portText !== undefined ? `:${portText}` : '';
  return {
    valid: true,
    normalizedUrl: `${scheme}://${host}${portSuffix}`,
  };
}
