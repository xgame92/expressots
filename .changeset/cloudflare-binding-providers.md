---
"@expressots/adapter-express": minor
---

Add typed, request-local Cloudflare binding providers for KV, D1, R2, and
Queue producers.

`cloudflareBindings<Env>()` creates memoized, exactly typed tokens that handlers
resolve through `req.services`. The feature is opt-in and keeps
`req.cloudflare.env` available for direct access.
