/**
 * Whether a URL targets this machine only. Uses the WHATWG-parsed hostname, which already
 * canonicalizes IPv4 shorthands (`127.1`, `0x7f.0.0.1` -> `127.0.0.1`) and IPv6 forms, so string
 * tricks cannot pass for loopback. Loopback: 127.0.0.0/8, ::1, the IPv4-mapped 127.0.0.0/8 range,
 * and `localhost` (with an optional trailing dot, which resolvers treat as the same name).
 * `0.0.0.0` is NOT loopback: it means "any interface" when listening.
 */
export function isLoopbackUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === 'localhost.') return true;
  if (host === '[::1]') return true;
  // IPv4-mapped IPv6 (::ffff:127.x.y.z), which the URL parser prints in hex: [::ffff:7fxx:xxxx].
  if (/^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host)) return true;
  const octets = host.split('.');
  return (
    octets.length === 4 && octets[0] === '127' && octets.every((octet) => /^\d{1,3}$/.test(octet))
  );
}

/** Plain http to anything but this machine: credentials and code would cross the network unencrypted. */
export function isInsecureRemote(url: URL): boolean {
  return url.protocol === 'http:' && !isLoopbackUrl(url);
}
