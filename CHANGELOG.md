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

