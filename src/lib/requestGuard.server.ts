import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, Response } from 'express';

const LOOPBACK_BINDINGS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface RequestGuardOptions {
  /** Address the HTTP server listens on. */
  bindHost: string;
  /** Optional comma-separated allow-list (PULLIO_ALLOWED_HOSTS). `.example.com` also allows subdomains. */
  allowedHosts?: string;
}

function stripPort(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  return value.replace(/:\d+$/, '').replace(/\.$/, '');
}

function isLoopbackName(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/**
 * Decide whether a Host header may reach the API. Rejecting unknown Host values defeats
 * DNS-rebinding attacks, where a malicious page re-points its own domain at 127.0.0.1.
 */
export function isAllowedHostHeader(hostHeader: string | undefined, options: RequestGuardOptions): boolean {
  if (!hostHeader) return false;
  const hostname = stripPort(hostHeader);
  const configured = (options.allowedHosts || '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (configured.length) {
    return isLoopbackName(hostname) || configured.some((entry) => entry === '*' || (entry.startsWith('.') ? hostname === entry.slice(1) || hostname.endsWith(entry) : hostname === entry));
  }
  if (LOOPBACK_BINDINGS.has(options.bindHost.toLowerCase())) return isLoopbackName(hostname);
  // Bound to a public interface without an allow-list: the public name is unknown, so accept it.
  return true;
}

/** True when the Origin header (if any) names the same host the request was sent to. */
export function isSameOriginRequest(originHeader: string | undefined, hostHeader: string | undefined): boolean {
  if (!originHeader) return true;
  if (originHeader === 'null' || !hostHeader) return false;
  try {
    return new URL(originHeader).host.toLowerCase() === hostHeader.trim().toLowerCase();
  } catch {
    return false;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Express middleware for /api: blocks DNS-rebinding hosts and cross-site requests so another
 * website open in the same browser cannot drive the local server (queue downloads, upload files,
 * replace cookies, or use the server as a proxy).
 */
export function createApiRequestGuard(options: RequestGuardOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isAllowedHostHeader(req.headers.host, options)) {
      return res.status(421).json({ error: 'This host name is not allowed. Add it to PULLIO_ALLOWED_HOSTS to use it.' });
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
    }
    if (!SAFE_METHODS.has(req.method) && !isSameOriginRequest(req.headers.origin, req.headers.host)) {
      return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
    }
    next();
  };
}

/** Validate a WebSocket upgrade request with the same host and origin rules. */
export function isAllowedUpgrade(request: IncomingMessage, options: RequestGuardOptions): boolean {
  return isAllowedHostHeader(request.headers.host, options) && isSameOriginRequest(request.headers.origin, request.headers.host);
}
