import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { WorkspaceScanner } from './scanner.js';

const scan = (files: Record<string, string>, root: string) =>
  new WorkspaceScanner(new MemoryFilesystem(files)).scan(root);

describe('WorkspaceScanner', () => {
  it('detects a Node project: language, framework, project name, README description', async () => {
    const ws = await scan(
      {
        '/proj/package.json': JSON.stringify({ name: 'myapp', dependencies: { express: '^4' } }),
        '/proj/src/index.ts': 'export const x = 1;\n',
        '/proj/README.md': '# myapp\n\nA tiny HTTP API.\n',
      },
      '/proj',
    );

    expect(ws.languages).toContain('TypeScript');
    expect(ws.framework).toBe('Express');
    expect(ws.projects.map((p) => p.name)).toContain('myapp');
    expect(ws.folderMap).toContain('src');
    expect(ws.description).toBe('A tiny HTTP API.');
  });

  it('detects a Python project from pyproject.toml', async () => {
    const ws = await scan(
      {
        '/py/pyproject.toml': '[project]\nname = "pyapp"\ndependencies = ["flask>=3"]\n',
        '/py/app/main.py': 'print(1)\n',
      },
      '/py',
    );

    expect(ws.languages).toContain('Python');
    expect(ws.framework).toBe('Flask');
    expect(ws.projects.map((p) => p.name)).toContain('pyapp');
  });

  it('detects a mixed monorepo with multiple projects', async () => {
    const ws = await scan(
      {
        '/m/package.json': JSON.stringify({ name: 'root', private: true }),
        '/m/packages/api/package.json': JSON.stringify({
          name: 'api',
          dependencies: { fastify: '^4' },
        }),
        '/m/packages/api/src/server.ts': 'export {};\n',
        '/m/packages/web/package.json': JSON.stringify({
          name: 'web',
          dependencies: { react: '^18' },
        }),
        '/m/packages/web/src/app.tsx': 'export {};\n',
        '/m/svc/pyproject.toml': '[project]\nname = "svc"\ndependencies = ["fastapi"]\n',
        '/m/svc/main.py': 'print(1)\n',
      },
      '/m',
    );

    const names = ws.projects.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['api', 'web', 'svc']));
    expect(ws.languages).toEqual(expect.arrayContaining(['TypeScript', 'Python']));
  });

  it('detects the auth stack per project and aggregates it', async () => {
    const ws = await scan(
      {
        '/m/webapp/package.json': JSON.stringify({
          name: 'webapp',
          dependencies: { next: '^15', '@auth0/nextjs-auth0': '^3', jsonwebtoken: '^9' },
        }),
        '/m/webapp/src/app.tsx': 'export {};\n',
        '/m/api/package.json': JSON.stringify({
          name: 'api',
          dependencies: { express: '^5', '@aws-sdk/client-cognito-identity-provider': '^3' },
        }),
        '/m/api/src/server.ts': 'export {};\n',
        '/m/svc/pyproject.toml':
          '[project]\nname = "svc"\ndependencies = ["firebase-admin", "pyjwt"]\n',
        '/m/svc/main.py': 'print(1)\n',
      },
      '/m',
    );

    const byProvider = Object.fromEntries((ws.auth ?? []).map((a) => [a.provider, a]));
    expect(byProvider.Auth0?.projects).toContain('webapp');
    expect(byProvider.Auth0?.packages).toContain('@auth0/nextjs-auth0');
    expect(byProvider['AWS Cognito']?.projects).toContain('api');
    expect(byProvider['Firebase Auth']?.projects).toContain('svc');
    expect(byProvider['JWT (jsonwebtoken)']?.projects).toContain('webapp');
  });

  it('detects a managed Expo app (both platforms, no native dirs)', async () => {
    const ws = await scan(
      {
        '/app/package.json': JSON.stringify({
          name: 'mobileapp',
          dependencies: { expo: '^51', react: '18', 'react-native': '0.74' },
        }),
        '/app/app.json': '{"expo":{"name":"mobileapp"}}',
        '/app/App.tsx': 'export default function App(){return null}\n',
      },
      '/app',
    );

    expect(ws.framework).toBe('Expo (React Native)');
    const m = (ws.mobile ?? []).find((x) => x.project === 'mobileapp');
    expect(m?.expo).toBe('managed');
    expect(m?.reactNative).toBe(true);
    expect(m?.platforms).toEqual(['ios', 'android']);
    expect(m?.hasEas).toBe(false);
  });

  it('detects a bare React Native app with native dirs, EAS and Detox', async () => {
    const ws = await scan(
      {
        '/rn/package.json': JSON.stringify({
          name: 'bareapp',
          dependencies: { expo: '^51', 'react-native': '0.74', 'expo-dev-client': '^4' },
          devDependencies: { detox: '^20' },
        }),
        '/rn/eas.json': '{"build":{}}',
        '/rn/ios/Podfile': 'platform :ios\n',
        '/rn/android/build.gradle': 'apply plugin: "com.android.application"\n',
        '/rn/.maestro/login.yaml': 'appId: com.bareapp\n',
        '/rn/App.tsx': 'export default function App(){return null}\n',
      },
      '/rn',
    );

    const m = (ws.mobile ?? []).find((x) => x.project === 'bareapp');
    expect(m?.expo).toBe('bare');
    expect(m?.platforms).toEqual(['ios', 'android']);
    expect(m?.hasEas).toBe(true);
    expect(m?.hasDevClient).toBe(true);
    expect(m?.e2e).toEqual(expect.arrayContaining(['Detox', 'Maestro']));
  });

  it('detects React Native without Expo', async () => {
    const ws = await scan(
      {
        '/rn/package.json': JSON.stringify({
          name: 'rnapp',
          dependencies: { 'react-native': '0.74', react: '18' },
        }),
        '/rn/ios/Podfile': 'platform :ios\n',
        '/rn/index.js': 'export {};\n',
      },
      '/rn',
    );

    expect(ws.framework).toBe('React Native');
    const m = (ws.mobile ?? []).find((x) => x.project === 'rnapp');
    expect(m?.reactNative).toBe(true);
    expect(m?.expo).toBeUndefined();
    expect(m?.platforms).toEqual(['ios']);
  });

  it('leaves mobile empty for a non-mobile project', async () => {
    const ws = await scan(
      {
        '/p/package.json': JSON.stringify({ name: 'p', dependencies: { react: '^18' } }),
        '/p/src/app.tsx': 'export {};\n',
      },
      '/p',
    );
    expect(ws.mobile).toBeUndefined();
  });

  it('leaves auth empty when no auth library is present', async () => {
    const ws = await scan(
      {
        '/p/package.json': JSON.stringify({ name: 'p', dependencies: { express: '^5' } }),
        '/p/src/i.ts': 'export {};\n',
      },
      '/p',
    );
    expect(ws.auth ?? []).toEqual([]);
  });

  it('skips nested linked worktrees but keeps real repos', async () => {
    const ws = await scan(
      {
        // real repo: `.git` is a directory (has files under it)
        '/ws/app/package.json': JSON.stringify({ name: 'app' }),
        '/ws/app/.git/HEAD': 'ref: refs/heads/main\n',
        '/ws/app/src/index.ts': 'export {};\n',
        // linked worktree: `.git` is a FILE (a gitdir pointer)
        '/ws/WORKTREES/app-feature/.git': 'gitdir: /ws/app/.git/worktrees/app-feature\n',
        '/ws/WORKTREES/app-feature/package.json': JSON.stringify({ name: 'app' }),
        '/ws/WORKTREES/app-feature/src/index.ts': 'export {};\n',
      },
      '/ws',
    );

    const paths = ws.projects.map((p) => p.path);
    expect(paths).toContain('app');
    expect(paths.some((p) => p.startsWith('WORKTREES'))).toBe(false);
  });

  it('still scans a worktree when pointed straight at it (depth 0)', async () => {
    const ws = await scan(
      {
        '/wt/.git': 'gitdir: /main/.git/worktrees/wt\n',
        '/wt/package.json': JSON.stringify({ name: 'wt-app' }),
        '/wt/src/index.ts': 'export {};\n',
      },
      '/wt',
    );

    expect(ws.projects.map((p) => p.name)).toContain('wt-app');
  });

  it('detects coding-rule files across repos, non-exclusively', async () => {
    const ws = await scan(
      {
        '/ws/api/package.json': JSON.stringify({ name: 'api' }),
        '/ws/api/.cursor/rules/style.mdc': '# style',
        '/ws/web/package.json': JSON.stringify({ name: 'web' }),
        '/ws/web/CLAUDE.md': '# claude rules',
        '/ws/AGENTS.md': '# agents',
      },
      '/ws',
    );

    const paths = ws.ruleSources.map((r) => r.path).sort();
    expect(paths).toEqual(['AGENTS.md', 'api/.cursor/rules/style.mdc', 'web/CLAUDE.md']);
    expect(new Set(ws.ruleSources.map((r) => r.editor))).toEqual(
      new Set(['Agents', 'Cursor', 'Claude Code']),
    );
  });

  it('respects .gitignore and never includes node_modules', async () => {
    const ws = await scan(
      {
        '/r/package.json': JSON.stringify({ name: 'r' }),
        '/r/.gitignore': 'secret.txt\nignored-dir/\n',
        '/r/secret.txt': 'nope',
        '/r/ignored-dir/a.ts': 'x',
        '/r/keep/b.ts': 'y',
        '/r/node_modules/lib/index.js': 'z',
      },
      '/r',
    );

    expect(ws.folderMap).toContain('keep');
    expect(ws.folderMap).not.toContain('ignored-dir');
    expect(ws.folderMap).not.toContain('node_modules');
  });
});
