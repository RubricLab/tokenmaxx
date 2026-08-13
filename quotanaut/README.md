# Quotanaut

Quotanaut is a Linux-first Codex account switcher. The name combines quota
with astronaut.

It selects a managed credential for each Codex request. Manual and automatic
account changes therefore apply to the next request without a Codex restart.
When an account hits a hard limit before response streaming starts, Quotanaut
can retry the request once with another account that has room.

Quotanaut v1 supports Codex only. Claude support is deferred to v2.

## Requirements

- Linux
- [Bun](https://bun.sh/) 1.2 or newer
- [Codex CLI](https://developers.openai.com/codex/cli/)

## Install from source

```bash
bun install
bun run build
bun add -g .
```

Register an account and route Codex through Quotanaut:

```bash
quotanaut login
quotanaut install
```

You can also import one or more existing Codex file credentials without
changing their source files or installing the proxy route:

```bash
quotanaut import ~/.codex/auth.json /path/to/another/auth.json
```

Import files must be regular files owned by the current user. They must not
grant permissions to group or other users.

Quotanaut commits imports one account at a time and reports each successful
account immediately. If a later account fails, rerun the same command.
Quotanaut updates the accounts that already succeeded without creating
duplicates.

After an import, Quotanaut refreshes account usage so the new accounts can take
part in automatic switching. A refresh failure does not remove a successful
import. If Quotanaut reports a refresh warning, run `quotanaut refresh` before
you run `quotanaut auto on`.

Continue to run `codex` normally. Quotanaut binds its proxy to
`127.0.0.1:8460` by default.

## Commands

```text
quotanaut login
quotanaut import <auth.json>...
quotanaut switch <email-or-id>
quotanaut logout <email-or-id>
quotanaut auto <on|off> [--threshold N]
quotanaut install
quotanaut uninstall
quotanaut list
quotanaut status
quotanaut refresh
quotanaut doctor
quotanaut daemon <start|stop|status>
```

Use `QUOTANAUT_HOME` to change the state directory. The default is
`~/.quotanaut`. Use `QUOTANAUT_PROXY_PORT` to change the proxy port.

## Credential storage

Quotanaut stores credentials as plaintext files under
`~/.quotanaut/credentials`. The directory uses mode `0700`. Each credential
file uses mode `0600`. Treat the state directory as password-sensitive. Protect
the user account, disk, backups, and any process that can read files as that
user.

Quotanaut rejects credential paths that are symbolic links, non-regular files,
owned by another user, or have unsafe permissions. It does not fall back to a
different credential backend.

The Codex provider config contains a random bearer capability. Quotanaut uses
that capability to keep unrelated local processes from sending requests
through the proxy by accident. The proxy listens only on loopback.

## Intended use

Use Quotanaut only with accounts that you own and may use this way. It does not
increase an account's limits. Check the current OpenAI terms for your accounts.
The software is provided as is, with no warranty.

## Origin and license

Quotanaut is derived from
[TokenMaxx](https://github.com/RubricLab/tokenmaxx) at commit
`d57bb668079d284f1e30976dc52b75c9fb59c99a`. TokenMaxx was created by Rubric
Labs contributors. See [LICENSE](LICENSE) for the original license notice.
