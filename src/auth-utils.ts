import type { Request, Response, NextFunction } from 'express';

const parseCookies = (header?: string | null): Record<string, string> => {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  header.split(';').forEach((part) => {
    const [key, ...rest] = part.trim().split('=');
    if (!key) {
      return;
    }
    cookies[key] = decodeURIComponent(rest.join('='));
  });
  return cookies;
};

export const decodeJwtPayload = (token?: string): Record<string, any> | null => {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length < 2) {
      return null;
    }
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const json = Buffer.from(padded, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return null;
  }
};

const getIdTokenFromRequest = (req: Request): string | null => {
  const authHeader = req.header('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const headerToken = req.header('x-id-token');
  if (headerToken) {
    return headerToken.trim();
  }
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.idToken) {
    return cookies.idToken;
  }
  if (cookies.IdToken) {
    return cookies.IdToken;
  }
  return null;
};

export interface AuthContext {
  userId: string;
  token: string;
  payload: Record<string, any>;
}

export const authenticateRequest = (req: Request): AuthContext | null => {
  const token = getIdTokenFromRequest(req);
  if (!token) {
    return null;
  }
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return null;
  }
  const userId =
    typeof payload.sub === 'string'
      ? payload.sub
      : typeof payload.email === 'string'
        ? payload.email
        : null;
  if (!userId) {
    return null;
  }
  return {
    userId,
    token,
    payload,
  };
};

export const requireAuthenticatedUser = (req: Request, res: Response, next: NextFunction) => {
  const auth = authenticateRequest(req);
  if (!auth) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  (req as any).userId = auth.userId;
  (req as any).authPayload = auth.payload;
  (req as any).authToken = auth.token;
  next();
};
