import { detectQaCapabilities } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_qa_capabilities';

const DESCRIPTION =
  'Probe what acceptance QA can run against this project + machine (NO LLM): detects ' +
  'whether it is web / mobile (React Native / Expo), which E2E tooling ships ' +
  '(Playwright/Cypress/Detox/Maestro/Appium), and enumerates the iOS simulators / ' +
  'Android emulators actually available (read-only: `xcrun simctl` / `adb` / ' +
  '`emulator -list-avds` — it lists, never boots). Call it at the start of a QA run so ' +
  "the qa agent picks the right mode. chamba doesn't drive the device — your editor's " +
  'mobile MCP or the terminal does.';

export function registerQaCapabilities(
  server: McpServer,
  logger: Logger,
  services: Services,
): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'QA capabilities (web + mobile probe)',
      description: DESCRIPTION,
      inputSchema: {},
    },
    async () => {
      const caps = await detectQaCapabilities({
        fs: services.fs,
        process: services.process,
        cwd: services.cwd,
      });

      logger.info(
        {
          tool: TOOL_NAME,
          projectKind: caps.projectKind,
          iosSimulators: caps.devices.ios.simulators,
          androidAvds: caps.devices.android.avds.length,
        },
        'qa-capabilities',
      );

      return {
        content: [{ type: 'text', text: caps.summary }],
        structuredContent: caps as unknown as Record<string, unknown>,
      };
    },
  );
}
