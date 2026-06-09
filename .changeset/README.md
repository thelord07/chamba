# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets).

Add a changeset for any change that should appear in a release:

```bash
pnpm changeset
```

The `@chamba/*` packages are versioned in lockstep (see `fixed` in `config.json`),
so they always release together with the same version.
