import { networkInterfaces as osNetworkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { lanUrls } from './lan.ts';

export interface NetworkRoutesDeps {
  port: number;
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
}

export function networkRoutes(api: FastifyInstance, deps: NetworkRoutesDeps): void {
  const interfaces = deps.interfaces ?? osNetworkInterfaces;
  api.get('/network', async () => ({ port: deps.port, urls: lanUrls(interfaces(), deps.port) }));
}
