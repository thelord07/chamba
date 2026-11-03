/**
 * Default device label sent on `vault join` when the user doesn't pass one.
 *
 * The hostname is used as-is when it fits the protocol's `deviceLabel` rules (trimmed,
 * 1–64 chars, no control characters). Long hostnames — e.g. CI runners or some corporate
 * machines — would otherwise be rejected by the server with a 400, so they are cut to 64.
 */

export const MAX_DEVICE_LABEL_LENGTH = 64;

/** Return a protocol-valid label derived from `hostname`, or `undefined` when nothing is left. */
export function defaultDeviceLabel(hostname: string): string | undefined {
  // Drop C0, DEL and C1 control characters (rejected by the protocol schema).
  let cleaned = '';
  for (const ch of hostname) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) continue;
    cleaned += ch;
  }
  // Cut by code points so a surrogate pair is never split, then trim again.
  const label = Array.from(cleaned.trim()).slice(0, MAX_DEVICE_LABEL_LENGTH).join('').trim();
  return label.length > 0 ? label : undefined;
}
