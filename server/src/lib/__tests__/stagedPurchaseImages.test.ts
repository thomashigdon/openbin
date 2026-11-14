import { describe, expect, it } from 'vitest';
import { TEST_PNG } from '../../__tests__/helpers.js';
import { fetchProductImage, ProductImageError } from '../stagedPurchaseImages.js';

const okFetch = (body: Buffer, headers: Record<string, string> = {}) => () =>
  (async () => new Response(new Uint8Array(body), { status: 200, headers })) as unknown as typeof fetch;

describe('fetchProductImage', () => {
  it('fetches, checks and shrinks a public https image', async () => {
    const out = await fetchProductImage('https://m.media-amazon.com/images/I/x.jpg', {
      resolve: async () => ['93.184.216.34'],
      fetchFor: okFetch(TEST_PNG),
    });
    expect(out.subarray(8, 12).toString()).toBe('WEBP');
  });

  it.each([
    ['http://m.media-amazon.com/x.jpg', 'https only'],
    ['https://127.0.0.1/x.jpg', 'private address'],
    ['https://[::1]/x.jpg', 'private address'],
    ['https://169.254.169.254/latest/meta-data', 'private address'],
    ['https://user:pw@example.com/x.jpg', 'no credentials in url'],
  ])('refuses %s', async (url, why) => {
    await expect(fetchProductImage(url, { resolve: async () => ['93.184.216.34'], fetchFor: okFetch(TEST_PNG) }))
      .rejects.toThrow(why);
  });

  it('refuses hostnames that resolve to private addresses', async () => {
    await expect(fetchProductImage('https://images.internal.example/x.jpg', {
      resolve: async () => ['93.184.216.34', '10.0.0.5'],
      fetchFor: okFetch(TEST_PNG),
    })).rejects.toBeInstanceOf(ProductImageError);
  });

  it('refuses things that are not images, and oversized responses', async () => {
    const pub = { resolve: async () => ['93.184.216.34'] };
    await expect(fetchProductImage('https://example.com/x.jpg', { ...pub, fetchFor: okFetch(Buffer.from('<html>nope</html>')) }))
      .rejects.toThrow('not an image');
    await expect(fetchProductImage('https://example.com/x.jpg', { ...pub, fetchFor: okFetch(TEST_PNG, { 'content-length': String(50 * 1024 * 1024) }) }))
      .rejects.toThrow('too large');
  });
});
