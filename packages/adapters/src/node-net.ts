import { createServer } from 'node:net';
import type { NetPort } from '@chamba/core';

/** Node-backed `NetPort`: try to bind localhost:port; EADDRINUSE means in use. */
export class NodeNet implements NetPort {
  async isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer();
      server.once('error', (err: NodeJS.ErrnoException) => {
        resolve(err.code === 'EADDRINUSE');
      });
      server.once('listening', () => {
        server.close(() => resolve(false));
      });
      server.listen(port, '127.0.0.1');
    });
  }
}
