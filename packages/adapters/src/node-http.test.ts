/**
 * node-http.test.ts — NodeHttp integration tests.
 * Spins up real node:http servers in the test process. Never touches external hosts.
 */

import { spawn } from 'node:child_process';
import type { RequestListener, Server } from 'node:http';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import type { ClockPort } from '@chamba/core';
import { FakeHash, FakeParche, MemoryFilesystem, syncOnce } from '@chamba/core';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeHttp } from './node-http.js';
import { RetryingHttp } from './retrying-http.js';

let server: Server | undefined;
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
  return new Promise((resolve, reject) => {
    if (!s.listening) {
      resolve();
      return;
    }
    s.close((err) => (err ? reject(err) : resolve()));
  });
}

afterEach(async () => {
  if (server?.listening) {
    await closeServer(server);
  }
  server = undefined;
});

// ─── Existing tests (must remain green) ──────────────────────────────────────

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
    http.close();

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

    const http = new NodeHttp(50); // 50ms total timeout
    await expect(
      http.request({ method: 'GET', url: `http://127.0.0.1:${port}/hang` }),
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    http.close();
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
    http.close();
  });
});

// ─── New tests (B3) ──────────────────────────────────────────────────────────

describe('NodeHttp — body string', () => {
  it('sends string body with correct content-length', async () => {
    let receivedBody = '';
    let receivedContentLength = '';
    server = await makeServer((req, res) => {
      receivedContentLength = req.headers['content-length'] ?? '';
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        receivedBody = body;
        res.writeHead(200);
        res.end('ok');
      });
    });

    const http = new NodeHttp();
    await http.request({
      method: 'POST',
      url: `http://127.0.0.1:${port}/`,
      body: 'hello world',
    });
    http.close();

    expect(receivedBody).toBe('hello world');
    expect(receivedContentLength).toBe(String(new TextEncoder().encode('hello world').byteLength));
  });
});

describe('NodeHttp — connect-timeout (total)', () => {
  it('total timeout fires with code ETIMEDOUT when server never responds', async () => {
    const { createServer: createNetServer } = await import('node:net');
    const pendingConnections: Socket[] = [];

    // A TCP server that accepts the TCP connection but never sends anything back.
    // This exercises the total-timeout path (connect succeeds, response never arrives).
    const tcpServer = createNetServer((socket) => {
      pendingConnections.push(socket);
      // Accept the connection but never respond to the HTTP request.
    });

    await new Promise<void>((resolve) => tcpServer.listen(0, '127.0.0.1', () => resolve()));
    const tcpAddr = tcpServer.address() as { port: number };

    try {
      const http = new NodeHttp(100); // 100ms total timeout
      await expect(
        http.request({ method: 'GET', url: `http://127.0.0.1:${tcpAddr.port}/` }),
      ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
      http.close();
    } finally {
      for (const s of pendingConnections) s.destroy();
      await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
    }
  });
});

describe('NodeHttp — connect-timeout (new connection that never connects)', () => {
  it('fails fast with UND_ERR_CONNECT_TIMEOUT, before the total timeout', async () => {
    // A DNS lookup that never answers keeps the socket in `connecting` state: the portable
    // stand-in for a lost SYN. Total timeout is 10 s; the connect-timeout (80 ms) must win.
    const http = new NodeHttp(10_000, 80, { lookup: () => {} });
    const start = Date.now();
    try {
      await expect(
        http.request({ method: 'GET', url: 'http://parche.invalid:1/health' }),
      ).rejects.toMatchObject({ code: 'UND_ERR_CONNECT_TIMEOUT' });
      expect(Date.now() - start).toBeLessThan(2_000);
    } finally {
      http.close();
    }
  });

  it('does not arm the connect-timeout on a reused keep-alive socket', async () => {
    let connections = 0;
    server = await makeServer((_req, res) => {
      setTimeout(() => res.end('ok'), 120); // slower than the connect-timeout below
    });
    server.on('connection', () => connections++);
    const http = new NodeHttp(5_000, 60);
    try {
      // First request: the TCP connect to 127.0.0.1 completes well within 60 ms.
      expect(
        (await http.request({ method: 'GET', url: `http://127.0.0.1:${port}/a` })).status,
      ).toBe(200);
      // Second request reuses the socket; a 120 ms response must not trip the 60 ms timer.
      expect(
        (await http.request({ method: 'GET', url: `http://127.0.0.1:${port}/b` })).status,
      ).toBe(200);
      expect(connections).toBe(1);
    } finally {
      http.close();
    }
  });
});

describe('NodeHttp — abort already-aborted signal', () => {
  it('rejects immediately with AbortError if signal is already aborted', async () => {
    server = await makeServer((_req, res) => {
      res.end('ok');
    });

    const controller = new AbortController();
    controller.abort();

    const http = new NodeHttp();
    await expect(
      http.request({
        method: 'GET',
        url: `http://127.0.0.1:${port}/`,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    http.close();
  });
});

describe('NodeHttp — idle keep-alive sockets do not keep the process alive', () => {
  // The CLI (`vault sync`) never calls close(): it relies on Node unref-ing free sockets in a
  // keep-alive Agent. A child process using the built adapter must exit on its own.
  it('a child process exits by itself after keep-alive requests', async () => {
    server = await makeServer((_req, res) => res.end('ok'));
    // Keep idle sockets open on the server side, so only the client can let the process exit.
    server.keepAliveTimeout = 60_000;
    const distUrl = new URL('../dist/index.js', import.meta.url).href;
    const code = `
      const { NodeHttp } = await import(${JSON.stringify(distUrl)});
      const h = new NodeHttp();
      for (let i = 0; i < 3; i++) await h.request({ method: 'GET', url: 'http://127.0.0.1:${port}/' });
      process.stdout.write('done');
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(
            new Error('child process did not exit within 10 s (keep-alive socket kept it alive)'),
          );
        }, 10_000);
        child.on('exit', (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      expect(out).toBe('done');
      expect(exitCode).toBe(0);
    } finally {
      server.closeAllConnections();
    }
  }, 10_000);
});

// ─── Test 10 — Connection counting with real server ──────────────────────────

describe('Test 10 — keep-alive connection count', () => {
  it('100 archivos nuevos ≤ 4 conexiones; 1 archivo incremental ≤ 2', async () => {
    const clock: ClockPort = {
      now: () => new Date('2026-10-29T12:00:00Z'),
      today: () => '2026-10-29',
      sleep: () => Promise.resolve(),
    };

    const parche = new FakeParche(clock);
    const group = parche.seedGroup({ slug: 'bench', name: 'Bench' });
    parche.addInvite({ code: 'BENCH-01', groupId: group.id, role: 'editor' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'test', role: 'editor' });

    // Build a real HTTP server that routes requests to FakeParche.
    let connectionCount = 0;
    server = await makeServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      const bodyBytes = Buffer.concat(chunks);

      // Build the full URL.
      const fullUrl = `http://127.0.0.1:${port}${req.url ?? '/'}`;
      const fakeReq = {
        method: req.method ?? 'GET',
        url: fullUrl,
        headers: Object.fromEntries(
          Object.entries(req.headers)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => [k, v as string]),
        ),
        body: bodyBytes.length > 0 ? new Uint8Array(bodyBytes) : undefined,
      };

      try {
        const fakeRes = await parche.request(fakeReq);
        res.writeHead(fakeRes.status, fakeRes.headers);
        res.end(fakeRes.body);
      } catch {
        res.writeHead(500);
        res.end('error');
      }
    });

    server.on('connection', () => {
      connectionCount++;
    });

    const serverUrl = `http://127.0.0.1:${port}`;
    const fs = new MemoryFilesystem();
    const hash = new FakeHash();

    // Write 100 local files.
    for (let i = 0; i < 100; i++) {
      await fs.writeBytes(`/vault/file${i}.md`, new TextEncoder().encode(`# File ${i}`));
    }

    // Sync 1: 100 new files.
    connectionCount = 0;
    const nodeHttp1 = new NodeHttp();
    const retrying1 = new RetryingHttp(nodeHttp1, { sleep: () => Promise.resolve() });
    await syncOnce(
      { fs, http: retrying1, hash, clock },
      {
        vaultDir: '/vault',
        server: serverUrl,
        slug: 'bench',
        token,
        localAuthor: 'joys',
        device: 'test',
      },
    );
    const connections100 = connectionCount;

    console.log(`Test 10: 100 archivos nuevos → ${connections100} conexiones`);
    expect(connections100).toBeLessThanOrEqual(4);

    // Sync 2: 1 modified file (incremental), with a new NodeHttp instance.
    connectionCount = 0;
    await fs.writeBytes('/vault/file0.md', new TextEncoder().encode('# File 0 modified'));
    const nodeHttp2 = new NodeHttp();
    const retrying2 = new RetryingHttp(nodeHttp2, { sleep: () => Promise.resolve() });
    await syncOnce(
      { fs, http: retrying2, hash, clock },
      {
        vaultDir: '/vault',
        server: serverUrl,
        slug: 'bench',
        token,
        localAuthor: 'joys',
        device: 'test',
      },
    );
    const connections1 = connectionCount;

    console.log(`Test 10: 1 archivo modificado → ${connections1} conexiones`);
    expect(connections1).toBeLessThanOrEqual(2);
    // §7.3 on the real-HTTP path: no HEAD request at all
    expect(parche.requestLog.filter((r) => r.method === 'HEAD')).toHaveLength(0);

    nodeHttp1.close();
    nodeHttp2.close();
  }, 30_000); // generous timeout for file setup
});
