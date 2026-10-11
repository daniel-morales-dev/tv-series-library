import type { NetworkInterfaceInfo } from 'node:os';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { lanUrls } from '../src/modules/network/lan.ts';
import { networkRoutes } from '../src/modules/network/routes.ts';

function v4(address: string, options: { internal?: boolean } = {}): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: options.internal ?? false,
    cidr: `${address}/24`,
  };
}

function v6(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/64`,
    scopeid: 0,
  };
}

describe('lanUrls', () => {
  it('keeps private IPv4 addresses from the three RFC 1918 ranges', () => {
    const interfaces = {
      eth0: [v4('10.0.0.5')],
      wlan0: [v4('172.16.0.9')],
      enp3s0: [v4('192.168.1.20')],
    };
    expect(lanUrls(interfaces, 8080)).toEqual([
      'http://192.168.1.20:8080',
      'http://10.0.0.5:8080',
      'http://172.16.0.9:8080',
    ]);
  });

  it('discards virtual interfaces by name prefix', () => {
    const interfaces = {
      docker0: [v4('172.17.0.1')],
      'br-3f2a1b': [v4('172.18.0.1')],
      veth9c1: [v4('172.19.0.2')],
      virbr0: [v4('192.168.122.1')],
      tailscale0: [v4('100.64.0.1')],
      eth0: [v4('192.168.1.20')],
    };
    expect(lanUrls(interfaces, 8080)).toEqual(['http://192.168.1.20:8080']);
  });

  it('discards Windows virtual adapters regardless of case', () => {
    const interfaces = {
      'vEthernet (WSL (Hyper-V firewall))': [v4('172.20.0.1')],
      'vEthernet (Default Switch)': [v4('192.168.192.1')],
      'Docker Desktop': [v4('172.30.0.1')],
      Ethernet: [v4('192.168.1.20')],
    };
    expect(lanUrls(interfaces, 8080)).toEqual(['http://192.168.1.20:8080']);
  });

  it('discards IPv6 addresses and internal interfaces', () => {
    const interfaces = {
      lo: [v4('127.0.0.1', { internal: true }), v6('fe80::1')],
      eth0: [v6('fd00::5'), v4('192.168.1.20')],
      wlan0: [v4('10.0.0.8', { internal: true })],
    };
    expect(lanUrls(interfaces, 8080)).toEqual(['http://192.168.1.20:8080']);
  });

  it('only accepts private ranges: 172.15 and 172.32 are public, 172.16 and 172.31 are private', () => {
    const interfaces = {
      eth0: [v4('172.15.0.1'), v4('172.32.0.1'), v4('8.8.8.8'), v4('172.16.0.1'), v4('172.31.255.1')],
    };
    expect(lanUrls(interfaces, 8080)).toEqual(['http://172.16.0.1:8080', 'http://172.31.255.1:8080']);
  });

  it('returns no URLs without a usable network', () => {
    expect(lanUrls({}, 8080)).toEqual([]);
    expect(lanUrls({ lo: [v4('127.0.0.1', { internal: true })] }, 8080)).toEqual([]);
    expect(lanUrls({ docker0: [v4('172.17.0.1')] }, 8080)).toEqual([]);
  });

  it('orders by interface name, then numeric IP, regardless of input key order', () => {
    const forward = {
      eth1: [v4('192.168.2.5')],
      eth0: [v4('192.168.10.2'), v4('192.168.2.5')],
    };
    const reversed = {
      eth0: [v4('192.168.2.5'), v4('192.168.10.2')],
      eth1: [v4('192.168.2.5')],
    };
    const expected = ['http://192.168.2.5:8080', 'http://192.168.10.2:8080', 'http://192.168.2.5:8080'];
    expect(lanUrls(forward, 8080)).toEqual(expected);
    expect(lanUrls(reversed, 8080)).toEqual(expected);
  });
});

describe('GET /api/network', () => {
  it('answers the server port and the LAN URLs', async () => {
    const app = Fastify();
    app.register(
      async (api) => networkRoutes(api, { port: 8080, interfaces: () => ({ eth0: [v4('192.168.1.20')] }) }),
      { prefix: '/api' },
    );
    const res = await app.inject('/api/network');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ port: 8080, urls: ['http://192.168.1.20:8080'] });
    await app.close();
  });

  it('answers an empty urls list when there is no network', async () => {
    const app = Fastify();
    app.register(async (api) => networkRoutes(api, { port: 9000, interfaces: () => ({}) }), { prefix: '/api' });
    expect((await app.inject('/api/network')).json()).toEqual({ port: 9000, urls: [] });
    await app.close();
  });
});
