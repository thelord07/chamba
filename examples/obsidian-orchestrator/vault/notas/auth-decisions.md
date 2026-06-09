# Auth decisions

For the demo project we authenticate users with **magic links** instead of
passwords. Links are sent via Resend and expire after 15 minutes.

Open question: do we need rate limiting on the magic-link request endpoint?
