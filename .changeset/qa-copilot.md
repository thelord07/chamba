---
"@chamba/claude-extras": patch
---

fix(qa): the qa agent co-pilots instead of auto-driving

The acceptance-QA agent is now explicitly a **co-pilot**, not an autopilot:

- **Doesn't create identity-provider users.** It detects the auth system
  (Auth0/Firebase/Cognito/Clerk/Supabase/…) and asks the human to provision or
  confirm the needed users+roles, instead of trying to create them. It still
  applies the local **data** seed itself (DB rows/fixtures are separate from identity).
- **Login is always the human's step.** It opens the browser and pauses for the
  human to log in — never automates credentials (SSO/2FA/Auth0/Firebase break that).
- **Multi-user flows.** When a criterion needs a different user/role, it pauses and
  asks the human to re-log in as that actor, then continues.

Updated `qa.md`, the planner's `## QA plan` guidance, and the `/ticket` + `/qa`
command steps to match.
