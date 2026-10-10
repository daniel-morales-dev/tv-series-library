import type { NetworkInterfaceInfo } from 'node:os';

const VIRTUAL_PREFIXES = ['docker', 'br-', 'veth', 'virbr', 'tailscale'];

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Zero-padded octets make lexicographic order match numeric order.
const sortKey = (ip: string): string => ip.split('.').map((octet) => octet.padStart(3, '0')).join('.');

export function lanUrls(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, port: number): string[] {
  return Object.keys(interfaces)
    .sort()
    .filter((name) => !VIRTUAL_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .flatMap((name) =>
      (interfaces[name] ?? [])
        .filter((info) => info.family === 'IPv4' && !info.internal && isPrivateIPv4(info.address))
        .map((info) => info.address)
        .sort((x, y) => sortKey(x).localeCompare(sortKey(y)))
        .map((ip) => `http://${ip}:${port}`),
    );
}
