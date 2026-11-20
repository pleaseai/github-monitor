# Changelog

## [0.1.4](https://github.com/pleaseai/github-monitor/compare/v0.1.3...v0.1.4) (2026-11-20)


### Bug Fixes

* **client:** replay the whole buffer after a cursorless connection drops before its first frame ([#13](https://github.com/pleaseai/github-monitor/issues/13)) ([a176240](https://github.com/pleaseai/github-monitor/commit/a176240d04d97bb58a50893e198307ab0d1b74ab))
* **relay:** detect storage wipes with a storage epoch ([#12](https://github.com/pleaseai/github-monitor/issues/12)) ([c338556](https://github.com/pleaseai/github-monitor/commit/c33855676476ae57b90bffd49e69ef1c5669348c))
* **relay:** drop redelivered webhooks by delivery GUID ([#11](https://github.com/pleaseai/github-monitor/issues/11)) ([3902635](https://github.com/pleaseai/github-monitor/commit/39026357b53ee136a95376b7e9f36c9e95992d48))
* **relay:** report buffer-trimmed seqs on reconnect replay ([#9](https://github.com/pleaseai/github-monitor/issues/9)) ([f1d63af](https://github.com/pleaseai/github-monitor/commit/f1d63aff1797cadeb91e4c0069e010622a01a5f3))
* send the relay epoch on the WebSocket handshake ([#15](https://github.com/pleaseai/github-monitor/issues/15)) ([4c1e779](https://github.com/pleaseai/github-monitor/commit/4c1e7793eddd19ab8bc51a193101e25ece97313c))

## [0.1.3](https://github.com/pleaseai/github-monitor/compare/v0.1.2...v0.1.3) (2026-07-02)


### Documentation

* **worker:** update README for the standalone pleaseai/github-monitor repo ([0a12af6](https://github.com/pleaseai/github-monitor/commit/0a12af6d7f5d71a66cf1c9df6d1826a8dabf4949))

## [0.1.2](https://github.com/pleaseai/github-monitor/compare/v0.1.1...v0.1.2) (2026-07-02)


### Features

* **npm:** distribute the channel binary via npm (esbuild copy-over) ([7216991](https://github.com/pleaseai/github-monitor/commit/721699169de568675c95adca4033824d7f3c7064))

## [0.1.1](https://github.com/pleaseai/github-monitor/compare/v0.1.0...v0.1.1) (2026-07-02)


### Bug Fixes

* build on windows (gate SIGTERM handler behind cfg(unix)) ([d8426ed](https://github.com/pleaseai/github-monitor/commit/d8426ed906d529ef3c0d0f688375abf7837d17dc))

## 0.1.0 (2026-07-02)


### Features

* github-monitor channel server and github-relay worker ([cc9e8dc](https://github.com/pleaseai/github-monitor/commit/cc9e8dc36c5b225337403cc4322d5fc08d9343e3))
