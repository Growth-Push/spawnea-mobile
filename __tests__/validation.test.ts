import {
  canonicalServerOrigin,
  validateServerUrl,
} from '../src/config/validation';

describe('validateServerUrl', () => {
  test('accepts valid HTTPS origins and strips trailing slashes', () => {
    expect(
      validateServerUrl('  https://host.tailnet.ts.net:5757/  ', false),
    ).toEqual({
      valid: true,
      normalizedUrl: 'https://host.tailnet.ts.net:5757',
    });
  });

  test('rejects HTTP in release mode even for loopback', () => {
    const res = validateServerUrl('http://127.0.0.1:5757', false);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.reason).toBe('https_required');
    }
  });

  test('allows HTTP only for 127.0.0.1 and localhost in debug mode', () => {
    expect(validateServerUrl('http://127.0.0.1:5757', true)).toEqual({
      valid: true,
      normalizedUrl: 'http://127.0.0.1:5757',
    });
    expect(validateServerUrl('http://localhost:5757/', true)).toEqual({
      valid: true,
      normalizedUrl: 'http://localhost:5757',
    });

    const remoteHttp = validateServerUrl('http://example.com:5757', true);
    expect(remoteHttp.valid).toBe(false);
    if (!remoteHttp.valid) {
      expect(remoteHttp.reason).toBe('https_required');
    }
  });

  test('rejects empty URLs, invalid ports, paths, and credentials/queries', () => {
    expect(validateServerUrl('   ', true)).toMatchObject({
      valid: false,
      reason: 'empty',
    });
    expect(validateServerUrl('https://host.ts.net:70000', true)).toMatchObject({
      valid: false,
      reason: 'invalid_port',
    });
    expect(validateServerUrl('https://host.ts.net/api', true)).toMatchObject({
      valid: false,
      reason: 'path_not_allowed',
    });
    expect(
      validateServerUrl('https://user:pass@host.ts.net', true),
    ).toMatchObject({
      valid: false,
      reason: 'invalid_format',
    });
  });

  test('normalizes canonical server origins across default ports and casing', () => {
    expect(canonicalServerOrigin('HTTPS://Host.TS.net:0443/')).toBe(
      'https://host.ts.net',
    );
    expect(canonicalServerOrigin('https://host.ts.net')).toBe(
      'https://host.ts.net',
    );
    expect(canonicalServerOrigin('http://127.0.0.1:80')).toBe(
      'http://127.0.0.1',
    );
    expect(canonicalServerOrigin('http://127.0.0.1:5757')).toBe(
      'http://127.0.0.1:5757',
    );
    expect(canonicalServerOrigin('http://127.0.0.1:8443')).toBe(
      'http://127.0.0.1:8443',
    );
  });
});
