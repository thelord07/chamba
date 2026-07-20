import { describe, expect, it } from 'vitest';
import { FakeProcess } from '../testing/fake-process.js';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { detectQaCapabilities } from './capabilities.js';

const SIMCTL_OUTPUT = `== Devices ==
-- iOS 17.5 --
    iPhone 15 (0E7A2E5F-1111-2222-3333-444455556666) (Shutdown)
    iPhone 15 Pro (1A2B3C4D-5555-6666-7777-888899990000) (Booted)
`;

const EXPO_FILES = {
  '/app/package.json': JSON.stringify({
    name: 'mobileapp',
    dependencies: { expo: '^51', react: '18', 'react-native': '0.74' },
    devDependencies: { detox: '^20' },
  }),
  '/app/app.json': '{"expo":{"name":"mobileapp"}}',
  '/app/App.tsx': 'export default function App(){return null}\n',
};

describe('detectQaCapabilities', () => {
  it('reports mobile capabilities and enumerates simulators/emulators', async () => {
    const process = new FakeProcess((cmd) => {
      if (cmd === 'xcrun') return { stdout: SIMCTL_OUTPUT };
      if (cmd === 'emulator') return { stdout: 'Pixel_7_API_34\n' };
      if (cmd === 'adb') return { stdout: 'List of devices attached\nemulator-5554\tdevice\n' };
      return {};
    });
    const caps = await detectQaCapabilities({
      fs: new MemoryFilesystem(EXPO_FILES),
      process,
      cwd: '/app',
    });

    expect(caps.projectKind).toBe('mobile');
    expect(caps.expo.present).toBe(true);
    expect(caps.mobileE2e).toContain('Detox');
    expect(caps.devices.ios.available).toBe(true);
    expect(caps.devices.ios.simulators).toBe(2);
    expect(caps.devices.ios.booted).toEqual(['iPhone 15 Pro']);
    expect(caps.devices.android.avds).toEqual(['Pixel_7_API_34']);
    expect(caps.devices.android.running).toEqual(['emulator-5554']);
    expect(caps.summary).toContain('Mobile project');
  });

  it('degrades cleanly when no device tooling is on the machine', async () => {
    const process = new FakeProcess(() => ({ exitCode: 1, stderr: 'command not found' }));
    const caps = await detectQaCapabilities({
      fs: new MemoryFilesystem(EXPO_FILES),
      process,
      cwd: '/app',
    });

    expect(caps.projectKind).toBe('mobile');
    expect(caps.devices.ios.available).toBe(false);
    expect(caps.devices.ios.note).toMatch(/Xcode/);
    expect(caps.devices.android.available).toBe(false);
    expect(caps.devices.android.note).toMatch(/Android SDK/);
  });

  it('classifies a web project and detects its E2E tooling without probing devices', async () => {
    const process = new FakeProcess(() => {
      throw new Error('devices must not be probed for a web-only project');
    });
    const caps = await detectQaCapabilities({
      fs: new MemoryFilesystem({
        '/web/package.json': JSON.stringify({
          name: 'web',
          dependencies: { next: '^15', react: '^18' },
          devDependencies: { '@playwright/test': '^1' },
        }),
        '/web/src/app.tsx': 'export {};\n',
      }),
      process,
      cwd: '/web',
    });

    expect(caps.projectKind).toBe('web');
    expect(caps.webE2e).toEqual(['Playwright']);
    expect(caps.mobileApps).toEqual([]);
    expect(caps.devices.ios.available).toBe(false);
    expect(process.calls).toEqual([]);
  });
});
