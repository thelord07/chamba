import type { NetPort } from '../ports/net.js';

/** In-memory `NetPort` for tests. Ports in `inUse` report as occupied. */
export class FakeNet implements NetPort {
  constructor(private readonly inUse: Set<number> = new Set()) {}

  async isPortInUse(port: number): Promise<boolean> {
    return this.inUse.has(port);
  }

  occupy(port: number): void {
    this.inUse.add(port);
  }
}
