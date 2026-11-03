import { describe, expect, it } from 'vitest';
import { defaultDeviceLabel, MAX_DEVICE_LABEL_LENGTH } from './device-label.js';
import { joinRequestSchema } from './protocol.js';

describe('defaultDeviceLabel', () => {
  it('keeps a normal hostname unchanged', () => {
    expect(defaultDeviceLabel('joys-macbook.local')).toBe('joys-macbook.local');
  });

  it('cuts a long hostname (CI runner) to 64 chars and the result passes the protocol schema', () => {
    const host = `runner-${'a1b2c3d4'.repeat(12)}.local`;
    const label = defaultDeviceLabel(host);
    expect(label).toHaveLength(MAX_DEVICE_LABEL_LENGTH);
    expect(host.startsWith(label ?? '')).toBe(true);
    const parsed = joinRequestSchema.safeParse({
      code: 'K7QX-M2RP',
      name: 'Joys',
      email: 'j@x.dev',
      deviceLabel: label,
    });
    expect(parsed.success).toBe(true);
  });

  it('drops control characters and trims', () => {
    expect(defaultDeviceLabel('  host\u0007name\n ')).toBe('hostname');
  });

  it('never splits a surrogate pair at the cut', () => {
    const label = defaultDeviceLabel(`${'x'.repeat(63)}😀tail`);
    expect(label).toBe(`${'x'.repeat(63)}😀`);
  });

  it('returns undefined when nothing usable is left', () => {
    expect(defaultDeviceLabel('')).toBeUndefined();
    expect(defaultDeviceLabel('\u0001\u0002 ')).toBeUndefined();
  });
});
