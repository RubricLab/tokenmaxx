- [2026-07-17] [content-fit account panels; calmer demo fixture (codex 7d, claude 5h+fable)](https://github.com/RubricLab/tokenmaxx/commit/90f68e234e843e80130856235efbb959b2ac0251)
- [2026-07-17] [routing as a loud on/off on accounts; clearer metrics + settings; aligned resets](https://github.com/RubricLab/tokenmaxx/commit/28539c21d8eb42b5dc79f767cc9c9dda9b15bed2)
- [2026-07-17] [cap account rows to the content width so wide terminals don't wrap](https://github.com/RubricLab/tokenmaxx/commit/09fe360558968c95db3c33f8ff9ac74a5988a67e)
- [2026-07-17] [never strand on daemon restart: shutdown watchdog + force-kill fallback](https://github.com/RubricLab/tokenmaxx/commit/108b5a366f4df3b4b4e9954abcdc54d1e62b746b)
- [2026-07-17] [stagger blitz depletion so codex and claude run out on distinct clocks](https://github.com/RubricLab/tokenmaxx/commit/707f259b426ad37f2ea1fb9f48cda9df388df61d)
- [2026-07-17] [breathing room in the metrics columns](https://github.com/RubricLab/tokenmaxx/commit/a41e12b13137569356160cda6d9f35e035b2522b)
- [2026-07-17] [exact dollar values in the metrics table](https://github.com/RubricLab/tokenmaxx/commit/2d0e789c1bc8ddf9cb36308e9d2e03f50bee370f)
- [2026-07-17] [responsive centered dashboard: inline resets, pricing metrics, in-ui onboarding](https://github.com/RubricLab/tokenmaxx/commit/1d3feadc7be6021425131ed123c257bce83b580b)
- [2026-07-17] [fix stale relogin command in error hints](https://github.com/RubricLab/tokenmaxx/commit/6410fdb1c0bf03e3c7fe906176e97cff559ae5c6)
- [2026-07-17] [run under any package manager via a bun-locating launcher](https://github.com/RubricLab/tokenmaxx/commit/0beb61a97cee44a780eeeaae46b0ce598fa19531)
- [2026-07-17] [view modes, switch flash, update prompt, fewer probes](https://github.com/RubricLab/tokenmaxx/commit/2d4a9507b04d4e167b863cf3f4f2dcd5778b27f4)
- [2026-07-17] [version-aware daemon, update notice, wider labels, blitz fixture](https://github.com/RubricLab/tokenmaxx/commit/01bab2e6760ff74f92fb5d34e63949c7a690db78)
- [2026-07-17] [version-aware daemon, update notice, wider labels, blitz fixture](https://github.com/RubricLab/tokenmaxx/commit/6cacce71b04ff308e9ce235ac6d5a3a4d897fde6)
- [2026-07-17] [version-aware daemon, update notice, wider labels, blitz fixture](https://github.com/RubricLab/tokenmaxx/commit/f0972d14ad7ea685ea00e0aebac2e29e3f9757a0)
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
  and timestamp daemon log lines](https://github.com/RubricLab/tokenmaxx/commit/b283d1ea48fcf358375f91f7a39a7fdec28754e4)
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
  and timestamp daemon log lines](https://github.com/RubricLab/tokenmaxx/commit/ce7f2d16591c2a3698d0609d3d16966b2473b300)
- [2026-07-15] [docs: restore the flaked analytics screenshot](https://github.com/RubricLab/tokenmaxx/commit/68ebb3cf1abac88bae5f7718d22870814bd2a44e)
- [2026-07-15] [feat: cache-aware token metering and a polished analytics dashboard](https://github.com/RubricLab/tokenmaxx/commit/271094ba01447ced0e3423d4d5356744d4545c92)
- [2026-07-15] [chore: redirect tokenmaxx.sh to the repo](https://github.com/RubricLab/tokenmaxx/commit/07f247f2add6c743a81e80be5e55bc5253f132b6)
- [2026-07-15] [docs: simplify the install line](https://github.com/RubricLab/tokenmaxx/commit/45fd2aa0ffdf991976969a3108f260954bae1d31)
- [2026-07-15] [chore: adopt the rubric package conventions](https://github.com/RubricLab/tokenmaxx/commit/465dfeb5879bd4bbdf6e7e455e13c81b2f5d3715)
# Changelog

