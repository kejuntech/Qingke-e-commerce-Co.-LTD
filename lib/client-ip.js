'use strict';
const net = require('node:net');

function remoteAddress(req) {
  const candidate = String(req?.socket?.remoteAddress || '').trim();
  return net.isIP(candidate) ? candidate : 'unknown';
}

// Forwarded headers are untrusted by default. Only enable TRUST_PROXY when the
// hosting proxy is known to append the actual client address to X-Forwarded-For.
// In that configuration, use the right-most valid address so a client cannot
// spoof a left-most prefix to evade per-client rate limits.
function clientIp(req, env = process.env) {
  const fallback = remoteAddress(req);
  if (String(env.TRUST_PROXY || '').trim().toLowerCase() !== 'true') return fallback;
  const raw = req?.headers?.['x-forwarded-for'];
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (net.isIP(parts[i])) return parts[i];
  }
  return fallback;
}

module.exports = { clientIp };
