import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKTREE_PORTS } from '../config/worktrees.js';
import { FakeNet } from '../testing/fake-net.js';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { allocatePort, assignWorktreePorts } from './port-assign.js';

describe('allocatePort', () => {
  it('returns the start port when free', async () => {
    expect(await allocatePort(new FakeNet(), 3000, 10)).toBe(3000);
  });

  it('skips occupied ports without killing anything', async () => {
    const net = new FakeNet(new Set([3000, 3010]));
    expect(await allocatePort(net, 3000, 10)).toBe(3020);
  });
});

describe('assignWorktreePorts', () => {
  it('writes .env.local with a unique PORT per worktree', async () => {
    const fs = new MemoryFilesystem({});
    const assigned = await assignWorktreePorts({
      net: new FakeNet(),
      fs,
      worktreePaths: ['/wt/a', '/wt/b'],
      ports: { ...DEFAULT_WORKTREE_PORTS, enabled: true },
    });
    expect(assigned.map((a) => a.port)).toEqual([3000, 3010]);
    expect(await fs.readFile('/wt/a/.env.local')).toContain('PORT=3000');
    expect(await fs.readFile('/wt/b/.env.local')).toContain('PORT=3010');
  });

  it('reuses a free PORT already in .env.local', async () => {
    const fs = new MemoryFilesystem({ '/wt/a/.env.local': 'PORT=4000\n' });
    const assigned = await assignWorktreePorts({
      net: new FakeNet(),
      fs,
      worktreePaths: ['/wt/a'],
      ports: { ...DEFAULT_WORKTREE_PORTS, enabled: true },
    });
    expect(assigned[0]?.port).toBe(4000);
    expect(assigned[0]?.reused).toBe(true);
  });
});
