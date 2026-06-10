---
description: Show the connected Obsidian vault and the notes chamba can see
---

Call `chamba_vault_status` and show me the result clearly:

- The resolved vault path and whether it came from `CHAMBA_OBSIDIAN_VAULT_PATH`
  or autodetection.
- How many markdown notes chamba can see, and the list of note files.

If no vault is found, or the note count is 0, or the path ends in `.obsidian`,
tell me to set `CHAMBA_OBSIDIAN_VAULT_PATH` to the **vault root** (the folder that
*contains* `.obsidian`, not `.obsidian` itself) and restart the editor.
