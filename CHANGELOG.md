## [0.4.3](https://github.com/okamyuji/kizami/compare/v0.4.2...v0.4.3) (2026-06-08)

### Bug Fixes

- TOML command文字列にダブルクォートが含まれる場合にリテラル文字列を使用 ([ae37b4c](https://github.com/okamyuji/kizami/commit/ae37b4cae86cca67c6ff1b8403eb5e2b1c879330))

## [0.4.2](https://github.com/okamyuji/kizami/compare/v0.4.1...v0.4.2) (2026-06-08)

### Bug Fixes

- CodeRabbit指摘4件を修正 ([0333b8e](https://github.com/okamyuji/kizami/commit/0333b8e1e5d2a79fa0b6b99b32a350fffa7b493c))
- kimi-code save機能を実装(pending file + wire.jsonl抽出) ([97638ce](https://github.com/okamyuji/kizami/commit/97638ce5d852c137b5fb2aad85590e08f48d44c8))

## [0.4.1](https://github.com/okamyuji/kizami/compare/v0.4.0...v0.4.1) (2026-06-08)

### Bug Fixes

- kimi-code (Moonshot AI) ランタイム対応 Phase 1 ([66da63a](https://github.com/okamyuji/kizami/commit/66da63a3791a4e3f2115f485c1331e0b4731fc2a))
- kimiランタイムのstatus/uninstallで--scope省略時に両スコープを走査 ([e795678](https://github.com/okamyuji/kizami/commit/e795678b437dcb88a947fa19b855183b70ab1b41))

## [0.4.0](https://github.com/okamyuji/kizami/compare/v0.3.1...v0.4.0) (2026-06-06)

### Features

- 'SessionStart'イベント時の出力形式をJSONに変更 ([c5aa615](https://github.com/okamyuji/kizami/commit/c5aa6155a53fdedf65b023d384eb192776b96cf0))

## [0.3.1](https://github.com/okamyuji/kizami/compare/v0.3.0...v0.3.1) (2026-06-06)

### Bug Fixes

- **deps:** vitest 3.2.4→4.1.7でCritical脆弱性(GHSA-5xrq-8626-4rwp)を修正 ([3a0d685](https://github.com/okamyuji/kizami/commit/3a0d6852ee622ea0ac4b790669676b2e8b686506)), closes [#14](https://github.com/okamyuji/kizami/issues/14)

## [0.3.0](https://github.com/okamyuji/kizami/compare/v0.2.2...v0.3.0) (2026-06-06)

### Features

- codex対応 ([c94afa1](https://github.com/okamyuji/kizami/commit/c94afa1051a7fa341e2b7d00b68f303f28297152))

### Bug Fixes

- CodeRabbit指摘の安全性・堅牢性改善 ([04e9853](https://github.com/okamyuji/kizami/commit/04e9853b894efbf647f3884d97d9806a4fdbc5ab))

## [0.2.2](https://github.com/okamyuji/kizami/compare/v0.2.1...v0.2.2) (2026-06-01)

### Performance Improvements

- reduce memory injection tokens ([04f0a4d](https://github.com/okamyuji/kizami/commit/04f0a4dbd79199cb57eed8b66a4507b48854dd36))

## [0.2.1](https://github.com/okamyuji/kizami/compare/v0.2.0...v0.2.1) (2026-05-21)

### Bug Fixes

- **jsonl:** load sqlite-vec before truncateAll to avoid "no such module: vec0" ([9589925](https://github.com/okamyuji/kizami/commit/9589925c5d7a087d5d0a5da11409cd07fd1bd0ac))

## [0.2.0](https://github.com/okamyuji/kizami/compare/v0.1.2...v0.2.0) (2026-05-20)

### Features

- **embedding:** default HF_HUB_OFFLINE for fully local mode ([f0cc367](https://github.com/okamyuji/kizami/commit/f0cc367f56a50d1884bd987beb153a2a4c3e1f22))
- **hooks:** add SessionStart inject hook for project bootstrap context ([bedc4cd](https://github.com/okamyuji/kizami/commit/bedc4cdd3905aae52bc656b86e5b34a7b8051a2f))
- **jsonl:** introduce JSONL canonical store, rebuild, and migrate (v0.2.0) ([543d785](https://github.com/okamyuji/kizami/commit/543d7858d958f2f67b2d9d97205dd377c4f88c3c))

## [0.1.2](https://github.com/okamyuji/kizami/compare/v0.1.1...v0.1.2) (2026-05-15)

### Bug Fixes

- **deps:** bump protobufjs/postcss to patched ranges for security alerts ([7083539](https://github.com/okamyuji/kizami/commit/70835390212c693776cea6a5740ee7496450c243))
