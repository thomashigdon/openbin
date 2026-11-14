/**
 * Product photos for staged purchases. Store listings link images on their own CDNs, which the app's CSP
 * (img-src 'self') won't load, so the server fetches each one once, shrinks it, and serves it from storage.
 *
 * Always public-internet only (even self-hosted): https, every resolved address public, DNS pinned for the
 * request, no redirects, size-capped, and the bytes must be a real image.
 */
import dns from 'node:dns';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { createPinnedFetch, isPrivateIp } from './aiSsrf.js';
import { validateFileBuffer } from './uploadConfig.js';

const resolve4 = promisify(dns.resolve4);
const resolve6 = promisify(dns.resolve6);

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
export const PRODUCT_IMAGE_EXT = '.webp';

export interface ImageFetchDeps {
  resolve?: (host: string) => Promise<string[]>;
  fetchFor?: (ips: string[]) => typeof globalThis.fetch;
}

async function defaultResolve(host: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([resolve4(host).catch(() => []), resolve6(host).catch(() => [])]);
  return [...v4, ...v6];
}

export class ProductImageError extends Error {}

export async function fetchProductImage(url: string, deps: ImageFetchDeps = {}): Promise<Buffer> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ProductImageError('bad url');
  }
  if (u.protocol !== 'https:') throw new ProductImageError('https only');
  if (u.username || u.password) throw new ProductImageError('no credentials in url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = /^[\d.]+$|:/.test(host) ? [host] : await (deps.resolve ?? defaultResolve)(host);
  if (ips.length === 0) throw new ProductImageError('host did not resolve');
  if (ips.some(isPrivateIp)) throw new ProductImageError('private address');

  const doFetch = (deps.fetchFor ?? createPinnedFetch)(ips);
  const res = await doFetch(u.toString(), {
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: 'image/*' },
  });
  if (!res.ok) throw new ProductImageError(`status ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new ProductImageError('too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new ProductImageError('too large');
  try {
    await validateFileBuffer(buf);
  } catch {
    throw new ProductImageError('not an image');
  }
  return sharp(buf, { animated: false }).resize(400, 400, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
}
