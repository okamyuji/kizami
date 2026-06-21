## [0.5.0](https://github.com/okamyuji/kizami/compare/v0.4.6...v0.5.0) (2026-06-21)

### Features

- add checkpoint identity and part builder ([73e77d2](https://github.com/okamyuji/kizami/commit/73e77d2eb19f769eebb1f6e6bcdff6ae23ca66da))
- add Claude, Codex, and Kimi runtime adapters ([cf5392d](https://github.com/okamyuji/kizami/commit/cf5392d333b89b7008834ef74f0553b5e3057378))
- add lifecycle hook ownership classifier ([55abe19](https://github.com/okamyuji/kizami/commit/55abe19cd9caffff1347e111023c7637a5383275))
- append JSONL transactions crash safely ([6c070be](https://github.com/okamyuji/kizami/commit/6c070beee0b8d7e9499522673aa63f05c341f21d))
- coordinate resumable turn checkpoints ([79a3424](https://github.com/okamyuji/kizami/commit/79a342420eb6ad1923603e385adbc771f3f62fb2))
- define JSONL v2 transactions ([b7e4de5](https://github.com/okamyuji/kizami/commit/b7e4de58a1112988d55dc803d00553e42a46018a))
- fold canonical checkpoint history ([3b514e2](https://github.com/okamyuji/kizami/commit/3b514e2dcf47cf86604b894865a44e79ac7e2245))
- materialize checkpoint revisions ([e147c00](https://github.com/okamyuji/kizami/commit/e147c00d2e64df7cc941a1a8aeb22f3f72606106))
- migrate checkpoint cache to schema v4 ([33b44f8](https://github.com/okamyuji/kizami/commit/33b44f89e7d9556ae73a54c83dd271f53c0dbd6e))
- persist checkpoint state atomically ([8bffa6e](https://github.com/okamyuji/kizami/commit/8bffa6ed2205a665bc3184f5cdf2994b6dc78438))
- wire service dispatch, fix lint, update dependencies ([210a351](https://github.com/okamyuji/kizami/commit/210a3518d318bcbc62c7fdbe1449005e2e934ee8))

### Bug Fixes

- address all CodeRabbit review findings ([a838a62](https://github.com/okamyuji/kizami/commit/a838a6290daca2777b81700ffbb8796b2c3bf682))
- address remaining nitpick findings from CodeRabbit review ([d8dd6a3](https://github.com/okamyuji/kizami/commit/d8dd6a3650a9b9098e6c8360ebac3af853060034))
- resolve lint errors and flaky SIGINT test timing ([65ce41d](https://github.com/okamyuji/kizami/commit/65ce41dd98717591568c7f7a2937931bdff0124a))

## [0.4.6](https://github.com/okamyuji/kizami/compare/v0.4.5...v0.4.6) (2026-06-21)

### Bug Fixes

- **engines:** widen node constraint from exact pin to range ([c7e0c31](https://github.com/okamyuji/kizami/commit/c7e0c31c2ffdec15bf41b4346354f1a009670db2))

## [0.4.5](https://github.com/okamyuji/kizami/compare/v0.4.4...v0.4.5) (2026-06-15)

### Bug Fixes

- **deps:** resolve Dependabot security alerts for esbuild ([51b8877](https://github.com/okamyuji/kizami/commit/51b8877a771657fa47ddf2de39e27e4ca22e3165))

## [0.4.4](https://github.com/okamyuji/kizami/compare/v0.4.3...v0.4.4) (2026-06-08)

### Bug Fixes

- kimi-code UserPromptSubmitのpromptが配列形式に対応 ([6fc60c6](https://github.com/okamyuji/kizami/commit/6fc60c6a447fdce4fbcd683b44342bfdda769e58))

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
