# Architecture

tokenmaxx is one loopback HTTP proxy with a small brain attached. Every design decision
follows one rule: prefer what the wire says over what we compute. The less we infer, the
less can drift.

## The shape

```
codex / claude / any harness
        │  http://127.0.0.1:8459/{openai|anthropic}/…
        ▼
   proxy (pass-through)  ──►  chatgpt.com | api.anthropic.com
        │ per request: inject the active account's credential
        │ per response: read usage from the body, rate-limit state from headers
        ▼
   manager daemon ── SQLite ── TUI / CLI over a unix socket
```

The proxy never rewrites protocol. It swaps auth headers on the way out and observes on
the way back. Requests stream untouched; a TransformStream tees bytes into a usage parser
as they pass.

## Where truth comes from

Both upstreams report live rate-limit state on **every response**: Anthropic in
`anthropic-ratelimit-unified-*` headers, the Codex backend in `x-codex-*` headers. The
proxy reads them as traffic flows, so the active account's pressure is always as fresh as
the last request, with zero extra calls. This is what makes switching reactive: crossing
the threshold rotates within one response, and a 429 rotates immediately and retries the
failed request on the next account before the client sees it.

The per-account usage endpoints remain as the fallback probe for idle accounts (they are
the only source for an account no traffic is touching). Token counts come from the usage
blocks in the response bodies themselves, and they cross-check exactly against the
clients' own session logs. Nothing in the analytics is estimated except the ≈ API price,
which is labeled as such.

## Why this scales across harnesses

The proxy sits below every harness at the HTTP layer. Anything that speaks the Anthropic
Messages API can point at `/anthropic`; anything that speaks the OpenAI Responses API can
point at `/openai` — Claude Code, the codex CLI, SDK apps, or a translator layer running
codex models inside a Claude-shaped harness. tokenmaxx neither knows nor cares which
client is on the other end; it routes by path prefix and injects the right credential.

`tokenmaxx install` wires the two native clients (an env var for claude, a provider block
for codex). That per-client config writing is the honestly fragile part of the system: a
TOML placement bug once left codex silently unrouted. The mitigation is verification, not
hope — `isInstalled`/`doctor` parse the configs semantically and check that routing is
actually in effect, and the TUI shows a banner when it is not.

## Adding a provider

A provider is: an upstream base URL, a credential injection, a rate-limit header parser,
and a usage probe. Everything else (rotation policy, storage, TUI, analytics) is already
provider-shaped. The two existing providers are the templates.

## What is deliberately not here

No response buffering (streams pass through untouched). No client-side token estimation
(only what the wire reports). No consensus sampling of probe endpoints (headers made it
redundant). No stored usage history without a reader. When a number cannot be observed,
we show nothing rather than a guess.
