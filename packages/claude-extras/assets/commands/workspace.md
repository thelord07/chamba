---
description: Initialize, show or reload the chamba workspace map
argument-hint: init | show | reload
---

Manage the chamba workspace map (`.chamba/workspace.md`) for: **$ARGUMENTS**

- For `init` (or empty): call `chamba_workspace_init`. If it reports the file
  already exists, show me the current contents and ask before changing anything.
- For `show`: call `chamba_workspace_show` and render the result.
- For `reload`: call `chamba_workspace_reload` and show me the proposed diff.
  Do NOT apply it automatically — I may have hand-edited the file.
