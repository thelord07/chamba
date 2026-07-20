import type { FilesystemPort } from '../ports/filesystem.js';
import type { ProcessPort } from '../ports/process.js';
import { joinPath } from '../util/path.js';
import { WorkspaceScanner } from '../workspace/scanner.js';
import type { MobileFinding, ProjectRef } from '../workspace/workspace.js';

/** Web frameworks whose presence means the project has a browser-testable UI. */
const UI_FRAMEWORKS = new Set(['Next.js', 'Angular', 'Remix', 'Astro', 'Svelte', 'Vue', 'React']);

// Web E2E tooling: dependency name -> label.
const WEB_E2E_LIBS: ReadonlyArray<readonly [string, string]> = [
  ['@playwright/test', 'Playwright'],
  ['playwright', 'Playwright'],
  ['cypress', 'Cypress'],
];

export type ProjectKind = 'web' | 'mobile' | 'both' | 'unknown';

/** iOS Simulator availability, enumerated read-only via `xcrun simctl`. */
export interface IosDevices {
  /** `xcrun simctl` ran (macOS + Xcode present). */
  available: boolean;
  /** Count of available simulator devices. */
  simulators: number;
  /** Names of currently booted simulators. */
  booted: string[];
  /** Why it's unavailable, when `available` is false. */
  note?: string;
}

/** Android emulator/device availability, enumerated read-only via `emulator`/`adb`. */
export interface AndroidDevices {
  /** `emulator` or `adb` ran (Android SDK present on PATH). */
  available: boolean;
  /** Defined AVDs (`emulator -list-avds`). */
  avds: string[];
  /** Serials of running devices/emulators in `device` state (`adb devices`). */
  running: string[];
  /** Why it's unavailable, when `available` is false. */
  note?: string;
}

/**
 * What the running machine + project support for acceptance QA — the deterministic
 * facts the `qa` agent uses to pick a mode. NO LLM: dependency scanning + read-only
 * device enumeration. chamba never boots a simulator; it lists what's available.
 */
export interface QaCapabilities {
  projectKind: ProjectKind;
  /** Web E2E tooling detected in project manifests (Playwright, Cypress). */
  webE2e: string[];
  /** React Native / Expo apps detected in the workspace. */
  mobileApps: MobileFinding[];
  /** Union of mobile E2E tooling across the mobile apps (Detox, Maestro, …). */
  mobileE2e: string[];
  devices: { ios: IosDevices; android: AndroidDevices };
  expo: { present: boolean; eas: boolean };
  /** One-line prose summary for the qa agent to reason from. */
  summary: string;
}

export interface QaCapabilitiesInput {
  fs: FilesystemPort;
  process: ProcessPort;
  /** Workspace root to inspect. */
  cwd: string;
}

/**
 * Probe the project + machine for what acceptance QA can run against. Never throws:
 * a missing `xcrun`/`adb` becomes `available: false` with a note, not a crash — the
 * whole point is to report honestly what the environment supports.
 */
export async function detectQaCapabilities(input: QaCapabilitiesInput): Promise<QaCapabilities> {
  const ws = await new WorkspaceScanner(input.fs).scan(input.cwd);
  const mobileApps = ws.mobile ?? [];
  const mobileE2e = unique(mobileApps.flatMap((m) => m.e2e));

  const webE2e = await detectWebE2e(input.fs, input.cwd, ws.projects);
  const hasWeb =
    ws.projects.some((p) => p.framework !== undefined && UI_FRAMEWORKS.has(p.framework)) ||
    webE2e.length > 0;
  const hasMobile = mobileApps.length > 0;
  const projectKind: ProjectKind =
    hasWeb && hasMobile ? 'both' : hasMobile ? 'mobile' : hasWeb ? 'web' : 'unknown';

  const ios = hasMobile ? await probeIos(input.process) : idleIos();
  const android = hasMobile ? await probeAndroid(input.process) : idleAndroid();

  const expo = {
    present: mobileApps.some((m) => m.expo !== undefined),
    eas: mobileApps.some((m) => m.hasEas),
  };

  const caps: QaCapabilities = {
    projectKind,
    webE2e,
    mobileApps,
    mobileE2e,
    devices: { ios, android },
    expo,
    summary: '',
  };
  caps.summary = summarize(caps);
  return caps;
}

// --- web ----------------------------------------------------------------------

async function detectWebE2e(
  fs: FilesystemPort,
  cwd: string,
  projects: ProjectRef[],
): Promise<string[]> {
  const found: string[] = [];
  for (const p of projects) {
    const rel = p.path === '.' ? 'package.json' : joinPath(p.path, 'package.json');
    const deps = await readManifestDeps(fs, joinPath(cwd, rel));
    for (const [sig, label] of WEB_E2E_LIBS) {
      if (sig in deps && !found.includes(label)) found.push(label);
    }
  }
  return found;
}

async function readManifestDeps(fs: FilesystemPort, path: string): Promise<Record<string, string>> {
  try {
    const pkg = JSON.parse(await fs.readFile(path)) as Record<string, unknown>;
    return {
      ...(asStringRecord(pkg.dependencies) ?? {}),
      ...(asStringRecord(pkg.devDependencies) ?? {}),
    };
  } catch {
    return {};
  }
}

function asStringRecord(value: unknown): Record<string, string> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, string>) : null;
}

// --- iOS ----------------------------------------------------------------------

function idleIos(): IosDevices {
  return { available: false, simulators: 0, booted: [], note: 'not a mobile project' };
}

async function probeIos(process: ProcessPort): Promise<IosDevices> {
  const res = await tryExec(process, 'xcrun', ['simctl', 'list', 'devices', 'available']);
  if (res?.exitCode !== 0) {
    return {
      available: false,
      simulators: 0,
      booted: [],
      note: 'no iOS Simulator (needs macOS + Xcode command-line tools)',
    };
  }
  const booted: string[] = [];
  let simulators = 0;
  const re = /^\s+(.+?) \([0-9A-Fa-f-]{8,}\) \((Booted|Shutdown|Booting|Shutting Down)\)\s*$/;
  for (const line of res.stdout.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    simulators++;
    if (m[2] === 'Booted' && m[1]) booted.push(m[1]);
  }
  return { available: true, simulators, booted };
}

// --- Android ------------------------------------------------------------------

function idleAndroid(): AndroidDevices {
  return { available: false, avds: [], running: [], note: 'not a mobile project' };
}

async function probeAndroid(process: ProcessPort): Promise<AndroidDevices> {
  const avdsRes = await tryExec(process, 'emulator', ['-list-avds']);
  const devicesRes = await tryExec(process, 'adb', ['devices']);
  const emulatorOk = avdsRes !== null && avdsRes.exitCode === 0;
  const adbOk = devicesRes !== null && devicesRes.exitCode === 0;
  if (!emulatorOk && !adbOk) {
    return {
      available: false,
      avds: [],
      running: [],
      note: 'no Android tooling on PATH (needs Android SDK: emulator/adb)',
    };
  }

  const avds = emulatorOk
    ? avdsRes.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^[A-Za-z0-9._-]+$/.test(l))
    : [];

  const running: string[] = [];
  if (adbOk) {
    for (const line of devicesRes.stdout.split('\n').slice(1)) {
      const [serial, state] = line.trim().split(/\s+/);
      if (serial && state === 'device') running.push(serial);
    }
  }

  return { available: true, avds, running };
}

// --- shared -------------------------------------------------------------------

async function tryExec(
  process: ProcessPort,
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number } | null> {
  try {
    return await process.exec(command, args);
  } catch {
    return null;
  }
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function summarize(caps: QaCapabilities): string {
  if (caps.projectKind === 'unknown') {
    return 'No web or mobile app detected from manifests — nothing to acceptance-test automatically.';
  }
  const parts: string[] = [];

  if (caps.mobileApps.length > 0) {
    const app = caps.mobileApps[0];
    const flavor = app?.expo ? `Expo ${app.expo}` : 'React Native';
    parts.push(`Mobile project (${flavor}).`);
    parts.push(describeIos(caps.devices.ios));
    parts.push(describeAndroid(caps.devices.android));
    if (caps.mobileE2e.length > 0) parts.push(`Mobile E2E: ${caps.mobileE2e.join(', ')}.`);
    parts.push(
      'Drive a simulator/emulator via your Expo/mobile MCP (or `expo start`); if none is ' +
        'available, co-pilot on a physical device via Expo Go. Login stays human.',
    );
  }
  if (caps.projectKind === 'web' || caps.projectKind === 'both') {
    const e2e = caps.webE2e.length > 0 ? caps.webE2e.join(', ') : 'none in project';
    parts.push(`Web UI present (E2E: ${e2e}). Use Playwright/a browser MCP, else co-pilot.`);
  }
  return parts.join(' ');
}

function describeIos(ios: IosDevices): string {
  if (!ios.available) return `iOS: ${ios.note}.`;
  const booted = ios.booted.length > 0 ? ` (booted: ${ios.booted.join(', ')})` : '';
  return `iOS: ${ios.simulators} simulator(s) available${booted}.`;
}

function describeAndroid(a: AndroidDevices): string {
  if (!a.available) return `Android: ${a.note}.`;
  return `Android: ${a.avds.length} AVD(s), ${a.running.length} running.`;
}
