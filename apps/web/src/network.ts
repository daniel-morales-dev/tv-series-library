import qrcode from 'qrcode-generator';

export interface NetworkInfo {
  port: number;
  urls: string[];
}

export type NetworkView = { kind: 'empty'; message: string } | { kind: 'ready'; urls: string[]; multiple: boolean };

export function networkView(info: NetworkInfo): NetworkView {
  if (info.urls.length === 0) return { kind: 'empty', message: 'No se detectó una red local.' };
  return { kind: 'ready', urls: info.urls, multiple: info.urls.length > 1 };
}

/** The selected url if it is still offered, else the first (the suggested one). */
export function pickUrl(urls: string[], selected?: string): string | null {
  if (selected && urls.includes(selected)) return selected;
  return urls[0] ?? null;
}

/** Inline SVG QR: pure JS, no network requests. */
export function qrSvg(url: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}
