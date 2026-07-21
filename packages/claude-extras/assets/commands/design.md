---
description: Link a design source (Figma / mockups folder / standalone prototype) and set the UI-architecture preference
argument-hint: "link <name> <folder|.html|.zip|figma-url> | list | prefs [web=<arch>] [mobile=<arch>]"
---

Manage chamba **design sources** for **$ARGUMENTS**. A design source lives in
`.chamba/design/<name>.md` and **links** where the real design lives — chamba reads it,
your editor's model + Figma MCP / browser do the visual work. Keep binaries **outside the
repo**: link an external folder, don't copy mockups in.

Parse the first token as the sub-command:

## `link <name> <source>`
Create `.chamba/design/<name>.md` pointing at `<source>`. Detect the source type:

- a URL containing `figma.com` → set `figma:`
- a path ending in `.html`, `.htm` or `.zip` → set `prototype:` (a standalone to open/run)
- anything else → treat as a folder of mockups/specs → set `folder:`

Ask me for a one-line **description** if it isn't obvious from the ticket, then write the
pointer file (create `.chamba/design/` if needed):

```markdown
---
name: <name>
description: <one line>
figma: <url>            # only the one(s) that apply
folder: <path>
prototype: <path>
---
<brief: the prompt your design tool gave you, key screens, states, breakpoints, tokens>
```

Leave `folder`/`prototype` as the path I gave (a leading `~` is fine — chamba expands it).
Confirm what you wrote and where. Don't copy the design files into the repo.

## `list`
Call `chamba_load_design` (with the current ticket or an empty task) and show the linked
sources and the saved UI-architecture preference. If none exist, tell me how to link one.

## `prefs [web=<arch>] [mobile=<arch>]`
Call `chamba_design_prefs`. With no `web=`/`mobile=`, show the current preference. With one
or both, save them (e.g. `web=atomic` for Atomic Design, `mobile=screens` for Expo
screens+components). Web and mobile are separate; any value is accepted.

After linking, the design source is picked up automatically: `/ticket` and `/orq` call
`chamba_load_design` for visual tickets, and the planner/implementer/qa build and verify
against it, following the saved architecture.
