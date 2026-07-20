<div align="center">

<img alt="TOKENMAXX" src="media/wordmark.png" width="520">

<br/>

**Switch between your own Codex and Claude Code accounts, without logging in and out. See every token you burn.**

<sub>macOS · [Bun](https://bun.sh) · a [Rubric Labs](https://rubriclabs.com) project · not affiliated with OpenAI or Anthropic</sub>

<br/><br/>

<img alt="a day of switching: meters fill, and the active dot moves to the account with the most headroom" src="media/relay.gif" width="820">

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

You pay for more than one Claude or ChatGPT subscription, and your coding
agents fill the five-hour or weekly window on whichever account is signed in:

<div align="center">
<img alt="a desktop full of parallel agent sessions burning tokens" src="media/fleet.gif" width="820">
</div>

tokenmaxx runs a loopback proxy that reads the active account on every request
and injects its credential, so a switch lands on the very next request, even
mid-turn, with your clients running unmodified. Each account stays exactly what
it is: its own login, its own billing, its own limits, enforced by the provider
as always. Credentials stay in the macOS Keychain; nothing but opaque
references touches disk.

## The dashboard

Run `tokenmaxx`. **Accounts** shows every account and its live rate-limit
windows, colored by pressure, with plan tier and reset countdowns inline. Rows
sort by pressure; the ● marks where traffic is going right now.

<div align="center">
<img alt="every account and its live rate-limit windows, colored by pressure" src="media/accounts.png" width="820">
</div>

**Analytics** is combined token throughput across all accounts and both
providers, with the ≈ cost of that usage at API list rates. Tokens are metered
as responses stream by, never buffered, so every number is cross-checkable
against your clients' own session logs. Press `m` for the full pricing
breakdown per model.

<div align="center">
<img alt="combined token throughput and API-list-price cost across all accounts" src="media/analytics.png" width="820">
</div>

**Settings** holds the master on/off per provider, then auto-rotation, the
switch threshold, and cooldown, applied live.

<div align="center">
<img alt="routing, auto-rotation, threshold, and cooldown, tuned per provider" src="media/settings.png" width="820">
</div>

## Auto-rotation

Turn it on and tokenmaxx switches accounts when the active one's fullest
window crosses your threshold, moving to the account with the most headroom.
The default 90% keeps the last stretch of each window in reserve for you
instead of spending it automatically. If an account hits its hard limit
mid-request, the proxy retries that request on the next eligible account. Off
by default; enabling it is your confirmation that your provider permits this
use.

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
- **For the official apps.** The subscription login belongs in Claude Code and
  Codex. For custom clients, harnesses, or anything else speaking the API, use
  a provider-issued API key instead.

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

## Intended use

tokenmaxx is one person switching between accounts they personally own and
pay for, through the official Claude Code and Codex apps. It changes which
account is signed in, never the limits attached to any of them. Don't share
accounts or credentials, and don't pool or resell subscription usage. The
software is provided as is, without warranty of any kind.

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
