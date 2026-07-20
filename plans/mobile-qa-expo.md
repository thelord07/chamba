# Plan — QA móvil: detectar React Native/Expo y correr en simuladores/emuladores vía MCP

> Estado: ✅ Completada — 0.16.0 · Respeta los 10 principios (cero LLM).

## Idea

Hoy el `qa` sabe adaptarse a **web**: si el repo trae Playwright/Cypress o hay un MCP de
browser, maneja el browser y recorre los criterios; si no, co-pilotea en terminal. Falta el
caso **móvil**: cuando el repo es **React Native / Expo**, el `qa` debería

1. **detectarlo** (deps + archivos, determinista),
2. usar el **MCP del editor** (Expo MCP, un MCP de control de device tipo `mobile-mcp`, o
   Maestro) para levantar la app en un **simulador iOS / emulador Android** y recorrer cada
   criterio de aceptación, y
3. si no hay MCP, **co-pilotear igual** que en web pero sobre el simulador/emulador (o tu
   device físico vía Expo Go/QR).

chamba **no** maneja el simulador ni llama a Expo (principio #1). Aporta lo de siempre:
**detección determinista**, un **probe de capacidades read-only**, el **prompt del rol** y la
**estructura del plan**. El razonamiento y el manejo del device los hace el modelo del editor
con su MCP. Es el mismo molde que `## Auth` (detectar) + la escalera de modos del `qa`.

## Qué hace / qué NO hace chamba (límite explícito)

- **SÍ**: detecta RN/Expo (deps + `app.json`/`eas.json`/dirs `ios`·`android`); **enumera**
  simuladores/emuladores *disponibles* (`xcrun simctl list devices available`, `adb devices`,
  `emulator -list-avds` — solo lista, read-only); reporta qué tooling E2E hay; y le dice al
  `qa`/`planner` qué modo elegir.
- **NO**: bootear simuladores, correr la app, instalar Xcode/Android SDK, ni bundlear/llamar
  el Expo MCP. Eso lo hace el agente (vía MCP/terminal), no chamba. Enumerar ≠ ejecutar
  (mismo criterio que `doctor` corriendo `git`).

## Cambios

### A. Core — detección móvil (scanner → `## Mobile`)
- `packages/core/src/workspace/scanner.ts` — `detectMobile(pkg, nearbyFiles)`:
  - **Expo**: dep `expo`/`@expo/*` → `expo: 'managed' | 'bare'` (bare si hay dirs `ios/`+`android/`
    junto al manifest o dep `expo-dev-client`); `hasEas` si existe `eas.json`; `hasDevClient`
    si dep `expo-dev-client`.
  - **React Native puro**: dep `react-native` sin `expo`.
  - **plataformas**: iOS/Android según dirs `ios/`·`android/`; managed → ambas por defecto.
  - **e2e móvil**: `detox`, `appium`/`@wdio/*`, y `.maestro/` (dir de flows) → Maestro.
- Ordenar en `FRAMEWORKS`: `['expo','Expo (React Native)']` y `['react-native','React Native']`
  **antes** de `['react','React']`, para que el top-line `framework` no diga "React".
- `packages/core/src/workspace/workspace.ts` — tipos:
  `MobileTarget { expo?: 'managed'|'bare'; reactNative: boolean; platforms: ('ios'|'android')[];
  hasEas: boolean; hasDevClient: boolean; e2e: string[] }`; `ProjectRef.mobile?`;
  `Workspace.mobile?` (agregado por proyecto, como `auth`).
- `renderWorkspaceMarkdown` — sección **`## Mobile`** (paralela a `## Auth`): plataformas,
  managed/bare, EAS/dev-client, tooling E2E, y nota de que el login sigue siendo humano y que
  QA necesita un simulador/emulador o Expo Go.
- Tests del scanner: Expo managed, RN bare (`ios/`+`android/`), RN puro, detección eas/detox/maestro.

### B. MCP — tool `chamba_qa_capabilities` (probe read-only, cero LLM)
- **NUEVO `packages/mcp/src/tools/qa-capabilities.ts`** — input `{}`. Reporta determinista:
  - **Tipo de proyecto**: web / mobile / ambos (del scanner sobre `cwd`).
  - **Tooling E2E** presente (Playwright/Cypress/Detox/Maestro/Appium).
  - **Runtimes disponibles en la máquina** vía `ProcessPort` (solo enumera):
    - iOS: `xcrun simctl list devices available` (si macOS y `xcrun` existe).
    - Android: `adb devices` + `emulator -list-avds` (si están en PATH).
    - Expo/EAS: si `expo`/`eas` está en deps.
  - Degrada limpio como `doctor`: si `xcrun`/`adb` no existen → "no disponible", no rompe.
  - Output estructurado + un `reason` en prosa para que el `qa` **elija modo**.
- Registrar en `server.ts`; sumar `chamba_qa_capabilities` al snapshot de `server.test.ts`.
- Consolida el "detecta antes de elegir modo" que hoy es prosa en `qa.md`, y lo comparten
  `planner` y `qa` (misma respuesta determinista, sin divergencia).

### C. claude-extras — `qa.md` gana el modo móvil
- Extender la escalera "adapta al proyecto" con **Móvil (React Native / Expo)**: primero
  llamar `chamba_qa_capabilities`, luego:
  - **MCP de móvil disponible** (Expo MCP / `mobile-mcp` / Maestro) → úsalo para bootear el
    simulador/emulador, levantar la app (`expo start` / dev client / EAS build) y recorrer
    cada criterio; screenshots del device.
  - **Simulador/emulador disponible sin MCP** → co-pilotea: corré `expo start`, booteá el sim
    (`xcrun simctl boot` / `emulator @avd`), abrí la app, guiame paso a paso; screenshots vía
    `xcrun simctl io booted screenshot` / `adb exec-out screencap`.
  - **Sin tooling de device** → fallback honesto: co-pilotear en tu **device físico** vía
    Expo Go/QR; vos manejás, el agente guía, vos capturás.
- Reglas que se mantienen: **login humano** siempre (nunca automatizar credenciales;
  multi-actor = reset a login / cuenta nueva, más manual en móvil — decirlo); no-destructivo;
  PASS/FAIL honesto; screenshots al mismo `<evidence-root>/<ticket>/<run-date>/NN-...`.
- Nota de límite: **chamba no maneja el simulador ni llama a Expo — tu MCP/terminal sí**
  (eco de la línea del Figma MCP).
- Nota managed/bare: preferí simulador/emulador para reproducibilidad; Expo Go sirve para apps
  managed, pero los módulos nativos requieren dev client / EAS build.

### D. claude-extras — `planner.md` emite `## QA plan` móvil
- Cuando el target es una app móvil, el `## QA plan` dice: **plataforma(s)** (iOS/Android),
  cómo **levantar** (expo start / dev client / EAS build / Expo Go), device/OS objetivo, y por
  criterio los pasos **on-device**. Reusa `## Design` para el check visual de pantallas RN.

### E. claude-extras — comandos
- `ticket.md` / `qa.md` (paso QA): mencionar que el `qa` detecta móvil y usa el MCP de device
  si está. Cambios chicos; la lógica vive en el agente.

### F. Reviewer heurístico (opcional, conservador)
- `packages/core/src/plan/validator.ts` — check `mobile-qa-missing-target`: si el plan señala
  móvil (RN/Expo) y hay `## QA plan` pero no nombra plataforma/simulador/emulador/Expo Go →
  warning (no bloquea). Parkeable si mete ruido.

### G. Docs
- README EN/ES: fila `chamba_qa_capabilities` + bullet "QA móvil: detecta React Native/Expo y
  corre en simuladores/emuladores vía el MCP de tu editor (cero LLM)". Landing: fila en tools +
  un beneficio. claude-extras README: sección "QA móvil (Expo/React Native)". Bump versión.

## Verificación
1. `pnpm -r build && pnpm -r test` verde (scanner + tool + validator).
2. Scanner: Expo managed → `## Mobile` managed + plataformas; RN bare con `ios/`+`android/` →
   bare; detecta eas/detox/maestro.
3. `chamba_qa_capabilities` en la máquina real: lista simuladores/emuladores (o "no disponible"
   limpio); reporta tooling.
4. Flujo: ticket de una pantalla RN → planner emite `## QA plan` móvil → `/ticket` delega al
   `qa`, que llama al probe, elige modo (MCP/simulador/Expo Go), levanta la app, pide login,
   valida criterios y deja screenshots del device.

## Release
Feature (scanner + tool + prompts) → minor. Propuesta: **0.16.0** (antes que "más editores",
que pasaría a 0.17.0). Confirmar orden/versión antes de ejecutar.
