import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPinnedFetch } from '../aiSsrf.js';

// A real round trip: the request must reach the pinned IP no matter what the hostname resolves to.
describe('createPinnedFetch', () => {
  let server: http.Server;
  let port: number;
  const seen: Array<string | undefined> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.headers.host);
      res.setHeader('Content-Type', 'text/plain');
      res.end('pinned ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('connects to the pinned address and keeps the original Host header', async () => {
    const pinned = createPinnedFetch(['127.0.0.1']);
    const res = await pinned(`http://images.example.invalid:${port}/photo.jpg`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pinned ok');
    expect(seen.at(-1)).toBe(`images.example.invalid:${port}`);
  });

  it('passes request options through', async () => {
    const pinned = createPinnedFetch(['127.0.0.1']);
    const res = await pinned(`http://api.example.invalid:${port}/`, { method: 'POST', body: 'x', headers: { 'X-Test': '1' } });
    expect(res.ok).toBe(true);
  });
});
