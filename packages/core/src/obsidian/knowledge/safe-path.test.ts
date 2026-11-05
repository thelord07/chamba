/**
 * Test 2 — safeVaultRelPath security (CHAMBA-017).
 *
 * Covers all rejection paths: absolute, .., hidden segments (.obsidian etc.),
 * non-.md, Windows backslashes, and valid edge cases.
 */
import { describe, expect, it } from 'vitest';
import { safeVaultRelPath } from './safe-path.js';

describe('safeVaultRelPath', () => {
  // ── Valid paths ─────────────────────────────────────────────────────────────

  it('accepts a simple relative .md path', () => {
    const result = safeVaultRelPath('notes/my-note.md');
    expect(result).toEqual({ ok: 'notes/my-note.md' });
  });

  it('accepts a path starting with ./ (strips the leading .)', () => {
    const result = safeVaultRelPath('./temas/x.md');
    expect(result).toEqual({ ok: 'temas/x.md' });
  });

  it('accepts INDEX.md at root', () => {
    const result = safeVaultRelPath('INDEX.md');
    expect(result).toEqual({ ok: 'INDEX.md' });
  });

  it('accepts a deeply nested path', () => {
    const result = safeVaultRelPath('projects/api/docs/readme.md');
    expect(result).toEqual({ ok: 'projects/api/docs/readme.md' });
  });

  it('normalises NFC', () => {
    // 'é' as decomposed NFD → should become NFC
    const nfd = 'notes/caf\u0065\u0301.md'; // "café" decomposed
    const result = safeVaultRelPath(nfd);
    expect(result).toMatchObject({ ok: expect.any(String) });
    if ('ok' in result) {
      expect(result.ok).toBe('notes/caf\u00e9.md'); // NFC
    }
  });

  // ── Backslash normalisation ─────────────────────────────────────────────────

  it('normalises Windows backslashes to forward slashes', () => {
    const result = safeVaultRelPath('notes\\my-note.md', 'win32');
    expect(result).toEqual({ ok: 'notes/my-note.md' });
  });

  it('rejects ..\\fuera.md with win32 style (after backslash → slash: ../fuera.md)', () => {
    const result = safeVaultRelPath('..\\fuera.md', 'win32');
    expect(result).toMatchObject({ error: expect.stringContaining('..') });
  });

  // ── Absolute paths ──────────────────────────────────────────────────────────

  it('rejects a POSIX absolute path /foo.md', () => {
    const result = safeVaultRelPath('/foo.md');
    expect(result).toMatchObject({ error: expect.stringContaining('absoluta') });
  });

  it('rejects a Windows drive absolute path C:/foo.md', () => {
    const result = safeVaultRelPath('C:/foo.md');
    expect(result).toMatchObject({ error: expect.stringContaining('absoluta') });
  });

  it('rejects a Windows drive absolute path with backslash C:\\foo.md', () => {
    const result = safeVaultRelPath('C:\\foo.md');
    expect(result).toMatchObject({ error: expect.stringContaining('absoluta') });
  });

  it('rejects a UNC path \\\\server\\share\\note.md', () => {
    const result = safeVaultRelPath('\\\\server\\share\\note.md');
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  // ── Parent traversal ─────────────────────────────────────────────────────────

  it('rejects ../fuera.md', () => {
    const result = safeVaultRelPath('../fuera.md');
    expect(result).toMatchObject({ error: expect.stringContaining('..') });
  });

  it('rejects notes/../../etc/passwd.md', () => {
    const result = safeVaultRelPath('notes/../../etc/passwd.md');
    expect(result).toMatchObject({ error: expect.stringContaining('..') });
  });

  // ── Hidden segments ─────────────────────────────────────────────────────────

  it('rejects .obsidian/app.json (not .md but also hidden)', () => {
    const result = safeVaultRelPath('.obsidian/app.json');
    expect(result).toMatchObject({ error: expect.stringContaining('oculto') });
  });

  it('rejects .obsidian/config.md (hidden segment)', () => {
    const result = safeVaultRelPath('.obsidian/config.md');
    expect(result).toMatchObject({ error: expect.stringContaining('oculto') });
  });

  it('rejects .git/COMMIT_EDITMSG.md', () => {
    const result = safeVaultRelPath('.git/COMMIT_EDITMSG.md');
    expect(result).toMatchObject({ error: expect.stringContaining('oculto') });
  });

  it('rejects notes/.hidden.md (hidden file name)', () => {
    const result = safeVaultRelPath('notes/.hidden.md');
    expect(result).toMatchObject({ error: expect.stringContaining('oculto') });
  });

  // ── Non-.md extension ──────────────────────────────────────────────────────

  it('rejects notes.txt', () => {
    const result = safeVaultRelPath('notes.txt');
    expect(result).toMatchObject({ error: expect.stringContaining('.md') });
  });

  it('rejects notes/image.png', () => {
    const result = safeVaultRelPath('notes/image.png');
    expect(result).toMatchObject({ error: expect.stringContaining('.md') });
  });

  it('rejects a path with no extension', () => {
    const result = safeVaultRelPath('notes/my-note');
    expect(result).toMatchObject({ error: expect.stringContaining('.md') });
  });

  // ── Empty input ─────────────────────────────────────────────────────────────

  it('rejects empty string', () => {
    const result = safeVaultRelPath('');
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it('rejects whitespace-only string', () => {
    const result = safeVaultRelPath('   ');
    expect(result).toMatchObject({ error: expect.any(String) });
  });
});
