# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-11-13

### Changed

- Releases are published through npm trusted publishing (OIDC) instead of an npm token, so there is no long-lived token that could leak and publish a malicious version.

## [0.1.0] - 2026-11-13

### Added

- `createSubscriber(connection, options)`, a Postgres LISTEN/NOTIFY subscriber for `pg` 8.7+ on its own dedicated connection, with pg-listen's API (`events`, `notifications`, `connect`, `close`, `listenTo`, `unlisten`, `unlistenAll`, `notify`, `getSubscribedChannels`) and options, so moving from pg-listen is an import change.
- Reconnects after the connection drops, with exponential backoff (250 ms doubling up to 2 s) and no retry limit by default, and runs LISTEN again for every channel before it reports `connected`.
- A `missed` event after every reconnect, with the channels and the time the connection was down, so the app can re-sync whatever was sent while nobody was listening, since Postgres does not keep notifications.
- Health checks with a timeout (`paranoidCheckTimeout`), so a half-open connection that never answers counts as lost and is replaced.
- `connect()` retries until the server accepts connections, and fails fast on errors retrying cannot fix, such as a wrong password or a missing database.
- `close()` stops a reconnect loop, a pending connection attempt and health checks, and does not hang on a dead connection.
- `notify(channel, payload)` sends the payload as a bind parameter of `pg_notify`, and LISTEN/UNLISTEN always quote the channel name, which is checked for length and NUL characters first.
- Typed channels and payloads through a generic channel map, and a `parseError` event for payloads that are not valid JSON instead of the fatal `error` event.
- ESM and CommonJS builds, each with its own types.

[Unreleased]: https://github.com/RagedPanda/pg-listen-reconnect/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/RagedPanda/pg-listen-reconnect/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/RagedPanda/pg-listen-reconnect/releases/tag/v0.1.0
