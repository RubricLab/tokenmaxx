<div align="center">

<img alt="TOKENMAXX" src="media/wordmark.png" width="520">

<br/>

**Juggle rate limits across all your Codex and Claude Code accounts. See every token you burn.**

<sub>macOS · [Bun](https://bun.sh) · a [Rubric Labs](https://rubriclabs.com) project · not affiliated with OpenAI or Anthropic</sub>

<br/><br/>

<img alt="a day of juggling: meters fill, accounts max out, the active dot hops to fresh ones" src="media/relay.gif" width="820">

</div>

## Install

```bash
bun add -g tokenmaxx
```

```bash
tokenmaxx login codex     # sign in; your existing sessions stay untouched
tokenmaxx login claude
tokenmaxx install         # route native codex & claude through tokenmaxx

codex                     # use your clients as before
claude                    # tokenmaxx injects the account, per request
```

## What it does

You run a fleet of coding agents, and they burn through the five-hour or
weekly limit on whichever subscription you're using:

<div align="center">
<img alt="a desktop full of parallel agent sessions burning tokens" src="media/fleet.gif" width="820">
</div>

tokenmaxx runs a loopback proxy that reads the active account on every request
and injects its credential, so a switch lands on the very next request, even
mid-turn, with your clients running unmodified. Credentials stay in the macOS
Keychain; nothing but opaque references touches disk.

## The dashboard

Run `tokenmaxx`. **Accounts** shows every account and its live rate-limit
windows, colored by pressure, with plan tier and reset countdowns inline. Rows
sort by pressure; the ● marks where traffic is going right now.

<div align="center">
<img alt="every account and its live rate-limit windows, colored by pressure" src="media/accounts.png" width="820">
</div>

**Analytics** is combined token throughput across all accounts and both
providers, with the ≈ API-list-price value you're pulling from your flat
subscriptions. Tokens are metered as responses stream by, never buffered, so
every number is cross-checkable against your clients' own session logs. Press
`m` for the full pricing breakdown per model.

<div align="center">
<img alt="combined token throughput and API-list-price value across all accounts" src="media/analytics.png" width="820">
</div>

**Settings** holds the master on/off per provider, then auto-rotation, the
switch threshold, and cooldown, applied live.

<div align="center">
<img alt="routing, auto-rotation, threshold, and cooldown, tuned per provider" src="media/settings.png" width="820">
</div>

## Auto-rotation

Turn it on and tokenmaxx steps off an account the moment its fullest window
crosses your threshold, onto the one with the most headroom. If an account
still hits its hard limit mid-flight, the proxy rotates and retries that
request before your client ever sees the 429. Off by default; enabling it is
your confirmation that your provider permits this use.

```bash
tokenmaxx auto both on --threshold 90    # or: codex | claude … off
```

## How it works

A single loopback proxy on `127.0.0.1:8459`, and the clients you already use.

- **Account per request.** The proxy reads which account is active for each
  request and injects its credential. Switching lands on the next request.
- **Pressure read for free.** Both providers report rate-limit state on every
  response; the proxy reads it as traffic streams by, so it always knows how
  full the active account is, with zero extra requests.
- **Harness-agnostic.** Anything speaking the Anthropic or OpenAI Responses API
  can point at `/anthropic` or `/openai` and get the same juggling.

## Commands

```text
tokenmaxx                                  live dashboard
tokenmaxx login <codex|claude>             sign in; isolated, idempotent
tokenmaxx install                          route native codex & claude
tokenmaxx uninstall                        restore native config
tokenmaxx switch <codex|claude> <email>    make an account active
tokenmaxx auto <both|codex|claude> <on|off> [--threshold N]
tokenmaxx list | status | refresh | doctor
```

Env: `TOKENMAXX_HOME`, `TOKENMAXX_PROXY_PORT`, `TOKENMAXX_THEME`.

## Not affiliated

An independent [Rubric Labs](https://rubriclabs.com) project, not an official
product of, affiliated with, or endorsed by OpenAI or Anthropic. Use only
accounts you own, and only where the relevant terms permit account automation.
Inspired by [codex-account-switcher](https://github.com/Sls0n/codex-account-switcher).

<div align="center">
<br/>
<a href="https://rubriclabs.com"><img alt="Rubric Labs" src="media/rubric-mark.svg" width="40"></a>
<br/>
<sub>Built by <a href="https://rubriclabs.com">Rubric Labs</a> · <a href="./LICENSE">go nuts</a></sub>
</div>
