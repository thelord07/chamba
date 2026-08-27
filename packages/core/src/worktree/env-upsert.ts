/**
 * Set or replace `KEY=value` in a dotenv-style file without touching other
 * lines. Idempotent when the value is already set. Pure.
 */
export function upsertEnvVar(content: string, key: string, value: string): string {
  const assignment = `${key}=${value}`;
  const re = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm');
  if (re.test(content)) {
    return content.replace(re, assignment);
  }
  const body = content.endsWith('\n') || content.length === 0 ? content : `${content}\n`;
  return `${body}${assignment}\n`;
}

/** Read `KEY` from dotenv content; `undefined` if missing. */
export function readEnvVar(content: string, key: string): string | undefined {
  const re = new RegExp(`^${escapeRegExp(key)}=(.*)$`, 'm');
  const m = re.exec(content);
  return m?.[1];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
