# SemVer 自動採番とリリース自動化 設計

- 作成日: 2026-05-13
- 対象ブランチ: `feat/semver-auto-release`
- 目的: `kizami` の配布物に Semantic Versioning に従ったバージョンを CI が自動採番し、ビルド成果物 (`dist/cli.js`) と GitHub Release / Git タグに反映させる。

## 1. 要件整理

- バージョニング方式は [SemVer 2.0.0](https://semver.org/lang/ja/) に従う。
  - 破壊的変更 → MAJOR
  - 後方互換のある機能追加 → MINOR
  - 後方互換のあるバグ修正 → PATCH
- 採番のトリガーは [Conventional Commits 1.0.0](https://www.conventionalcommits.org/ja/v1.0.0/) に基づく。
  - `feat:` → MINOR
  - `fix:` / `perf:` → PATCH
  - `BREAKING CHANGE:` フッター, または `feat!:` / `fix!:` → MAJOR
  - `chore` / `docs` / `refactor` / `style` / `test` / `ci` / `build` → リリース対象外 (採番しない)
- CI で `main` ブランチに push されたタイミングで自動的にバージョン採番・タグ付け・GitHub Release を行う。
- `kizami --version` で現在のバージョンが確認できる。
- npm publish はしない (公開パッケージではないため)。

## 2. ツール選定

候補比較:

| ツール | 採番方式 | 採点 |
| --- | --- | --- |
| **semantic-release** | コミット解析で完全自動 | ◎ 単一パッケージ・完全自動の要件に合致 |
| release-please | PR ベース、レビュー後マージで反映 | ○ 制御性は高いが「ビルド毎に自動採番」と合いにくい |
| changesets | コントリビューターが `.changeset/*.md` を手動追加 | △ 手作業が必須で要件に合わない |

**結論**: `semantic-release` を採用する。要件「CI で自動的にバージョンを上げる」に最も合致し、Conventional Commits を入力としてバージョン決定〜タグ付け〜Release ノート生成までを完結できる。

参考:
- <https://semver.org/lang/ja/>
- <https://www.conventionalcommits.org/ja/v1.0.0/>
- <https://semantic-release.gitbook.io/semantic-release/>

## 3. バージョンの埋め込み

### 3.1 ビルド時注入

Vite の `define` を使い、`package.json` の `version` フィールドを `__APP_VERSION__` という定数として注入する。

- `vite.config.ts` 内で `package.json` を読み込み `define: { __APP_VERSION__: JSON.stringify(pkg.version) }` を設定。
- `src/version.ts` に `declare const __APP_VERSION__: string; export const VERSION = __APP_VERSION__;` を置く。
- 開発時 (`vitest` などビルドを介さない経路) のために `vite.config.ts` の `define` だけでなく、`src/version.ts` 側で `typeof __APP_VERSION__ === 'undefined'` のフォールバックを持たせる。
  - フォールバックは「`process.cwd()` から `package.json` を読む」ではなく、`'0.0.0-dev'` 固定とする。実体は CI のビルド成果物にだけ正しい値が入る。

### 3.2 CLI への露出

`src/cli.ts` の `parseArgs` のオプションに `version` (short: `v`) を追加し、ヒット時は `VERSION` を出力して `process.exit(0)`。

## 4. リリースフロー (CI)

```
push to main
  └─ CI ワークフロー
       1. checkout (fetch-depth: 0, tags 込み)
       2. setup-pnpm, setup-node (24.13.0)
       3. pnpm install --frozen-lockfile
       4. pnpm check                         # typecheck/lint/format/test/build
       5. pnpm semantic-release              # 必要なら採番してリリース
            - 直近タグ以降のコミットを解析
            - 新バージョン X.Y.Z を決定
            - @semantic-release/npm が package.json の version を書き換え (publish はしない)
            - prepareCmd で pnpm build を実行 (新 version が __APP_VERSION__ に埋め込まれる)
            - @semantic-release/git が package.json と CHANGELOG.md をコミット & push (chore(release): x.y.z [skip ci])
            - git tag vX.Y.Z を push
            - GitHub Release を作成し dist/cli.js を assets として添付
```

**注**: ステップ 4 の `pnpm build` 時点では `package.json` のバージョンは古いので、`@semantic-release/npm` で version を書き換えてから `@semantic-release/exec` の `prepareCmd` で再ビルドする。

### 4.1 PR / フィーチャーブランチ

別ワークフロー `ci.yml` で push/PR 時に `pnpm check` を実行 (リリースはしない)。これによりリリース手前で品質を担保する。

### 4.2 コミット規約の検証

PR で `commitlint` を実行し、Conventional Commits 準拠かをチェックする。ローカルでは強制しない (Husky を強制しない方針) が、CI で必ず検出する。

## 5. プラグイン構成 (`.releaserc.json`)

| プラグイン | 役割 |
| --- | --- |
| `@semantic-release/commit-analyzer` | コミットからバンプ種別を決定 |
| `@semantic-release/release-notes-generator` | リリースノート生成 |
| `@semantic-release/changelog` | `CHANGELOG.md` 更新 |
| `@semantic-release/npm` | `package.json` の version を新バージョンに書き換える (`npmPublish: false` で publish はしない) |
| `@semantic-release/exec` | version 書き換え後にビルドを再実行 (`pnpm build`) し、新 version を `__APP_VERSION__` に埋め込む |
| `@semantic-release/git` | 書き換え後の `package.json` と `CHANGELOG.md` をコミット & push |
| `@semantic-release/github` | GitHub Release 作成 + `dist/cli.js` 添付 |

`@semantic-release/npm` は publish はしない (`npmPublish: false`)。あくまで `package.json` の version 更新のためにのみ使用する。

`branches`: `["main"]`。

## 6. ファイル変更一覧

| ファイル | 種別 | 内容 |
| --- | --- | --- |
| `vite.config.ts` | 変更 | `define: { __APP_VERSION__: ... }` を追加 |
| `src/version.ts` | 新規 | `VERSION` 定数のエクスポート |
| `src/cli.ts` | 変更 | `--version` オプションを追加 |
| `package.json` | 変更 | `devDependencies` に semantic-release 一式と commitlint を追加 |
| `.releaserc.json` | 新規 | semantic-release 設定 |
| `commitlint.config.js` | 新規 | `@commitlint/config-conventional` を継承 |
| `.github/workflows/ci.yml` | 新規 | PR/push の検証 |
| `.github/workflows/release.yml` | 新規 | main push でリリース |
| `tsconfig.json` | 変更 | `__APP_VERSION__` をアンビエント宣言として認識 (`src/version.ts` 内で `declare`) |
| `README.md` | 変更 | 「バージョニングとリリース」セクションを追記 |
| `docs/superpowers/specs/2026-05-13-semver-auto-release-design.md` | 新規 | 本ドキュメント |

## 7. リスクと対応

- **初回リリース**: タグが無い状態で `semantic-release` を初回起動すると `1.0.0` を提案する。現状 `0.1.0` で配布してきたため、初回タグは手動で `v0.1.0` を打つ運用にする (README に明記)。以後は自動。
- **`[skip ci]` 漏れによる無限ループ**: `semantic-release/git` のコミットメッセージに `[skip ci]` を必ず含める。
- **GitHub Token**: `GITHUB_TOKEN` の `permissions: contents: write` が必要。ワークフロー側で明示。
- **Vite `define` での型エラー**: `src/version.ts` で `declare const __APP_VERSION__: string;` を宣言する。

## 8. 非対応 (Out of scope)

- npm publish
- monorepo 対応 (現状単一パッケージ)
- pre-release チャネル (`alpha`, `beta`)
- ローカルでのコミットメッセージ強制 (Husky)
