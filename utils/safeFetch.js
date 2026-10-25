import dns from 'dns/promises';
import http from 'http';
import https from 'https';
import net from 'net';

// Server-side URL fetching for user-supplied URLs (the topper-copy PDF proxy). Guards against SSRF:
//  - only http(s), no credentials in the URL
//  - the hostname is resolved once, every address must be public, and the connection is PINNED to that
//    address (so a DNS answer that changes between "check" and "connect" cannot redirect us inward)
//  - redirects are followed manually (max 3) and every hop is re-validated
//  - hard caps on time and body size

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 20000;

export const isPrivateAddress = (ip) => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) ||           // link-local incl. cloud metadata 169.254.169.254
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224                               // multicast / reserved
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('ff')) return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // not a valid IP literal - refuse
};

async function resolvePublicAddress(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('Blocked address');
    return { address: hostname, family: net.isIPv4(hostname) ? 4 : 6 };
  }
  const results = await dns.lookup(hostname, { all: true });
  if (!results.length) throw new Error('Host did not resolve');
  if (results.some((r) => isPrivateAddress(r.address))) throw new Error('Blocked address');
  return results[0];
}

function requestOnce(url, pinned) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { 'User-Agent': 'dh-pdf-proxy/1.0', Accept: 'application/pdf,*/*;q=0.5' },
        servername: url.hostname, // keep SNI/cert validation against the real hostname
        // Pin the connection to the address we already validated.
        lookup: (_host, _opts, cb) => cb(null, pinned.address, pinned.family),
        timeout: TIMEOUT_MS
      },
      resolve
    );
    req.on('timeout', () => req.destroy(new Error('Upstream timed out')));
    req.on('error', reject);
    req.end();
  });
}

// Returns the upstream IncomingMessage for a validated final response (2xx). Caller streams it.
export async function safeGet(rawUrl) {
  let current;
  try {
    current = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error('Invalid URL'), { status: 400 });
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!['http:', 'https:'].includes(current.protocol)) throw Object.assign(new Error('Unsupported protocol'), { status: 400 });
    if (current.username || current.password) throw Object.assign(new Error('Credentials in URL are not allowed'), { status: 400 });

    let pinned;
    try {
      pinned = await resolvePublicAddress(current.hostname);
    } catch (err) {
      throw Object.assign(new Error(err.message === 'Blocked address' ? 'This address is not allowed' : 'Could not resolve host'), { status: 400 });
    }

    const res = await requestOnce(current, pinned);
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, current);
      continue;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      res.resume();
      throw Object.assign(new Error('Upstream returned an error'), { status: 502 });
    }
    return res;
  }
  throw Object.assign(new Error('Too many redirects'), { status: 502 });
}
