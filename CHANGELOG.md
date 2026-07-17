- [2026-07-17] exit when the terminal goes away, fixes #2
- [2026-07-17] [update rubriclab package](https://github.com/RubricLab/tokenmaxx/commit/6fbdedfde9cb80257a9ce7085747f93d9f1f421c)
- [2026-07-17] [bring back rubriclab package](https://github.com/RubricLab/tokenmaxx/commit/90884242a1971fd4fa8271e67b02f9a8ff8c51cb)
- [2026-07-17] [flatten providers, strip comments, drop dead code](https://github.com/RubricLab/tokenmaxx/commit/b5aa307b5010159591d713474589bcfd5cce3114)
- [2026-07-17] [drop changelog, architecture doc, vercel redirect](https://github.com/RubricLab/tokenmaxx/commit/6cbdb2659d1d60acbdca8479b837d009e080affd)
- [2026-07-17] [claude refresh in process](https://github.com/RubricLab/tokenmaxx/commit/2e1f340563b7df4fadfaee6cbd5c740ed1ae8f2a)
- [2026-07-17] [the readme is the landing page: real captures only](https://github.com/RubricLab/tokenmaxx/commit/eb418552300b5148f315045862a4b93b3043e607)
- [2026-07-17] [drop the asset factory: fixture renders, remotion, brand generator](https://github.com/RubricLab/tokenmaxx/commit/0492d3ad3a1735b1453ba410af0208ef918a3154)
- [2026-07-17] [routing becomes a plain tokenmaxx on/off in settings

The accounts title is quiet when on (just the auto policy) and shows '✗ off'
warn with a settings pointer when not. Settings gains a master on/off row per
provider — 'tokenmaxx · on/off · run codex through tokenmaxx' — and r is
refresh everywhere. Copy drops the word 'routing' throughout.](https://github.com/RubricLab/tokenmaxx/commit/658630836990996c2cdfefc40e4da0eaeba8024f)
- [2026-07-17] [quiet switches, clearer routing hint, staggered 5h resets

A switch no longer takes over the panel title or paints the border warn — the
new active row's marker briefly reads ⟳ in the same green, and that is the
whole announcement. The footer hint is now 'r routing', matching the panel's
own 'routing on/off' language. In the demo, each 5h window opens when its
account's shift starts, so reset countdowns stagger by rotation: hot rows count
down on their own clocks, refresh, and drop to the bottom of the board.](https://github.com/RubricLab/tokenmaxx/commit/8b5096e71ba586be3881dead4b790010d2bc4b26)
- [2026-07-17] [sort account rows by pressure, not active-first

A switch now just moves the ● marker to another row instead of reshuffling the
panel; rows trade places only when their pressures actually cross.](https://github.com/RubricLab/tokenmaxx/commit/865449c8078104c634aed19e260f30e56fa4463e)
- [2026-07-17] [blitz meters burn only while active; switches fire exactly at the 90% threshold

Codex is now a strict threshold relay: one account holds the baton, its 7-day
meter climbs, and the handoff happens at exactly 90% — idle meters never move.
Claude's Fable weekly likewise accrues only during its account's active shifts.
Handoff times stay mid-way between the other provider's, so the two never flash
'switched' together.](https://github.com/RubricLab/tokenmaxx/commit/6429c63e28bf71937f210cb565a7d6d8d08b03a3)
- [2026-07-17] [drop the accounts view toggle — settings now controls window visibility](https://github.com/RubricLab/tokenmaxx/commit/61e65d6b10088b15aa535222e6117ec8d0c66fdf)
- [2026-07-17] [align the per-class cost row under its columns](https://github.com/RubricLab/tokenmaxx/commit/e5c77bb5318f60553a46f66d63ff4d0ed0ec88fc)
- [2026-07-17] [auto-enable routing when the first account is added](https://github.com/RubricLab/tokenmaxx/commit/68b514c09a5f20bdb4f67377f8302c25548030e5)
- [2026-07-17] [compact tier shows two window columns](https://github.com/RubricLab/tokenmaxx/commit/1f5f286743955b32f8d1629d642041ee8ecb7c0f)
- [2026-07-17] [content-fit account panels; calmer demo fixture (codex 7d, claude 5h+fable)](https://github.com/RubricLab/tokenmaxx/commit/8907027c93923ca9fd78386201875345f29a02a9)
- [2026-07-17] [routing as a loud on/off on accounts; clearer metrics + settings; aligned resets](https://github.com/RubricLab/tokenmaxx/commit/46b8642aff52fbf86152e20f5b289be6579f974f)
- [2026-07-17] [cap account rows to the content width so wide terminals don't wrap](https://github.com/RubricLab/tokenmaxx/commit/d46f98b98547abb80a7edc65417fda3417c35bd2)
- [2026-07-17] [never strand on daemon restart: shutdown watchdog + force-kill fallback](https://github.com/RubricLab/tokenmaxx/commit/0b58f04adcec0c5e4630c6505b099d29d3109f20)
- [2026-07-17] [stagger blitz depletion so codex and claude run out on distinct clocks](https://github.com/RubricLab/tokenmaxx/commit/022a78073a2782fdc75d9a6ec2410434f13b3b2d)
- [2026-07-17] [breathing room in the metrics columns](https://github.com/RubricLab/tokenmaxx/commit/6c862cca3750fb107e29302595bf1ef334317f0d)
- [2026-07-17] [exact dollar values in the metrics table](https://github.com/RubricLab/tokenmaxx/commit/df5716481c32bc5fb4c1e1050874cfb8961b7577)
- [2026-07-17] [responsive centered dashboard: inline resets, pricing metrics, in-ui onboarding](https://github.com/RubricLab/tokenmaxx/commit/6b769c593ee4f9a02cea782a0f49b6cd679f8c7b)
- [2026-07-17] [fix stale relogin command in error hints](https://github.com/RubricLab/tokenmaxx/commit/2845f3047c0fe20e11cbb35dbaeb0a36c67c4f2d)
- [2026-07-17] [run under any package manager via a bun-locating launcher](https://github.com/RubricLab/tokenmaxx/commit/05ff0720f3c1fee453a2fc1693271a6bba4496df)
- [2026-07-17] [view modes, switch flash, update prompt, fewer probes](https://github.com/RubricLab/tokenmaxx/commit/3d10711dfbd7a7cf6c521da10944fd0d1c184743)
- [2026-07-17] [version-aware daemon, update notice, wider labels, blitz fixture](https://github.com/RubricLab/tokenmaxx/commit/146fa7cd97c2e434bf9278ff1721e061b9e5c2c1)
- [2026-07-17] [version-aware daemon, update notice, wider labels, blitz fixture](https://github.com/RubricLab/tokenmaxx/commit/146fa7cd97c2e434bf9278ff1721e061b9e5c2c1)
- [2026-07-17] [version-aware daemon, update notice, wider labels, blitz fixture](https://github.com/RubricLab/tokenmaxx/commit/146fa7cd97c2e434bf9278ff1721e061b9e5c2c1)
- [2026-07-16] [style: give the analytics metrics hierarchy and alignment

The block under the chart was five ragged rows fighting for attention.
Now it reads in layers: a hero row (total tokens, API value, live rate),
one dim line of rates, one faint line of composition, then an aligned
per-model table with provider tags and right-flushed numbers. The
redundant provider-totals row is gone; the model table carries it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>](https://github.com/RubricLab/tokenmaxx/commit/9d96f1669f312ec27bc91411aab88bc0320c4d62)
- [2026-07-16] [feat: reactive rate-limit switching, verified metering, and a settings tab

- read live rate-limit state off every proxied response (anthropic
  unified headers, x-codex-*) so the active account's pressure is
  per-request fresh; threshold crossings rotate immediately instead of
  waiting for the 60s poll, and a 429 rotates then retries the failed
  request on the next account before the client sees it
- hard limits bypass the minimum-dwell hold, candidate staleness now
  admits the 5-minute probe cadence, and the default threshold drops to
  90% (stored default policies migrate)
- fix codex routing: the managed model_provider key is written at the
  top of config.toml so TOML keeps it top-level (a block appended after
  a [table] was silently swallowed and codex bypassed the proxy);
  provider gains requires_openai_auth, and isInstalled/doctor verify
  routing semantically instead of string-matching
- fix codex metering: detect SSE by content (the ChatGPT backend sends
  no content-type), parse non-streaming bodies as fallback, track cache
  creation separately from input, and attribute events to the account
  that actually served each response
- correct API list prices (fable 10/50, opus 4.5+ 5/25, haiku 1/5,
  dated opus 4.0/4.1 kept at 15/75) and price cache writes at 1.25x;
  metering verified token-for-token against codex rollout files and
  claude transcripts
- analytics: trailing-5-minute now rate, per-model token/cost table,
  input/output/cache-read/cache-write split, honest freshness header
- new settings tab: per-provider auto-rotate, switch threshold, and
  dwell, applied live over the existing policy IPC
- drop the 3x consensus probe sampling (headers made it redundant) and
  the reader-less usage-history subsystem
- fixture screenplay support: scenarios as functions of an accelerated
  clock (TOKENMAXX_TIMEWARP) for deterministic demos
- test suite for the usage observer, rate-limit headers, rotation
  selection, pricing, and the TOML install path

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>](https://github.com/RubricLab/tokenmaxx/commit/2ad9215d0e3a0cb349906c492ff25169c9defbb0)
- [2026-07-16] [fix: honest proxy errors, serialized claude refresh, network-aware health

- pass upstream API errors through untouched; proxy-generated failures now
  return provider-shaped JSON naming the unreachable host, the underlying
  cause, and an x-tokenmaxx-error header so they can't be mistaken for
  Anthropic/OpenAI errors
- preserve the original 401 body when the refresh-and-retry path fails
  (previously replayed a cancelled stream)
- serialize claude credential refreshes per profile and reuse a concurrent
  refresh's result, so parallel requests can't race the single-use refresh
  token into a 400
- restore the pre-refresh credential when a failed `claude auth login`
  leaves the keychain holding empty tokens
- classify network failures during login/refresh as unreachable instead of
  reauthentication-required, so an outage no longer flips accounts to
  "login" at random
- cool re-auth probes down for 15 minutes instead of retrying every 60s,
  and timestamp daemon log lines](https://github.com/RubricLab/tokenmaxx/commit/924e3c525d7f0224b7c11a33ff2d83d8bb94c71d)
- [2026-07-16] [fix: honest proxy errors, serialized claude refresh, network-aware health

- pass upstream API errors through untouched; proxy-generated failures now
  return provider-shaped JSON naming the unreachable host, the underlying
  cause, and an x-tokenmaxx-error header so they can't be mistaken for
  Anthropic/OpenAI errors
- preserve the original 401 body when the refresh-and-retry path fails
  (previously replayed a cancelled stream)
- serialize claude credential refreshes per profile and reuse a concurrent
  refresh's result, so parallel requests can't race the single-use refresh
  token into a 400
- restore the pre-refresh credential when a failed `claude auth login`
  leaves the keychain holding empty tokens
- classify network failures during login/refresh as unreachable instead of
  reauthentication-required, so an outage no longer flips accounts to
  "login" at random
- cool re-auth probes down for 15 minutes instead of retrying every 60s,
  and timestamp daemon log lines](https://github.com/RubricLab/tokenmaxx/commit/924e3c525d7f0224b7c11a33ff2d83d8bb94c71d)
- [2026-07-15] [docs: restore the flaked analytics screenshot](https://github.com/RubricLab/tokenmaxx/commit/dc0dc7c5dc947cf421ef9445116c6e348117c48c)
- [2026-07-15] [feat: cache-aware token metering and a polished analytics dashboard](https://github.com/RubricLab/tokenmaxx/commit/0a88f7b17a4174d21ed795837a7876e687dc3d5c)
- [2026-07-15] [chore: redirect tokenmaxx.sh to the repo](https://github.com/RubricLab/tokenmaxx/commit/c02bbd94c96eb00a1007dac28aec805ff90a814a)
- [2026-07-15] [docs: simplify the install line](https://github.com/RubricLab/tokenmaxx/commit/2176f13ad1f4506d9440365d76d4391e8250c28d)
- [2026-07-15] [chore: adopt the rubric package conventions](https://github.com/RubricLab/tokenmaxx/commit/f7cea41d2ad0c6e90ac8ee01fffb3a28652afb60)
# Changelog

