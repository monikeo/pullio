import dns from 'node:dns';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

/** Parse an IPv4 address into its four octets, or null. */
function ipv4Octets(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split('.').map(Number);
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||          // carrier-grade NAT
    (a === 169 && b === 254) ||                     // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments / TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||        // benchmarking
    (a === 198 && b === 51 && c === 100) ||         // TEST-NET-2
    (a === 203 && b === 0 && c === 113) ||          // TEST-NET-3
    a >= 224                                        // multicast + reserved
  );
}

/** Expand an IPv6 address into eight 16-bit groups (handles `::` and a trailing dotted quad). */
function ipv6Groups(address: string): number[] | null {
  let value = address.toLowerCase().split('%', 1)[0];
  if (isIP(value) !== 6) return null;
  const dotted = value.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const octets = ipv4Octets(dotted[1]);
    if (!octets) return null;
    value = value.slice(0, -dotted[1].length) + `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [head, tail] = value.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail !== undefined && tail ? tail.split(':') : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (value.includes('::') ? missing < 1 : missing !== 0) return null;
  const groups = [...headGroups, ...Array(value.includes('::') ? missing : 0).fill('0'), ...tailGroups].map((group) => parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

function embeddedIpv4(groups: number[], start: number): number[] {
  return [groups[start] >> 8, groups[start] & 0xff, groups[start + 1] >> 8, groups[start + 1] & 0xff];
}

/**
 * True when an IP literal points at loopback, private, link-local, multicast, or other
 * non-public space. IPv4-mapped, NAT64, and 6to4 addresses are checked by their embedded IPv4.
 */
export function isPrivateAddress(address: string): boolean {
  const cleaned = address.replace(/^\[|\]$/g, '');
  const v4 = ipv4Octets(cleaned);
  if (v4) return isPrivateIpv4(v4);
  const groups = ipv6Groups(cleaned);
  if (!groups) return false;
  if (groups.every((group) => group === 0)) return true;                                    // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;     // ::1
  if (groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    return isPrivateIpv4(embeddedIpv4(groups, 6));                                         // ::ffff:a.b.c.d / ::a.b.c.d
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b) return isPrivateIpv4(embeddedIpv4(groups, 6)); // NAT64
  if (groups[0] === 0x2002) return isPrivateIpv4(embeddedIpv4(groups, 1));                 // 6to4
  if ((groups[0] & 0xfe00) === 0xfc00) return true;                                         // fc00::/7 unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return true;                                         // fe80::/10 link-local
  if ((groups[0] & 0xff00) === 0xff00) return true;                                         // multicast
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;                            // documentation
  return false;
}

const BLOCKED_HOST_SUFFIXES = ['localhost', 'local', 'internal', 'lan', 'home.arpa', 'intranet'];

/** Validate a media URL synchronously: protocol, length, and literal/private hostnames. */
export function isValidMediaUrl(inputUrl: unknown): { valid: boolean; error?: string } {
  if (typeof inputUrl !== 'string' || !inputUrl || inputUrl.length > 8000) {
    return { valid: false, error: 'Enter a media URL of up to 8,000 characters.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(inputUrl);
  } catch {
    return { valid: false, error: 'Invalid URL format.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: 'Only HTTP and HTTPS protocols are supported.' };
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) return { valid: false, error: 'Invalid URL format.' };
  const literal = hostname.replace(/^\[|\]$/g, '');
  if (
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)) ||
    (isIP(literal) && isPrivateAddress(literal)) ||
    // Single-label hosts (e.g. http://router/) resolve through local search domains.
    (!isIP(literal) && !hostname.includes('.'))
  ) {
    return { valid: false, error: 'Access to private or local network hosts is restricted.' };
  }
  return { valid: true };
}

type LookupAddress = { address: string; family: number };
type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * Resolve the URL's hostname and reject it when any address is private. This closes the
 * gap where a public-looking name (e.g. a wildcard DNS service) points at 127.0.0.1.
 */
export async function assertPublicMediaUrl(inputUrl: string, resolver: Resolver = systemResolver): Promise<void> {
  const check = isValidMediaUrl(inputUrl);
  if (!check.valid) throw new Error(check.error);
  const hostname = new URL(inputUrl).hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return;
  let addresses: LookupAddress[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new Error(`Could not resolve ${hostname}. Check the link and your connection.`);
  }
  if (!addresses.length) throw new Error(`Could not resolve ${hostname}. Check the link and your connection.`);
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Access to private or local network hosts is restricted.');
  }
}

/** A `lookup` for http(s).request that refuses to connect to private addresses. */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
    if (error) return (callback as any)(error);
    const list = (Array.isArray(addresses) ? addresses : [{ address: addresses as unknown as string, family: 4 }]) as LookupAddress[];
    const blocked = list.find(({ address }) => isPrivateAddress(address));
    if (blocked || !list.length) {
      const refusal = Object.assign(new Error('Refusing to connect to a private network address.'), { code: 'EPRIVATEADDR' });
      return (callback as any)(refusal);
    }
    if ((options as { all?: boolean }).all) return (callback as any)(null, list);
    return (callback as any)(null, list[0].address, list[0].family);
  });
};
