/**
 * node-http.test.ts — NodeHttp integration tests.
 * Spins up a real node:http server in the test process. Never touches external hosts.
 */

import type { RequestListener, Server } from 'node:http';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeHttp } from './node-http.js';

let server: Server;
let port: number;

function makeServer(handler: RequestListener): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer(handler);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('unexpected server address'));
        return;
      }
      port = addr.port;
      resolve(s);
    });
  });
}

function closeServer(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
}

afterEach(async () => {
  if (server) await closeServer(server);
});

describe('NodeHttp — basic request', () => {
  it('sends method, headers, body and receives response', async () => {
    const received: { method?: string; body?: string } = {};
    server = await makeServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        received.method = req.method;
        received.body = body;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    const http = new NodeHttp();
    const response = await http.request({
      method: 'POST',
      url: `http://127.0.0.1:${port}/test`,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode('{"ping":1}'),
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(new TextDecoder().decode(response.body));
    expect(body.ok).toBe(true);
    expect(received.method).toBe('POST');
    expect(received.body).toBe('{"ping":1}');
  });
});

describe('NodeHttp — timeout', () => {
  it('throws on timeout (very short timeout, slow server)', async () => {
    server = await makeServer((_req, _res) => {
      // Never respond — hangs forever
    });

    const http = new NodeHttp(50); // 50ms timeout
    await expect(
      http.request({ method: 'GET', url: `http://127.0.0.1:${port}/hang` }),
    ).rejects.toThrow();
  });
});

describe('NodeHttp — caller AbortSignal', () => {
  it('throws when caller aborts before response', async () => {
    server = await makeServer((_req, _res) => {
      // Never respond
    });

    const controller = new AbortController();
    const http = new NodeHttp(30_000);
    const reqPromise = http.request({
      method: 'GET',
      url: `http://127.0.0.1:${port}/slow`,
      signal: controller.signal,
    });
    // Abort after a tick
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    controller.abort();

    await expect(reqPromise).rejects.toThrow();
  });
});
