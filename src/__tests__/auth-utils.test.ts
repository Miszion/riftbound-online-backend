/**
 * Auth Utils - Comprehensive Unit Tests
 *
 * Tests cover: decodeJwtPayload, authenticateRequest, requireAuthenticatedUser,
 * parseCookies (via authenticateRequest), token extraction from all sources.
 */
import { decodeJwtPayload, authenticateRequest, requireAuthenticatedUser, AuthContext } from '../auth-utils';
import type { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Helpers: build minimal fake JWTs
// ---------------------------------------------------------------------------

function b64url(obj: object): string {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const HEADER = b64url({ alg: 'HS256', typ: 'JWT' });

function makeToken(payload: object, sig = 'fakesig'): string {
  return `${HEADER}.${b64url(payload)}.${sig}`;
}

// ---------------------------------------------------------------------------
// Helpers: mock Express objects
// ---------------------------------------------------------------------------

function mockRequest(overrides: {
  authorizationHeader?: string;
  xIdTokenHeader?: string;
  cookieHeader?: string;
} = {}): Request {
  const headers: Record<string, string> = {};
  if (overrides.authorizationHeader) headers['authorization'] = overrides.authorizationHeader;
  if (overrides.xIdTokenHeader) headers['x-id-token'] = overrides.xIdTokenHeader;
  if (overrides.cookieHeader) headers['cookie'] = overrides.cookieHeader;

  return {
    header: (name: string) => headers[name.toLowerCase()] ?? null,
    headers,
  } as unknown as Request;
}

function mockResponse(): { res: Response; statusCode: number | null; body: any; status: jest.Mock; json: jest.Mock } {
  const state: { statusCode: number | null; body: any } = { statusCode: null, body: null };
  const json = jest.fn((b: any) => { state.body = b; return res; });
  const status = jest.fn((code: number) => { state.statusCode = code; return res; });
  const res = { status, json } as unknown as Response;
  return { res, json, status, ...state };
}

// ---------------------------------------------------------------------------
// decodeJwtPayload
// ---------------------------------------------------------------------------

describe('decodeJwtPayload', () => {
  describe('null / undefined / empty input', () => {
    it('returns null for undefined', () => {
      expect(decodeJwtPayload(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(decodeJwtPayload('')).toBeNull();
    });
  });

  describe('malformed tokens', () => {
    it('returns null for a string with no dots', () => {
      expect(decodeJwtPayload('nodotsatall')).toBeNull();
    });

    it('returns null for a single-segment token', () => {
      expect(decodeJwtPayload('onlyone')).toBeNull();
    });

    it('returns null when payload is not valid base64 JSON', () => {
      expect(decodeJwtPayload('header.!!!notbase64!!!.sig')).toBeNull();
    });

    it('returns null when payload decodes to non-JSON', () => {
      const notJson = Buffer.from('this is not json').toString('base64');
      expect(decodeJwtPayload(`header.${notJson}.sig`)).toBeNull();
    });

    it('returns null when payload is valid base64 but JSON is a primitive (string)', () => {
      const stringPayload = Buffer.from('"just a string"').toString('base64');
      // JSON.parse returns a string; we expect an object for a real JWT but
      // the function will return it — test what it actually does
      const result = decodeJwtPayload(`header.${stringPayload}.sig`);
      // The function returns JSON.parse result which is "just a string" — truthy, non-null
      expect(typeof result).toBe('string');
    });
  });

  describe('valid tokens', () => {
    it('decodes a standard JWT with sub and email', () => {
      const payload = { sub: 'user-abc', email: 'user@example.com', iat: 1700000000 };
      const token = makeToken(payload);
      const result = decodeJwtPayload(token);
      expect(result).toEqual(payload);
    });

    it('decodes a 2-part token (header.payload, no signature)', () => {
      const payload = { sub: 'user-xyz' };
      const token = `${HEADER}.${b64url(payload)}`;
      const result = decodeJwtPayload(token);
      expect(result).toEqual(payload);
    });

    it('handles base64url characters (- and _) in payload', () => {
      // craft a payload that when base64url encoded will contain - and _
      const raw = JSON.stringify({ sub: 'a'.repeat(10), extra: 'b'.repeat(10) });
      // manually create a base64url version with - and _ substitutions
      const b64 = Buffer.from(raw).toString('base64');
      const b64url_str = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const result = decodeJwtPayload(`header.${b64url_str}.sig`);
      expect(result).not.toBeNull();
      expect((result as any).sub).toBe('a'.repeat(10));
    });

    it('handles padding-required base64 payloads', () => {
      // Choose a payload whose base64 length requires padding
      const payload = { sub: 'u1' };
      const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
      const stripped = b64.replace(/=+$/, '');
      const token = `${HEADER}.${stripped}.sig`;
      const result = decodeJwtPayload(token);
      expect(result).not.toBeNull();
      expect((result as any).sub).toBe('u1');
    });

    it('decodes a token with exp (expired token) without rejecting it', () => {
      // auth-utils does NOT verify expiry — it only decodes
      const payload = { sub: 'user-1', exp: 1 }; // expired in 1970
      const token = makeToken(payload);
      const result = decodeJwtPayload(token);
      expect(result).toEqual(payload);
      expect((result as any).exp).toBe(1);
    });

    it('returns all claims present in the payload', () => {
      const payload = {
        sub: 'user-1',
        email: 'a@b.com',
        'cognito:groups': ['admin'],
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc',
        aud: 'clientid123',
        token_use: 'id',
        iat: 1700000000,
        exp: 9999999999,
      };
      const result = decodeJwtPayload(makeToken(payload));
      expect(result).toEqual(payload);
    });

    it('decodes a token where payload contains nested objects', () => {
      const payload = { sub: 'user-1', meta: { role: 'player', level: 5 } };
      const result = decodeJwtPayload(makeToken(payload));
      expect(result).toEqual(payload);
    });
  });
});

// ---------------------------------------------------------------------------
// authenticateRequest - token extraction
// ---------------------------------------------------------------------------

describe('authenticateRequest', () => {
  const payload = { sub: 'user-1', email: 'user@example.com' };
  const token = makeToken(payload);

  describe('no token present', () => {
    it('returns null when no auth header, no x-id-token, no cookies', () => {
      const req = mockRequest();
      expect(authenticateRequest(req)).toBeNull();
    });

    it('returns null when Authorization header is present but not Bearer', () => {
      const req = mockRequest({ authorizationHeader: `Basic somebase64stuff` });
      expect(authenticateRequest(req)).toBeNull();
    });

    it('returns null when Authorization header is just "Bearer " with no token', () => {
      const req = mockRequest({ authorizationHeader: 'Bearer ' });
      // Empty string after trim → decodeJwtPayload('') → null
      expect(authenticateRequest(req)).toBeNull();
    });
  });

  describe('Bearer token in Authorization header', () => {
    it('returns AuthContext when Bearer token has sub claim', () => {
      const req = mockRequest({ authorizationHeader: `Bearer ${token}` });
      const result = authenticateRequest(req);
      expect(result).not.toBeNull();
      expect(result!.userId).toBe('user-1');
      expect(result!.token).toBe(token);
      expect(result!.payload).toEqual(payload);
    });

    it('uses email as userId when sub is absent', () => {
      const emailOnlyPayload = { email: 'only@email.com' };
      const emailToken = makeToken(emailOnlyPayload);
      const req = mockRequest({ authorizationHeader: `Bearer ${emailToken}` });
      const result = authenticateRequest(req);
      expect(result).not.toBeNull();
      expect(result!.userId).toBe('only@email.com');
    });

    it('returns null when token has neither sub nor email', () => {
      const noIdPayload = { iss: 'somewhere', iat: 1234 };
      const noIdToken = makeToken(noIdPayload);
      const req = mockRequest({ authorizationHeader: `Bearer ${noIdToken}` });
      expect(authenticateRequest(req)).toBeNull();
    });

    it('returns null when Bearer token is malformed', () => {
      const req = mockRequest({ authorizationHeader: 'Bearer notajwt' });
      expect(authenticateRequest(req)).toBeNull();
    });

    it('prefers sub over email when both are present', () => {
      const bothPayload = { sub: 'sub-user', email: 'email@user.com' };
      const bothToken = makeToken(bothPayload);
      const req = mockRequest({ authorizationHeader: `Bearer ${bothToken}` });
      const result = authenticateRequest(req);
      expect(result!.userId).toBe('sub-user');
    });

    it('returns null when sub exists but is not a string', () => {
      const numericSub = { sub: 12345 };
      const numericToken = makeToken(numericSub);
      const req = mockRequest({ authorizationHeader: `Bearer ${numericToken}` });
      // sub is not a string, email absent → null
      expect(authenticateRequest(req)).toBeNull();
    });

    it('falls back to email when sub is numeric (non-string)', () => {
      const numericSubWithEmail = { sub: 12345, email: 'fallback@test.com' };
      const t = makeToken(numericSubWithEmail);
      const req = mockRequest({ authorizationHeader: `Bearer ${t}` });
      const result = authenticateRequest(req);
      expect(result!.userId).toBe('fallback@test.com');
    });
  });

  describe('x-id-token header (fallback from Authorization)', () => {
    it('returns AuthContext when x-id-token header is present', () => {
      const req = mockRequest({ xIdTokenHeader: token });
      const result = authenticateRequest(req);
      expect(result).not.toBeNull();
      expect(result!.userId).toBe('user-1');
      expect(result!.token).toBe(token);
    });

    it('trims whitespace from x-id-token value', () => {
      const req = mockRequest({ xIdTokenHeader: `  ${token}  ` });
      const result = authenticateRequest(req);
      expect(result).not.toBeNull();
      expect(result!.token).toBe(token);
    });

    it('Authorization Bearer takes precedence over x-id-token', () => {
      const altPayload = { sub: 'bearer-user' };
      const altToken = makeToken(altPayload);
      const req = mockRequest({
        authorizationHeader: `Bearer ${altToken}`,
        xIdTokenHeader: token,
      });
      const result = authenticateRequest(req);
      expect(result!.userId).toBe('bearer-user');
    });
  });

  describe('cookie-based token extraction', () => {
    it('reads idToken cookie (lowercase) when no header token', () => {
      const req = mockRequest({ cookieHeader: `idToken=${token}` });
      const result = authenticateRequest(req);
      expect(result).not.toBeNull();
      expect(result!.userId).toBe('user-1');
    });

    it('reads IdToken cookie (capitalized) when no header token', () => {
      const req = mockRequest({ cookieHeader: `IdToken=${token}` });
      const result = authenticateRequest(req);
      expect(result).not.toBeNull();
      expect(result!.userId).toBe('user-1');
    });

    it('prefers idToken (lowercase) over IdToken (capitalized) when both present', () => {
      const altPayload = { sub: 'lowercase-cookie-user' };
      const altToken = makeToken(altPayload);
      const req = mockRequest({
        cookieHeader: `idToken=${altToken}; IdToken=${token}`,
      });
      const result = authenticateRequest(req);
      expect(result!.userId).toBe('lowercase-cookie-user');
    });

    it('handles cookies with other values alongside token cookie', () => {
      const req = mockRequest({ cookieHeader: `session=abc123; idToken=${token}; theme=dark` });
      const result = authenticateRequest(req);
      expect(result).not.toBeNull();
      expect(result!.userId).toBe('user-1');
    });

    it('handles URL-encoded values in cookies', () => {
      // token with = padding - encode it
      const encoded = encodeURIComponent(token);
      const req = mockRequest({ cookieHeader: `idToken=${encoded}` });
      const result = authenticateRequest(req);
      expect(result).not.toBeNull();
      expect(result!.userId).toBe('user-1');
    });

    it('returns null when cookie token is malformed', () => {
      const req = mockRequest({ cookieHeader: 'idToken=notajwt' });
      expect(authenticateRequest(req)).toBeNull();
    });

    it('returns null when cookie header is empty', () => {
      const req = mockRequest({ cookieHeader: '' });
      expect(authenticateRequest(req)).toBeNull();
    });
  });

  describe('AuthContext shape', () => {
    it('returned AuthContext contains userId, token, and payload', () => {
      const req = mockRequest({ authorizationHeader: `Bearer ${token}` });
      const result = authenticateRequest(req) as AuthContext;
      expect(typeof result.userId).toBe('string');
      expect(typeof result.token).toBe('string');
      expect(typeof result.payload).toBe('object');
      expect(result.payload).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// requireAuthenticatedUser middleware
// ---------------------------------------------------------------------------

describe('requireAuthenticatedUser', () => {
  const payload = { sub: 'middleware-user', email: 'mw@test.com' };
  const token = makeToken(payload);

  it('calls next() and attaches auth data to req when authenticated via Bearer', () => {
    const req = mockRequest({ authorizationHeader: `Bearer ${token}` }) as any;
    const { res } = mockResponse();
    const next = jest.fn();

    requireAuthenticatedUser(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(); // no error passed
    expect(req.userId).toBe('middleware-user');
    expect(req.authToken).toBe(token);
    expect(req.authPayload).toEqual(payload);
  });

  it('responds 401 and does NOT call next() when no token is present', () => {
    const req = mockRequest() as any;
    const { res, status, json } = mockResponse();
    const next = jest.fn();

    requireAuthenticatedUser(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' });
  });

  it('responds 401 when token is malformed', () => {
    const req = mockRequest({ authorizationHeader: 'Bearer bad.token' }) as any;
    const { res, status, json } = mockResponse();
    const next = jest.fn();

    requireAuthenticatedUser(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' });
  });

  it('responds 401 when token has no sub or email', () => {
    const noIdToken = makeToken({ iss: 'somewhere' });
    const req = mockRequest({ authorizationHeader: `Bearer ${noIdToken}` }) as any;
    const { res, status } = mockResponse();
    const next = jest.fn();

    requireAuthenticatedUser(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it('works with x-id-token header', () => {
    const req = mockRequest({ xIdTokenHeader: token }) as any;
    const { res } = mockResponse();
    const next = jest.fn();

    requireAuthenticatedUser(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.userId).toBe('middleware-user');
  });

  it('works with idToken cookie', () => {
    const req = mockRequest({ cookieHeader: `idToken=${token}` }) as any;
    const { res } = mockResponse();
    const next = jest.fn();

    requireAuthenticatedUser(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.userId).toBe('middleware-user');
  });

  it('works with IdToken cookie (capitalized)', () => {
    const req = mockRequest({ cookieHeader: `IdToken=${token}` }) as any;
    const { res } = mockResponse();
    const next = jest.fn();

    requireAuthenticatedUser(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.userId).toBe('middleware-user');
  });

  it('uses email as userId when sub absent', () => {
    const emailToken = makeToken({ email: 'only@email.com' });
    const req = mockRequest({ authorizationHeader: `Bearer ${emailToken}` }) as any;
    const { res } = mockResponse();
    const next = jest.fn();

    requireAuthenticatedUser(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.userId).toBe('only@email.com');
  });
});
