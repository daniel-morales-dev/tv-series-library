import { describe, expect, it } from 'vitest';
import { networkView, pickUrl, qrSvg } from './network.ts';

describe('pickUrl', () => {
  const urls = ['http://192.168.1.20:8080', 'http://10.0.0.5:8080'];
  it('defaults to the first url', () => expect(pickUrl(urls)).toBe(urls[0]));
  it('honours a valid selection', () => expect(pickUrl(urls, urls[1])).toBe(urls[1]));
  it('ignores a stale selection', () => expect(pickUrl(urls, 'http://gone:1')).toBe(urls[0]));
  it('is null without urls', () => expect(pickUrl([])).toBeNull());
});

describe('networkView', () => {
  it('empty urls give the "no local network" state', () => {
    expect(networkView({ port: 8080, urls: [] })).toEqual({ kind: 'empty', message: 'No se detectó una red local.' });
  });
  it('with urls it exposes the main url and whether to show a selector', () => {
    expect(networkView({ port: 8080, urls: ['http://192.168.1.20:8080'] })).toEqual({ kind: 'ready', urls: ['http://192.168.1.20:8080'], multiple: false });
    expect(networkView({ port: 8080, urls: ['http://a:1', 'http://b:1'] })).toMatchObject({ kind: 'ready', multiple: true });
  });
});

describe('qrSvg', () => {
  it('renders an inline svg', () => {
    const svg = qrSvg('http://192.168.1.20:8080');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
  });
  it('makes no external requests (only the svg xmlns namespace is a URL)', () => {
    const svg = qrSvg('http://192.168.1.20:8080').replace('xmlns="http://www.w3.org/2000/svg"', '');
    expect(svg).not.toMatch(/https?:\/\//);
    expect(svg).not.toMatch(/<(image|script|use)\b|href=|src=/);
  });
  it('differs per url', () => expect(qrSvg('http://a:1')).not.toBe(qrSvg('http://b:2')));
});
