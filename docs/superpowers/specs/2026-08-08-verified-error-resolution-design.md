# 検証済みエラー解決記録 設計書

- 文書版: 1.0.12-sealed
- 対象ブランチ: `feature/verified-error-resolution-records`
- ローカルレビュー成果物: `docs/analysis/`と`docs/_quality/`（`.gitignore`対象）

## 目的と成功条件

現行の`extractMetadata()`が行う`error|失敗|exception`の文字列抽出を残したまま、より強い実行証拠を別の構造化記録として追加します。Kizamiは、同一コマンドの明示的な失敗後に明示的な成功を観測した場合だけ「検証済みエラー解決記録」を生成します。

成功条件は次のすべてです。

1. `error`を含む成功出力や終了状態不明の出力から検証済み記録を生成しません。
2. 同一プロジェクト、同一セッション、生commandがbyte単位で一致する失敗後成功から1件の記録を生成します。
3. TurnCheckpointの改訂、再適用、session reset後も重複または古い記録を残しません。
4. SQLiteを削除し、JSONLから再構築した結果が増分適用後と一致します。
5. `kizami resolutions --show-evidence`で、terminal制御文字除去と既知資格情報形式のbest-effort maskを適用したコマンド、失敗出力抜粋、検証出力抜粋、検証日時を確認できます。optionなしでは生の証拠を表示しません。
6. 外部LLMを呼び出さず、保存する出力を先頭20行、末尾5行、UTF-8 64 KiBのうち最初に達した上限へ制限します。
7. ユニットテスト、ビルド済みCLIを使うE2E、StrykerJSによるmutation testingが合格します。検証判定に関係するsurviving mutantは0件とします。
8. JSONL recordは必須fieldと入れ子構造を検証してからTypeScript型へ昇格し、save時の末尾確認とtransaction重複確認では月次file全体をBuffer、string、行配列へ同時複製しません。
9. prepared receiptから復旧するときは、transactionとして再検証した`allLines`だけをJSONLとSQLiteへ適用し、追記先をKizamiの所定directory直下へ限定します。receiptだけでは所有関係を証明できないpending fileは復旧時に削除しません。

## 対象範囲

対象に含めます。

- Claude transcriptの`tool_use`と`tool_result.is_error`の結合
- TurnCheckpointへの実行観測追加とcontent hashへの反映
- SQLite schema v5への実行観測テーブルと検証済み記録テーブル追加
- TurnCheckpointの増分適用、改訂、baseline置換、JSONL rebuildでの派生記録再計算
- `kizami resolutions [query]`によるローカル検索
- Claudeのfixture、CodexとKimiの証拠不足fixtureを使うテスト

対象に含めません。

- 検証済み記録の自動プロンプト注入
- Assistant文章から原因または修正内容を要約する処理
- 異なるコマンド同士を意味的に同一と推測する処理
- セッションをまたいだ失敗と成功の結合
- 現行Stop hookからrollout pathを取得できないCodexの実行観測生成
- 成否情報を持たないKimi wire eventの文字列推測
- シークレット検出器の新設。保存対象はローカルに限定し、JSONLとSQLite関連fileへ`0600`、格納directoryへ`0700`を適用します。

## 意思決定

全17件の選択肢と採用理由はローカルの意思決定表で凍結し、採用した契約は本設計へ統合しています。未決定事項はありません。本設計で特に影響が大きい判断は以下です。

| 判断対象 | 採用する判断                        | 実装への影響                                        |
| -------- | ----------------------------------- | --------------------------------------------------- |
| 検証条件 | 生commandがbyte単位で同じ失敗後成功 | 別テストの成功を元エラーの解決と見なしません        |
| 正本     | TurnCheckpoint内の実行観測          | 新しい独立JSONL系統を作りません                     |
| 完成記録 | SQLiteで決定的に派生                | 改訂とrebuildのたびに同じアルゴリズムで再計算します |
| 証拠不足 | 記録を生成しない                    | CodexとKimiは通常チャンク保存だけを継続します       |
| 提供方法 | CLI検索                             | トークン削減策が完成する前の自動注入を増やしません  |

設計途中の実動作確認として、ローカルに保存された実ログを内容非表示の構造照会で確認しました。

- Claudeの利用中ログでは、user message内の`tool_result`に`tool_use_id`、`content`、`is_error`が存在し、成功と失敗の両方を確認しました。
- 過去のCodex rolloutには`function_call`と`function_call_output`の対応がありましたが、現行Stop hookの入力にはrollout pathが無く、利用中rolloutのtool record形式も一種類ではありませんでした。そのため今回の保存経路から明示的な成否へ到達できる契約は確認できませんでした。
- Kimi 0.18.0 fixtureの`tool_result`は内容だけで、対応コマンドと成否を持ちませんでした。

この確認により、既存のエラー文字列検出を検証根拠へ昇格させるのではなく、実行環境が持つ明示的な状態を新しい入力とする判断を固定します。

## 保存する記録

TurnCheckpointへ後方互換なoptional配列を追加します。旧JSONLに`executions`が無い場合は空配列として扱います。

```ts
type ExecutionStatus = 'failed' | 'succeeded' | 'unknown';

interface ExecutionObservationV1 {
  executionIndex: number;
  toolName: string;
  command: string;
  status: ExecutionStatus;
  exitCode?: number;
  outputExcerpt: string;
}

interface TurnCheckpointV2 {
  // existing fields
  executions?: ExecutionObservationV1[];
}
```

実行観測はruntime、session ID、turn key、execution indexの既存fieldによる複合キーで識別し、新しいhash IDを作りません。project pathはrevisionで変化し得る属性であり、安定したturn識別子には含めません。同一コマンドの判定は保存済みの生コマンドをbyte単位で比較し、索引用hashを追加しません。trim、改行変換、連続空白の縮約も行いません。

schema v5で次の派生テーブルを追加します。

| テーブル                     | 主キー                                                           | 役割                                                                      |
| ---------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `execution_observations`     | runtime、session ID、turn key、execution indexの複合キー         | 最新TurnCheckpointに含まれる実行観測を保持します                          |
| `verified_error_resolutions` | runtime、session ID、成功turn key、成功execution indexの複合キー | 生commandがbyte単位で同じ連続失敗群と、それを終端する成功観測を保持します |

`execution_observations`はruntime、session ID、project path、turn key、source order、history epoch、revision、execution index、tool name、command、status、exit code、output excerpt、completed atを持ちます。turn revisionを置換するときは、revision間で不変なruntime、session ID、turn keyで旧観測を削除してから挿入します。新checkpointのproject pathを削除条件へ使いません。

`verified_error_resolutions`はruntime、project path、session ID、command、最初と最後の失敗turn keyとexecution index、失敗回数、最後の失敗出力抜粋、成功turn keyとexecution index、成功出力抜粋、verified atを持ちます。実行観測と解決記録のための追加hash列は作りません。

SQLiteの完成記録はJSONL正本ではありません。JSONLに保存する最新TurnCheckpointの実行観測列をsource orderとexecution indexで並べ、同じresolverへ入力すれば再生成できます。

## 処理フロー

### 実行観測の生成

1. runtime adapterが現在ターンのtool callとtool resultをcall IDで結合します。
2. commandが文字列で取得できない実行は対象外とします。
3. 明示的な終了コードまたは`is_error`からstatusを決めます。両方無い場合は`unknown`です。
4. 出力を先頭20行、末尾5行、UTF-8 64 KiBのうち最初に達した上限へ決定的に切り詰めます。
5. 実行の識別にはruntime、session ID、turn key、execution indexを使い、追加hashは生成しません。
6. coordinatorは実行観測を含めてcontent hashを生成し、TurnCheckpointへ保存します。

Claude adapterはtranscriptのuser message内にある`tool_result`を読み、同じ`tool_use_id`を持つ直前のtool useと結合します。既存fixtureで使うトップレベル`toolUseResult`も後方互換で読みます。

Codex adapterは通常のcheckpoint保存を継続しますが、現行Stop hookから成否付きrolloutへ到達する契約が無いため、実行観測は空配列を返します。将来、hookから安定したrollout pathと明示的終了状態を取得できる契約をfixtureと実ログの両方で確認できた場合だけ別設計で追加します。

Kimi adapterは、tool name、command、call ID、成否を同時に取得できるeventだけを将来同じ型へ変換できます。現行fixtureは条件を満たさないため空配列を返します。

### 検証済み記録の再計算

1. runtime、project path、session IDが同一の実行観測をhistory epoch、source order、execution indexの昇順へ並べます。
2. runtime、project path、session ID、生commandの組ごとに未解決の失敗観測を蓄積します。
3. statusが`unknown`の観測は状態を変更しません。
4. statusが`failed`なら、その生commandの未解決失敗列へ追加します。
5. statusが`succeeded`かつ未解決失敗が存在するなら、失敗列全体と成功観測から1件の検証済み記録を生成し、失敗列を空にします。
6. statusが`succeeded`で未解決失敗が無い場合は何も生成しません。

増分適用、turn revision、baseline置換は、観測テーブル更新と同じSQLite transaction内でsession単位の完成記録を全削除して再計算します。session単位の再計算にすることで、古いturn revisionから作られた記録が残りません。

session resetで新しいhistory epochを割り当てた場合、checkpointの重複・revision判定には同じepochのturn headだけを使います。旧epochに同じturn keyとcontent hashがあっても、新epochのbaselineへ候補を含めてrevision 1として保存します。

prepared receiptの復旧では、旧receiptに存在し得る`records`と`turnKeys`の複製値を正本として使いません。新規receiptには重複`records`を保存せず、payloadとturn keyは`allLines`から導出します。receiptはprivate regular fileとして最大64 MiBまで読み、`allLines`を最大4096 payload、各行4 MiBに制限してからtransaction begin、payload schema、record count、既存payload digest、commitの順に再検証し、検証結果からpayload、turn key、history epochを導出します。通常保存もreceiptを永続化してJSONLへ追記する前に、同じ件数・各行上限と実際のreceipt JSON byte数上限を検査します。初期`prepared`はphaseとsuperseded reasonの追加に1 KiBを予約した上限とし、各phase更新では`O_NOFOLLOW`と`O_NONBLOCK`で開いたfdがregular fileでありpathと同一であることを確認し、そのfdへ`0600`を適用するbounded private readerで再読取りした後、絶対上限を再検査します。これによりsymlink差替えによる外部fileのmode変更とFIFO差替えによるblocking openを防ぎます。JSONL追記先は設定されたJSONL directory直下の非hidden `.jsonl`に限定し、`prepared/<runtime>`とreceipt runtimeも一致させます。prepared rootとruntime directoryがsymbolic linkの場合は復旧を拒否します。

receiptのhistory epochが現在のsession epochより古ければ、turn keyが新baselineに存在しなくてもreceipt全体をsupersededとします。同じepochでだけturn headの観測境界、revision、content hashを比較します。receiptのepochが新しい場合、旧epochのturn headは包含済みとみなしません。commit済みsession resetをcoordination DBへ適用するときはsession epochを単調増加で復元します。

commit済みturn checkpointをcoordination DBへ再適用するときもturn headを単調更新します。新しいhistory epochだけを旧epochへ上書きでき、同epochではrevisionの増加と観測境界の同値または前進を必要とします。同revision、同contentはno-opとし、同revision、別contentはconflictとして拒否します。

復旧receiptのpending pathは検証済みtransactionに含まれず、同一session内のどのpending promptに対応するか完全には証明できません。そのため復旧経路ではpending fileを削除しません。残ったpendingは次回の通常保存でadapterが再取得し、canonical headの冪等判定を通過した後に通常経路で削除します。

公開計算のpayload digestは偶発破損とcommit済みcanonical frameとの同一性確認には使えますが、receipt単独の真正性は証明しません。transactionがJSONLへ未commitならreceipt payloadを追記せずsupersededとし、pendingを残して次回hookにauthoritative transcriptから再抽出させます。JSONLに同じtransaction IDとdigestのcommit済みframeが存在する場合だけ、検証済みpayloadをSQLiteへ再適用します。

現行JSONLとSQLiteではsession IDが正本全体で一意なsession識別子であり、session resetとhistory epochはsession全体へ適用されます。project pathはsessionの属性として途中で変化し得ます。resolverだけは異なるproject pathの観測を結ばず、revisionでproject pathが変わった場合は旧turn観測を不変なturn識別子で置換して両projectを再計算します。同じsession IDを別runtimeの別sessionへ再利用する入力は既存checkpoint契約外であり、今回その永続モデルを変更しません。

### CLI検索

`kizami resolutions [query]`は現在projectを既定scopeとし、queryがあればcommand、最後の失敗出力抜粋、成功出力抜粋を部分一致検索します。`--all-projects`は既存search commandと同じ意味で全projectを対象にします。結果は検証日時の降順で表示し、1件ごとに失敗回数を出力します。optionなしではcommand、失敗抜粋、成功抜粋を非表示にします。利用者が`--show-evidence`を指定した場合だけ、保存値を変更せずにAuthorization、環境変数、CLI password/token option、curl/URL userinfo、JWT、AWS access key、主要service token、PEM private keyをbest-effortでmaskして証拠を表示します。未知の資格情報形式を完全には判別できないため、CLIは共有前確認が必要だと警告します。commandの改行は1行内へ可視化し、複数行の出力抜粋は継続行へ固定prefixを付けます。

## 不変条件

1. 明示的な失敗観測と、その後の明示的な成功観測が無ければ検証済み記録は0件です。
2. 失敗と成功はruntime、project path、session ID、生commandがbyte単位で同一です。
3. 成功観測のsource orderとexecution indexは、最後の失敗観測より後です。
4. statusが`unknown`の観測は失敗にも成功にも変換しません。
5. 同じTurnCheckpointを複数回適用してもexecution observationと検証済み記録の件数は増えません。
6. より新しいturn revisionは旧revisionの観測と、それに由来する完成記録を置換します。
7. session reset後は古いhistory epochの観測と完成記録を残しません。
8. 既存のcontent hashはruntime、project path、partsに加え、配列の件数と順序を含む各実行観測のexecution index、tool name、生command、status、exit codeまたはnull、output excerptを長さ付きで正規化して対象にします。新しいhash列は作りません。
9. SQLiteを全消去してJSONLのcanonical headをmaterializeした結果は、増分適用後と同じ実行観測複合キーと解決記録複合キーを持ちます。
10. 1観測のoutput excerptは先頭20行、末尾5行、UTF-8 64 KiBの上限を超えません。
11. JSONL v1 chunkと`executions`を持たない既存TurnCheckpointは従来どおり読み込めます。
12. JSONL v1 chunk、transaction枠、session reset、TurnCheckpointはrecord種別ごとの必須field、列挙値、配列、入れ子fieldが有効な場合だけ正本として処理します。
13. self-healの末尾読取りは最大1 MiBに制限し、transaction ID検索は64 KiB blockのstreaming走査とwriter-lock SQLiteの走査済みfile identity、size、mtime、ctimeを使います。走査ではbegin、payload、commitの件数、型、既存payload digestを検証し、orphan commitをcacheしません。通常の追記ではfile世代と属性が変わらない限り月次file全体を再走査しません。
14. serializerとtransaction scannerはJSONL 1 recordあたり4 MiBの同じ上限を使います。新規recordは保存前に拒否し、既存fileで上限超過frameを検出した場合は未commitとみなさず明示エラーで停止します。
15. 旧prepared receiptの`records`と`turnKeys`は復旧入力として信頼せず、新規receiptには重複`records`を保存しません。digestとschemaを検証した`allLines`由来のpayloadだけを扱います。
16. session resetの候補は旧history epochのturn headと比較せず、新epochのbaselineへ必ず含めます。
17. 復旧receiptが指定するJSONL追記先はKizamiの所定directory直下に限定し、復旧時はpending fileを削除しません。
18. 復旧receiptは64 MiB、4096 payload、各JSONL line 4 MiBを上限とし、prepared directoryのruntime配置と非symbolic linkを検証します。
19. 復旧時は現在session epochより古いreceiptをturn単位判定前にsupersededとし、session reset payloadをcoordination DBへ適用するときはepochを減少させません。
20. 検証日時、件数、command、出力抜粋を含むCLIの全可変fieldへterminal制御文字除去を適用します。
21. 通常保存は復旧と同じreceipt上限をJSONL追記前に検査し、未commit receipt単独からcanonical JSONLへpayloadを追記しません。
22. 初期prepared receiptはphase更新用に1 KiBを予約し、各phase更新でもnon-symlink regular fileをbounded再読取りして64 MiB以内であることを検査します。
23. coordination turn headはhistory epoch、revision、観測境界を後退させず、同revision、別contentを拒否します。
24. 既存の`metadata.errorMessages`は検索互換性のため維持しますが、検証済み判定には使用しません。

## 失敗時の動作

| 失敗                                             | 動作                                                   | データ整合性                                                   |
| ------------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------- |
| call IDまたはcommandが無い                       | 対象の実行観測を生成しない                             | 通常の会話チャンク保存は継続します                             |
| outputはあるが明示的な成否が無い                 | statusを`unknown`として正本へ保持する                  | 検証済み記録は生成しません                                     |
| runtime transcriptの1行が不正JSON                | hookの既存fail-open経路でその行をスキップする          | 他の有効な行と通常チャンクを処理します                         |
| 同じcall IDへ複数の異なる結果がある              | 対応観測を`unknown`にする                              | 成功または失敗を推測しません                                   |
| SQLite schema migrationが失敗する                | transactionをrollbackしてhookの既存fail-open経路へ渡す | JSONLへ不完全なSQLite状態を書きません                          |
| JSONL commit後にSQLite更新が失敗する             | prepared receiptを残す                                 | 次回recoveryがTurnCheckpointと実行観測を再適用します           |
| turn revision適用中にresolverが失敗する          | SQLite transaction全体をrollbackする                   | 旧revisionの観測と完成記録を保持します                         |
| CLI検索中にDBを読めない                          | stderrへエラーを出して終了コード1にする                | 保存データは変更しません                                       |
| rebuild対象JSONLが破損またはdigest不整合         | fatal diagnosticを返し、DB書き込み前に中止する         | 既存SQLiteを一切変更しません                                   |
| JSONL末尾のtransactionがcommit前で終端           | uncommitted tail警告を返し、そのtransactionを無視する  | 最後にcommit済みの正本だけを復元します                         |
| 未commit frame後に同じtxのcommit済みretry        | 回復済みcrash retryとして旧frameを無視する             | commit済みretryだけを1回復元します                             |
| receiptの`allLines`がdigestまたはschema不整合    | 復旧を失敗としてreceiptを保持する                      | 複製`records`を代替入力としてSQLiteへ適用しません              |
| receiptの追記先が所定directory外                 | 復旧を失敗としてreceiptを保持する                      | 任意fileへの追記を行いません                                   |
| receiptが64 MiB、4096 payload、1行4 MiBを超過    | 読取りまたはtransaction検証前に復旧を失敗させる        | 改ざんreceiptによる無制限memory消費を防ぎます                  |
| receiptが現在session epochより古い               | receiptをsupersededとしてJSONL/SQLiteへ再適用しない    | 新baselineから除外された旧turnを復活させません                 |
| 復旧後もpending fileが残る                       | 次回の通常保存で冪等確認後に削除する                   | receiptだけを根拠とする別pendingの削除を防ぎます               |
| receiptはあるがtransactionがJSONL未commit        | receiptをsupersededとしpendingを残す                   | 次回hookがruntime正本から再抽出し、改ざんreceiptは追記しません |
| 通常保存のreceiptが復旧上限を超える              | JSONL追記前にcoordination transactionをrollbackする    | 保存側が生成した復旧不能receiptを残しません                    |
| phase更新後のreceiptが64 MiBを超える             | phase更新を拒否して既存receiptを保持する               | 復旧側が読めない状態へ拡張しません                             |
| phase更新前にreceiptが巨大fileまたはlinkへ変わる | bounded private readerが更新前に拒否する               | 上限検査前のOOMとlink先読取りを防ぎます                        |
| 古いcommit済みreceiptを再適用する                | coordination headを更新せずSQLite側でもstale扱いする   | revision採番を巻き戻しません                                   |
| 通常rebuildで`--from-month`を指定                | 引数エラーとしてDB書き込み前に終了する                 | 指定外の月をDBから失いません                                   |

hook処理全体の既存fail-open契約は維持します。ただし内部のstorage APIは例外を握り潰さず、coordinatorまたはCLI境界で既存方針に従って処理します。

## 移行

`CURRENT_SCHEMA_VERSION`を5へ上げ、既存テーブルを書き換えずに2テーブルと検索indexを追加します。既存行のbackfillは行いません。従来のチャンクには明示的な終了状態が保存されておらず、文字列から補完すると「検証済み」の条件を破るためです。

既存TurnCheckpointの`executions`はoptionalとして読み、欠落時は空配列に正規化します。JSONL record versionは2のままとします。transaction framingとTurnCheckpointの後方互換なfield追加で表現でき、v1 chunk recordの意味も変わらないためです。

現在の`rebuildFromJsonl()`はv1 chunkのstreaming復元を中心に実装され、`foldCanonicalHistory()`と`Store.materializeCanonicalHistory()`が扱うv2 canonical turnをCLI rebuild経路でmaterializeしていません。今回のE2E条件を満たすため、rebuildを次の順序へ統合します。

1. 通常rebuildは全月を`foldCanonicalHistory()`で読みます。`--from-month`はdry-runにだけ許可し、通常rebuildとの併用はDBを開く前に引数エラーとします。
2. foldは各reset sessionについて最大history epochを先に選び、そのepoch内の各turnで最大revisionをcanonical headとします。古いepochの大きなrevisionが新しいepochを上書きしてはなりません。
3. 破損JSON、digest不整合、orphan record、同じtransaction IDを異なるpayload digestへ再利用したcommit済みframe、canonical対象epoch内のrevision conflictをfatal diagnosticとして扱い、1件でもあればDBを変更せず中止します。ファイル末尾でcommitされずに終わったtransactionと、後続に同じtx IDとpayload digestのcommit済みretryがあるabandoned frameは警告として無視できます。破棄対象の旧epoch内だけのrevision conflictはcanonical headへ影響しないためfatalにしません。
4. dry-runではlegacy chunk数とcanonical turn parts数を数えるだけにし、SQLiteへ書き込みません。
5. 通常実行では全診断検証とembedding decodeを完了してから、1個のSQLite transactionでtruncate、v1/v2 materialize、embedding再関連付け、実行観測挿入、検証済み記録再計算を行います。いずれかの書き込みに失敗した場合は既存cache全体へrollbackします。
6. `Store.truncateAll()`は既存テーブルに加えて実行観測と検証済み記録も同じtransaction内で消去します。

この統合により、今回追加する実行観測だけでなく、既存v2 TurnCheckpointも`kizami rebuild`で復元されることをE2Eで固定します。

## セキュリティとプライバシー

- 実行観測の解析、resolver、検索はすべてローカルで行い、外部APIへ送信しません。
- JSONL、SQLite、prepared、pending、cursorの専用永続directoryは作成時と利用時に`0700`へ、JSONL、SQLite本体とsidecar、lock DB、prepared receipt、pending prompt、cursorの全永続fileは`0600`へ補正します。全platformで既存pathを`lstat`してsymbolic link、junction、種別不一致を拒否し、permission mode補正だけをUnixで実行します。設定するSQLiteとJSONLの親directoryはKizami専用であることを契約とし、共有directoryを直接指定しません。
- output excerptは既存チャンクにも含まれるtool resultの決定的な部分集合です。新たにprocess環境変数、認証情報store、未表示の標準入力を取得しません。
- CLI表示時は保存文字列をそのままshellへ再実行せず、標準出力へtextとして書くだけにします。
- terminal表示操作を防ぐため、CLI formatterは検証日時を含む全可変fieldのC0、C1、bidi制御文字を置換します。commandの改行は同一行内へ可視化し、出力の継続行には固定prefixを付けます。
- `--show-evidence`のmaskは既知形式に対するbest-effortであり、未知形式の非漏洩を保証しません。CLIは証拠表示前に共有前確認の警告を出します。
- 自動maintenanceはchunkと同じ保持期限を実行観測の`completed_at`へ適用し、削除対象sessionの検証済み記録を残存観測から再計算します。DB容量上限を超え、chunkが0件でも実行観測が残る場合は、古い観測から削除して再計算を続けます。
- `kizami export`へ新テーブルを自動追加しません。実行証拠のexportは別の明示的な設計判断が必要です。

## 性能と観測

`execution_observations`へsession IDと順序の複合index、project pathとsession IDの複合indexを作成します。生command用の追加indexやhash列は作成しません。`verified_error_resolutions`へproject pathとverified atの複合indexを作成します。

resolverは1sessionの観測数をnとしてO(n)時間、生command種類数を上限とするO(n)メモリで動作します。増分適用のたびに全databaseではなく対象sessionだけを再計算します。実装途中の性能確認では1,000観測の再計算を10回行い、中央値250ms未満を合格条件とします。この数値はKizamiの保存処理をhook timeout内へ収めるための開発時gateであり、製品全体の応答時間保証ではありません。

`kizami stats`へ次の件数を追加します。

- explicit statusを持つ実行観測数
- statusが`unknown`の実行観測数
- 検証済みエラー解決記録数

parserが証拠不足で観測を`unknown`にしたことは通常動作なのでstderrへ逐次出力しません。hook error logには例外だけを記録し、commandやoutput excerptを追加で出力しません。

## テスト戦略

### ユニットテスト

- 生commandをbyte単位で比較し、引用符内空白、前後空白、改行の差を別commandとして扱うこと
- 出力の20行、5行、UTF-8 64 KiB切り詰めと、短い出力の非変更
- Claudeのtool use/result結合、`is_error=true`と`false`、結果欠落、call ID競合
- CodexとKimiが実行観測を生成せず通常checkpointを保存すること
- `error`文字を含む成功出力が成功観測になること
- Kimiの証拠不足入力から実行観測を作らないこと
- resolverの失敗1回から成功、複数失敗から成功、成功だけ、unknown挿入、別command、順序逆転、別runtime、別project、別session
- Storeの初回適用、同一checkpoint再適用、revision置換、session baseline置換
- JSONL transaction encode、fold、materializeの後方互換と実行観測round-trip、最大epoch選択後のrevision選択
- 同じturn keyの旧epoch revision 9と新epoch revision 1では新epochを選び、破棄する旧epoch内だけのrevision conflictをfatalにしないこと
- fatal diagnostic時に既存DBを変更しないこと、uncommitted tailだけを無視できること
- 通常rebuildの`--from-month`拒否とdry-run許可、複数月の既存DBを失わないこと
- 実行観測を含むDBのtruncateと再構築で古い派生行が残らないこと
- embedding挿入の失敗注入でchunks、sessions、FTS/vector、実行観測、検証済み記録の全変更がrollbackされること
- Unixで全永続directoryが`0700`、全永続fileが`0600`へ補正され、全platformでsymbolic link、junction、種別不一致を拒否すること
- CLIの既定の証拠非表示、検証日時を含む全可変fieldのC0、C1、bidi制御文字除去、既知資格情報のbest-effort mask、共有前警告、複数行prefix、検索scope
- 必須fieldを欠くdigest-validなv2 payloadと、role、metadata、tokenCountが不正なv1 recordの拒否
- 1 MiBを超えるprefixを持つJSONLで、self-healが末尾recordだけをbounded読取りできること
- orphan commitをcommit済みと扱わず、cache後のfile truncateと後続の同一transaction ID・異payload frameを検出すること
- 未commitのsession reset receiptをJSONLへ追記せずpendingを残し、次回の通常reset保存でbaselineを復元すること
- reset候補が旧epochと同じturn key、同じcontentでも新epochのbaselineへrevision 1で含まれること
- receiptの`records`と`turnKeys`を書き換えても、検証済み`allLines`からSQLiteを復元すること
- receiptの`allLines`と既存payload digestが一致しない場合、およびpending pathがruntime directory外の場合に復旧を失敗させること
- receipt全体64 MiB、4096 payload、各行4 MiBの超過、runtime directory不一致、prepared directory symlinkを拒否すること
- 通常保存も同じreceipt上限をJSONL追記前に拒否し、重複`records`を新規receiptへ保存しないこと
- 初期receiptの1 KiB更新余白と各phase更新後の絶対上限を維持すること
- phase更新でもreceiptをbounded再読取りし、巨大fileとlink差替えを拒否すること
- 同epoch revision 2のheadへcommit済みrevision 1 receiptを復旧してもheadを巻き戻さず、次保存がrevision 3になること
- 復旧したsession resetがcoordination DBのepochを復元し、次checkpointも同epochへ保存されること
- 旧epoch receiptが新baselineに無いturnをSQLiteへ再挿入せず、旧epoch headが新reset receiptをsupersededにしないこと
- 復旧receiptに同runtime directory内の別pending pathを指定しても削除しないこと
- 4 MiBを超えるtransaction payloadは保存前に拒否し、既存の上限超過frameをretryしても追加byteを書かないこと
- 保持期限とDB容量上限の適用後に古い実行観測と、それだけに由来する検証済み記録が残らないこと

### E2Eテスト

ビルドした`dist/cli.js`をchild processとして起動し、一時config、SQLite、JSONL、Claude transcriptを使用します。

1. 1ターン目のUserPromptSubmitとStopで同一commandの失敗を保存します。
2. 2ターン目のUserPromptSubmitとStopで同一commandの成功を保存します。
3. `kizami resolutions`が1件を返して証拠を非表示にし、`--show-evidence`指定時だけ失敗と成功の出力抜粋を含むことを確認します。
4. 別sessionの古い実行観測と検証済み記録をSQLiteへ追加した状態で`kizami rebuild`を実行します。
5. 再度`kizami resolutions`を実行し、同じ解決記録複合キーと内容だけが残り、追加した古い行が消えることを確認します。
6. 成功commandを別引数へ変えたfixtureでは0件であることを確認します。
7. 同じturnのrevisionで失敗観測を除去した場合とsession resetを通した場合に、旧検証済み記録がビルド済みCLIの検索結果から消えることを確認します。

CodexとKimiのsanitized fixtureでは検証済み記録が0件で通常checkpointが保存されることを確認します。

### Mutation testing

StrykerJSのVitest runnerを追加し、Claude parser、resolverに加えて、content hash、epoch-first fold、revision置換、truncate、fatal診断、rebuild書込み開始条件として今回追加または変更する行を対象にします。通常の全test suiteではなく関連ユニットテストを使い、実行時間を制限します。

合格条件は対象の全mutantがKilledとなり、Survived、NoCoverage、Timeoutがすべて0件であることです。等価変異が生じる実装は条件を単純化するか、理由を設定fileへ明示して対象行を限定し、survivorとして受け入れません。

- 成功と失敗の反転
- unknownを成功または失敗として扱う変更
- 生command完全一致条件の削除
- 失敗より前の成功を結び付ける順序変更
- 失敗列を成功後に消去しない変更
- output上限を超える変更

## 段階的導入

1. 実行観測型とClaude parserをテスト先行で追加します。sanitized fixtureとローカル実ログの構造を使い、終了状態を実際に抽出できることをCLI外のprobeで確認します。CodexとKimiは空配列となることも確認します。
2. TurnCheckpoint、content hash、schema v5、Store materialization、resolverを追加します。一時databaseへ失敗と成功を適用し、途中状態0件、成功後1件、revision置換後0件となる実動作を確認します。
3. rebuild統合と`kizami resolutions`を追加します。ビルド済みCLIを使うE2Eで増分保存と再構築の一致を確認します。
4. 1,000観測の性能probe、全ユニットテスト、E2E、mutation testingを実行します。
5. 実装レビューでデータ整合性、runtime parser、セキュリティ、テスト十分性を確認し、指摘修正後に全gateを再実行します。

schema v5の追加テーブルは既存chunk検索から参照されません。ただし新しい`executions`fieldを含むcheckpointを一度保存した正本へ旧版から書き込むdowngradeは非対応です。旧版はexecutionsを含まない高revisionを追加して正本の実行観測を失い得るためです。rollbackはbranch切替だけで行わず、新版で取得したJSONLとSQLiteのbackupを保持し、旧版をread-onlyで使うかbackupへ復元します。

自動注入への接続は今回行いません。4週間のCLI利用で誤記録率、検索回数、再利用されたcommandを測定できる設計が別途承認された場合だけ、トークン上限付き注入を検討します。
