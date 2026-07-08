---
"@chamba/core": minor
---

feat(workspace): detect the auth stack into a robust `## Auth` section

`chamba_workspace_init` now scans each project's dependencies for auth providers
(Auth0, Clerk, AWS Cognito, Supabase, Firebase, Auth.js/NextAuth, Okta, WorkOS,
Kinde, Stytch, Lucia, Passport, JWT libs; plus Python: Authlib, FastAPI Users,
django-allauth, python-jose/PyJWT) and writes an `## Auth` section to
`.chamba/workspace.md` listing each provider, the packages that signalled it, and
which projects use it. When nothing is detected it prompts the human to document
auth by hand. This is the base the QA co-pilot and planner rely on to know how
users are provisioned — the qa agent never creates identity-provider users, it
asks. Heuristic, no LLM. New exported types `AuthFinding` / `ProjectAuth`.
