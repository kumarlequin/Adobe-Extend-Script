# InDesignコメント入力 v1.3.1 検証記録

> 実機でCommand+Returnが効かないことが判明し、[v1.3.2](indesign-comment-input-v1.3.2.md) で修正した。下記の模擬検証は入力欄の処理関数を直接呼んでおり、イベントの配信段階を再現していなかった。

確認日: 2026-11-25（日本時間）

## 対象と比較元

- 改修対象: `Id/indd_ExportPDFWithCommentsXFDF_v1_3_1.jsx`
- 基準: 元の作業フォルダ内 `InDesign/開発中/indd_ExportPDFWithCommentsXFDF_v1_3_0.jsx`
- キー処理の比較元: 同フォルダの `indd_ExportPDFWithCommentsXFDF_v1_2_3.jsx`
- 両方の元ファイルは変更せず保持した。
- 同名スクリプトのv1.3.1が作業フォルダに存在しないことを確認した。取得時のGitHub mainにはREADME.mdのみ存在した。

## 改修内容

- v1.2.3の `bindCommentInputKeys` を追加し、通常の「PDFコメント編集」では `closeButton`、書き出し画面からの「コメント編集」では `okButton` へ登録した。
- Command+Returnは既存ボタンの `onClick` を実行するため、入力検証・文字数制限・保存経路を再利用する。
- Return単独は `preventDefault` / `stopPropagation` を呼ばず、`wantReturn: true` の既定処理へ任せる。
- Shift+ReturnとCommand+Shift+Returnは既定処理を止め、選択文字列またはカーソル位置へ `textselection` で改行を挿入する。
- 修飾キーはイベントの値を優先し、その値が `undefined` の場合だけ `ScriptUI.environment.keyboardState` の値で補う。
- 対象2画面へ共通定数 `COMMENT_DIALOG_OPACITY = 0.97` を適用した。既存のレイアウト値は保持した。
- ファイル名、SCRIPT_VERSION、SCRIPTMETAのVersion、targetengine名を1.3.1へ統一し、Release-Dateを2026-11-25へ更新した。
- SCRIPTMETAの説明を2行へ整理し、Script-IDとLocal Subset（Meta-URLなし）を保持した。

## 静的検査

- Adobe固有の先頭ディレクティブ2行を除外してAcorn 8.18.0のECMAScript 3モードで全文解析: 合格。
- 追加関数・登録2か所・不透明度設定と定数・SCRIPT_VERSION更新を除外した構文木を、v1.3.0の全文の構文木と比較: 一致。
- 元のトップレベル関数226個を保持し、キー処理の1関数のみ追加した（計227個）。
- キー処理の構文木をv1.2.3と比較: 一致。
- 登録2か所が既存のボタンハンドラー定義後、ダイアログ表示前にあることを確認した。
- ページサムネイル選択、PNG一時生成と削除、範囲入力への変換、PDF/XFDF生成、Acrobat連携、コメント保存、設定キー、保存形式は変更していない。
- ファイル名とメタデータの整合、説明2行、入力欄2か所の `wantReturn: true` を確認した。

## 模擬キーイベント検証

Node.js上の模擬入力欄・模擬ボタンで、187ケースが合格した。AdobeアプリやScriptUIの実体は起動していない。

| 検証群 | 件数 | 確認結果 |
| --- | ---: | --- |
| Return / Enter × イベントのCommand / Shift × 補助状態のCommand / Shift（各true / false / undefined） | 162 | イベント値を優先し、未定義だけを補完。Shift優先・確定・既定入力の分岐が一致 |
| 補助状態の取得が例外になる場合 | 18 | イベント値だけで処理を継続 |
| 無関係なキー・未定義のキー・小文字のキー名 | 5 | 無関係なキーを処理せず、Return / Enterは大文字小文字を吸収 |
| 選択範囲がない位置でのShift / Command+Shift | 2 | カーソル位置への改行を模擬確認 |

Return単独でイベントの既定処理を止めないことは確認した。日本語IMEそのものの動作保証を意味しない。

## 保持確認

元ファイルのSHA-256（作業前後で一致）:

- v1.3.0: `b02de3e4a4b2aa7127ce59ff7a7cb6cfdeb1bf6a7cca9f318e10628a313eb523`
- v1.2.3: `2bd35765a7e6359e5048a14f5f8b04951388f8dfd0b36e0c2a3bacd534aee145`

改修版のSHA-256:

- v1.3.1: `68d8fb617b2396867e1ddf4d35834c60f44d46175489bae2f13742668b85e63d`

既存READMEの上書き前バックアップは、元の作業フォルダ内 `InDesign/開発中/BU/Adobe-Extend-Script_README_before_structure_20261125_105033_813471.md` に保存した。新規ファイルを作成したため、元スクリプトの上書きは発生していない。

## リポジトリ

GitHub接続ツールで公開状態とmainの内容を確認し、指定プロジェクト配下の専用フォルダ `Adobe-Extend-Script` へ取得した。
取得時のmainは `6ea5cb5`（Initial commit）で、ルートにはREADME.mdだけが存在した。

改修時のローカルブランチは `codex/indesign-comment-input-1.3.1`（反映後は `main`）、originは `https://github.com/kumarlequin/Adobe-Extend-Script.git`。
2026-11-25にユーザーが今回の10ファイルの公開を明示承認した。承認対象はスクリプト全文、Ai / Id / Ps / 共用の構成、README、共通開発ルールとClaude用案内、検証記録、除外設定。GitHubのmainへ反映し、ローカルmainも同じ内容へ同期する。公開用ルールのローカル絶対パスは相対パスへ整理した。Adobeアプリ上での実行テストは行っていない。

Ai / Id / Ps / 共用それぞれにREADMEを配置し、ルートREADMEから案内する。共通ルールはAGENTS.mdに置き、CLAUDE.mdから同じ規則を参照する。
元のIllustrator / InDesign / Photoshopフォルダは移動・改名しておらず、無関係なスクリプトやバックアップも登録していない。

## 実機未確認

明示依頼がないため、Adobeアプリを用いた実行テストは行っていない。
両画面の実際のキー配信、IME変換確定、強制改行と選択置換、入力エラー後のフォーカス、保存・再読込、ページサムネイル表示、PDF/XFDF出力、Acrobat連携は実機未確認。
静的検査と模擬検証の合格は、これらの実機動作を保証するものではない。
