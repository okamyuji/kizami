# JSONL正本化 + SessionStart注入 + HF_HUB_OFFLINEデフォルト化 設計書

- **作成日**: 2026-05-21
- **作成者**: kizami maintainers
- **対象バージョン**: 0.2.0 (破壊的変更を伴う)
- **対象範囲**: `src/jsonl/*`（新設）, `src/hooks/save.ts`, `src/hooks/setup.ts`, `src/hooks/inject.ts`（新設）, `src/search/embedding.ts`, `src/cli.ts`, `src/config.ts`, CI/pre-commit

---

## 1. 背景と動機

`zenn.dev/sonicgarden/articles/46e9dde3d6a8d2` で示された4つの設計判断のうち、kizami は3つ（FTS5+sqlite-vec/RRF、半減期30日、trigramトークナイザ）を満たしているが、以下3点が未充足:

1. **JSONLを正本、SQLiteをキャッシュとする責務分離**: 現状はSQLite単一ストア
2. **SessionStart hookでの冒頭注入**: 現状はSessionEnd + UserPromptSubmitのみ
3. **HF_HUB_OFFLINEによるテレメトリ遮断の明示**: 環境変数を立てておらず、READMEにも明記なし

これらを単一PRで完結させ、kizami v0.2.0 の柱とする。

---

## 2. ゴールと非ゴール

### ゴール

- JSONL（append-only, 月＋ホスト分割）を**正本**とし、SQLiteを**派生キャッシュ**に再定義する
- `kizami rebuild` でJSONL → SQLite を冪等再生成可能にする
- `kizami migrate-to-jsonl` で既存SQLiteユーザーを移行可能にする
- SessionStart時にプロジェクト直近Q&Aを冒頭注入する `kizami inject` を追加
- 埋め込みパイプライン初期化前に `HF_HUB_OFFLINE=1` をデフォルトでセットする
- pre-commit/CIに gitleaks + 既存品質ゲート（`pnpm check`）を組み込む

### 非ゴール

- 埋め込みモデル変更（Ruri v3-310mへの差し替え）は別PR
- 動的minScoreチューニングは別PR
- JSONLのGit同期ワークフロー自体（ユーザーが各自設定する領域）

---

## 3. アーキテクチャ全体像

```
                            ┌──────────────┐
   Claude Code Session  ──► │ SessionEnd   │ ──► save hook
                            │ Hook         │      │
                            └──────────────┘      ▼
                                                ┌──────────────┐
                                                │ JSONL Writer │ (正本: append-only)
                                                └──────┬───────┘
                                                       │ 同一transaction内で
                                                       ▼
                                                ┌──────────────┐
                                                │ SQLite Store │ (キャッシュ)
                                                └──────────────┘

   Claude Code Session  ──► │ SessionStart │ ──► inject hook ──► プロジェクト直近Q&A
                            │ Hook (NEW)   │
                            └──────────────┘

   User Prompt          ──► │ UserPrompt-  │ ──► recall hook (既存)
                            │ Submit Hook  │
                            └──────────────┘

   $ kizami rebuild         ──► JSONL逐次読込 → SQLite/embedding全再構築（idempotent）
   $ kizami migrate-to-jsonl ──► SQLite → JSONL一方向ダンプ
```

### 3.1 JSONL正本のディスク配置

```
~/.local/share/kizami/
├── memory.db                 # 派生キャッシュ（捨てて再生成可能）
└── jsonl/
    ├── 2026-05-yujiokamoto-mbp.jsonl
    ├── 2026-04-yujiokamoto-mbp.jsonl
    └── ...
```

- ファイル名: `{YYYY}-{MM}-{hostname}.jsonl`
- 月単位 + ホスト単位で分割（multi-machine同期時の衝突最小化）
- ロケーション override: `KIZAMI_JSONL_DIR` 環境変数
- ロケーション上書き: `config.storage.jsonlDir`

### 3.2 JSONL各行のスキーマ

```typescript
interface JsonlRecord {
  v: 1; // schema version
  type: 'chunk'; // 拡張用（将来 'session_meta', 'tombstone' 等）
  id: string; // crypto.randomUUID() (Node 24標準, 依存追加なし)
  sessionId: string;
  projectPath: string;
  chunkIndex: number;
  content: string;
  role: 'human' | 'assistant' | 'mixed';
  metadata: string | null;
  tokenCount: number;
  createdAt: string; // ISO8601 (時系列ソートはこのフィールドで行う)
  embedding?: string; // hex-encoded float32 (hybridモード時のみインライン保存)
  embeddingDim?: number;
  embeddingModel?: string; // モデル変更検知用
}
```

**ID生成は `crypto.randomUUID()` を採用**（Node 20+で標準提供）。ULIDのタイムスタンプソート性は `createdAt` フィールドで代替するため、追加依存は不要。

**embeddingは同一JSONL行にインラインで保存**（レビュー指摘#1を反映）。別ファイル `.emb.jsonl` 案は破棄。理由:

- 2ファイル突合のロジックが不要になり、rebuild が単純になる
- 障害時の整合性検証が「1ファイル単位」で完結する
- hybridモードでない場合は `embedding` フィールドが単に存在しないだけで、後から `kizami embed --backfill` で「新規行として追記」する（既存行を更新せず、tombstone+新規追加にする）

### 3.3 書き込みパス（save hook）— フェイルファスト方針

レビュー指摘#2（§3.3と§8の矛盾）を解消。**JSONL正本主義に統一する**:

1. `parseTranscript` → `buildChunks` （既存）
2. hybridモード時はembedding生成（既存ループ）
3. **JSONL先書き**（fsyncあり）: 全chunkを月JSONLに append
   - **失敗時はSQLite挿入を一切行わず例外伝播**（fail-fast）
   - これにより「SQLiteにあるがJSONLにない」状態を構造的に発生不能にする
4. SQLite挿入（既存）
   - 失敗してもJSONLには記録済みなので、次回起動時のself-healingで自動補完される
5. graceful degradationの「SQLite単独継続」案は採用しない。JSONLが書けない環境はディスク異常であり、その状態でSQLiteのみ書き続けるのは整合性を毀損する

ロールバック: JSONL書き込み後にSQLite挿入で失敗した場合、JSONL末尾の「未反映行」は次回save時のself-healingが SQLite に流し込む。JSONLは追記のみで巻き戻しは行わない。

### 3.4 読み込みパス（rebuild）

```bash
kizami rebuild [--dry-run] [--from-month YYYY-MM]
```

1. SQLite (chunks, chunks_vec, chunks_vec_map, chunks_fts) を `DROP` / 再生成
2. JSONLを月順で逐次読み込み、バルクINSERT
3. `.emb.jsonl` がある場合は hex デコードして `chunks_vec` 復元
4. 完了時に `sessions` テーブルを `chunks` から再構築

### 3.5 self-healing（起動時整合性チェック）

`save` 時に軽量check:

- 当該月JSONLの末尾100行のIDをスキャン
- SQLiteに不在のIDを再注入（JSONL → SQLite方向のみ）
- フェイルファスト方針により逆方向（SQLite→JSONL）は理論上不要だが、`kizami rebuild --verify` で全件チェック可能にする

### 3.6 SessionStart hook (`kizami inject`)

```jsonc
// ~/.claude/settings.json (setup で生成)
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [{ "type": "command", "command": "kizami inject" }],
      },
    ],
  },
}
```

**stdin仕様の実証根拠**: openai-codexプラグイン `/Users/yujiokamoto/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/session-lifecycle-hook.mjs` の `handleSessionStart(input)` が `input.session_id` および `input.cwd` を読み取っている。さらに同ファイルの全 `input.X` アクセスを抽出すると `[cwd, hook_event_name, session_id]` の3フィールドが確認できる。これにより設計前提を実証的に確認済み（レビュー指摘#9を解消）。

- stdin: `{ hook_event_name: 'SessionStart', session_id, cwd }`
- 処理: `cwd` を正規化 → 同プロジェクトの直近 `config.hooks.injectRecentCount`（既定3件）のQ&Aを時系列降順で取得
- stdout: `additionalContext` 形式（`formatResults`再利用）
- **要件**: Claude Code v2.1.0+（plugins/repos/planning-with-files の troubleshooting.md より）

### 3.7 HF_HUB_OFFLINEデフォルト化

`src/search/embedding.ts` の `pipeline()` import前に:

```typescript
process.env.HF_HUB_OFFLINE ??= '1';
process.env.TRANSFORMERS_OFFLINE ??= '1';
```

- ユーザーが明示的に `HF_HUB_OFFLINE=0` を設定していれば尊重
- README に「初回モデルDL時のみ通信、以降は完全オフライン」を明記

---

## 4. データフロー詳細

### 4.1 新規セットアップユーザー

```
kizami setup
├── ~/.config/kizami/config.json 作成
├── ~/.local/share/kizami/jsonl/ ディレクトリ作成
├── ~/.local/share/kizami/memory.db 作成
└── ~/.claude/settings.json に SessionStart/SessionEnd/UserPromptSubmit を登録
```

### 4.2 既存ユーザー（v0.1.x → v0.2.0）

```
v0.1.x: SQLiteのみ
   ↓ kizami migrate-to-jsonl (一度実行)
v0.2.0: SQLite + JSONL の二層構成
   ↓ 以降は二重書き込み
```

`migrate-to-jsonl` 未実行を `save` 時に検知すると、stderrに警告。

---

## 5. 性能観点

### 5.1 ベンチマーク対象と絶対値目標（レビュー指摘#8を反映）

| シナリオ                                 | 計測項目               | **顕著改善の判定基準（絶対値）**                      |
| ---------------------------------------- | ---------------------- | ----------------------------------------------------- |
| save (100 chunks, coreモード)            | wall time              | JSONL書き込みオーバーヘッドが**+30ms以下**（実測）    |
| recall (1000記憶DB)                      | wall time              | **不変**（±5%以内）                                   |
| **rebuild (1000 chunks, embeddingあり)** | wall time              | **モデルロード不要で5秒以内**（v0.1.xでは実現不可能） |
| **SessionStart inject**                  | wall time              | **50ms以下**（FTSのみ、embedding計算なし）            |
| 起動時self-healing                       | wall time              | **100ms以下**（末尾100行スキャン）                    |
| **障害復旧**                             | SQLite完全削除→rebuild | **データロス0で完全復元**（v0.1.xでは復旧不能）       |

**「顕著改善」の判定**: 上記6項目のうち、**v0.1.xで実現不可能な太字3項目**（rebuild速度・SessionStart注入・障害復旧）が動作することを以て顕著改善とみなす。他3項目は既存機能の劣化がないことを確認するため。

### 5.2 ベンチスクリプト

`tests/perf/bench.ts` を新設し、`pnpm bench` で実行可能にする。CI性能回帰検知はoptional（最初はローカル実行のみ）。

---

## 6. CI/pre-commit 設計

### 6.1 pre-commit (husky + lint-staged)

レビュー指摘#6を反映し、**typecheckはpre-commitから除外**（差分絞り込み不能で重い）:

```bash
# .husky/pre-commit
#!/usr/bin/env sh
# 1. gitleaks (secrets scan) — staged diff のみ
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks protect --staged --no-banner --redact || exit 1
else
  echo "[pre-commit] gitleaks not installed; skipping. Install: brew install gitleaks"
fi

# 2. lint-staged: 変更ファイルのみ eslint --fix + prettier --write
pnpm exec lint-staged
```

- typecheck/test/build はCIに委譲（pnpm check）
- gitleaks 未インストール時はwarning + パス。**CI側で必ず実行されるため抜け穴にならない**
- 新規依存: `husky` と `lint-staged`（合計約30KB、devDepのみ）

### 6.2 既存ユーザー向け案内

レビュー指摘#2を反映し、`kizami setup` 実行時にJSONL未移行を検知したら以下を表示:

```
[kizami] v0.2.0からはJSONLが正本になりました。
[kizami] 既存のSQLiteデータをJSONLに移行するには:
[kizami]   $ kizami migrate-to-jsonl
[kizami] 未移行のまま使用してもデータロスはありませんが、自動復旧/Git同期が無効化されます。
```

### 6.2 GitHub Actions 拡張

既存 `.github/workflows/ci.yml` に `secrets-scan` ジョブを追加:

```yaml
secrets-scan:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
      with: { fetch-depth: 0 }
    - uses: gitleaks/gitleaks-action@v2
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

既存の `check` ジョブは `pnpm check` をそのまま実行（変更なし）。

---

## 7. 影響範囲とロールアウト

### 7.1 変更ファイル

| ファイル                   | 種別   | 概要                                           |
| -------------------------- | ------ | ---------------------------------------------- |
| `src/jsonl/writer.ts`      | NEW    | append + fsync                                 |
| `src/jsonl/reader.ts`      | NEW    | streaming reader                               |
| `src/jsonl/path.ts`        | NEW    | ファイル命名規則                               |
| `src/jsonl/migrate.ts`     | NEW    | SQLite→JSONL                                   |
| `src/jsonl/rebuild.ts`     | NEW    | JSONL→SQLite                                   |
| `src/hooks/save.ts`        | MODIFY | JSONL先書き                                    |
| `src/hooks/inject.ts`      | NEW    | SessionStart注入                               |
| `src/hooks/setup.ts`       | MODIFY | SessionStartフック追加                         |
| `src/search/embedding.ts`  | MODIFY | HF_HUB_OFFLINE先頭セット                       |
| `src/cli.ts`               | MODIFY | inject/rebuild/migrate-to-jsonl 追加           |
| `src/config.ts`            | MODIFY | storage.jsonlDir, hooks.injectRecentCount 追加 |
| `tests/jsonl/*.test.ts`    | NEW    | TDD                                            |
| `tests/perf/bench.ts`      | NEW    | ベンチ                                         |
| `package.json`             | MODIFY | husky, lint-staged, bench script               |
| `.husky/pre-commit`        | NEW    | gitleaks + 軽量gate                            |
| `.github/workflows/ci.yml` | MODIFY | secrets-scan ジョブ                            |
| `README.md`                | MODIFY | HF_HUB_OFFLINE, JSONL正本の説明                |

### 7.2 後方互換性

- `loadConfig` のdefaults に `storage.jsonlDir` を追加。既存ユーザーの `config.json` は読み取り時にmergeされるため、再起動だけで新フィールドが有効化される
- `migrate-to-jsonl` 未実行ユーザーには、`save` で stderr 警告を出すが処理は続行（フェイルクローズしない）
- v0.2.0 で破壊的変更フラグを立てる（semantic-release が拾う）

---

## 8. リスクと緩和策

| リスク                             | 影響             | 緩和                                                          |
| ---------------------------------- | ---------------- | ------------------------------------------------------------- |
| JSONL書き込み失敗                  | save失敗         | エラーログ + SQLite継続書き込み（degradation graceful）       |
| ULID衝突                           | 検索結果重複     | ULID実装は標準libを使用、衝突確率1/2^80以下                   |
| `.emb.jsonl` ファイル肥大          | ディスク圧迫     | 月分割でローテート、`maintenance/auto.ts` で古い月の gzip圧縮 |
| Claude Code SessionStart hook 互換 | inject動作しない | hook仕様変更時はsetup.tsのversionチェックで対応               |
| pre-commit が重くなる              | DXの悪化         | lint-stagedで差分のみ実行、フルcheckはCI側                    |

---

## 9. 受け入れ基準

- [ ] `pnpm test` で 新規 `tests/jsonl/*` を含む全テストPass
- [ ] `pnpm check` がローカル/CI両方で完走
- [ ] `gitleaks protect --staged` がpre-commitで走る
- [ ] CI `secrets-scan` ジョブが新設されPass
- [ ] `kizami rebuild` で 既存DBと完全一致するチャンクが再生成される
- [ ] `kizami migrate-to-jsonl` で既存ユーザーが0データロスで移行可能
- [ ] **顕著改善判定**（§5.1）: v0.1.xで実現不可能な以下3項目が動作:
  - rebuild 1000 chunks をモデルロード不要で 5秒以内
  - SessionStart inject が 50ms以内
  - SQLite完全削除 → rebuild でデータロス0復元
- [ ] `HF_HUB_OFFLINE` が embedding 初期化前にセット済みであることをユニットテストで検証

### 必須テストケース（レビュー指摘#5を反映）

| カテゴリ         | テストケース                                                    |
| ---------------- | --------------------------------------------------------------- |
| JSONL writer     | append+fsync成功、ファイルローテーション、ロック                |
| JSONL reader     | 大量行のstreaming、不正行のskip、月またぎ                       |
| save統合         | JSONL先書き失敗→SQLite挿入されないこと                          |
| save統合         | SQLite挿入失敗→JSONLは残ること（self-healingで補完できる）      |
| rebuild          | dry-run、idempotency（二度実行で重複しない）、embedding hex復元 |
| migrate-to-jsonl | 中断→再実行で重複しない（randomUUID再生成しない＝既存ID保持）   |
| inject           | プロジェクト直近Q&A取得、空結果、cwd正規化                      |
| embedding        | `HF_HUB_OFFLINE` がpipeline初期化前にセット済み                 |
| self-healing     | JSONL末尾100行のうちSQLite不在分が自動補完                      |

---

## 10. PR分割方針

このPRは単一にする（README更新まで含む）。理由:

- JSONL正本化単独では効果が薄く、SessionStart+OFFLINEと組み合わせて「kizami v0.2.0の柱」として打ち出したい
- CI/pre-commit 強化はこのPR内で先行投入し、以降のPRの品質保証を効かせる

レビューしやすさのため、コミットは feature単位で分ける:

1. `chore(ci): add gitleaks + pre-commit gates`
2. `feat(jsonl): introduce JSONL as canonical store`
3. `feat(hooks): add SessionStart inject hook`
4. `feat(embedding): default HF_HUB_OFFLINE=1`
5. `perf: benchmark suite for save/recall/rebuild`
6. `docs: update README for v0.2.0 architecture`

---

## 11. 検証コマンド一覧

```bash
# 開発
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test

# 性能
pnpm bench

# 品質ゲート (CIと同じ)
pnpm check

# secrets scan (local)
gitleaks protect --staged --no-banner --redact

# E2E (手動)
kizami migrate-to-jsonl
kizami rebuild --dry-run
kizami inject < fixtures/session-start-payload.json
```
