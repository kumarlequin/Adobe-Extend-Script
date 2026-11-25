# Project Instructions

## 使用言語とバージョン

- ExtendScript（ECMAScriptのバージョン3に基づくAdobe固有の拡張を含む）
- Adobe Illustrator 2024対応
- Adobe InDesign と Adobe Photoshop 向けの JavaScript / JSX も今後このプロジェクトで開発対象とする
- 対象アプリが Illustrator、InDesign、Photoshop のどれであるかを確認し、各アプリの ExtendScript DOM と対応バージョンに合わせて実装する
- アプリ間で DOM、座標系、単位、選択オブジェクト、ドキュメント構造、保存処理が異なるため、別アプリの実装をそのまま流用しない

## 開発・回答ルール

1. Illustrator向けスクリプトでは、必ずイラストレーター2022以降でサポートされているコードのみを使用する
2. コードに絵文字を使用しない
3. 回答に絵文字を使用しない
4. 完全な改修が行われるまで、繰り返し点検・デバッグを行い、完全に機能するコードを出力する
5. 改修が完全に行われるまで繰り返しデバッグを行い、不具合の解消及び要求した機能の実装が完了してからコードを出力する
6. 改修を要求された場合は、過度な省略や機能の欠損を行なっていないかレビューとデバッグを行う
7. 改修行なった際は、オリジナルコードとの差分を比較し、機能の欠損がないかレビューを行う
8. 差し替えの指示をする際に、差し替え箇所との差分を示すために "+" や "-" を使用しない
9. 開発する際は可能な限り構造化してメンテナンス性と可読性を担保する
10. Adobe系アプリケーションを用いたテストは、ユーザーから明示的な指示がある場合にのみ行う
11. 他のAIなどへ渡すプロンプトを出力する場合も前項を適用し、ユーザーから明示的な指示がない限り、Adobe系アプリケーションを用いたテストを実施する指示をプロンプトに含めない

## バックアップ保存先

以下は専用チェックアウトを作業フォルダ直下に置く場合の相対パスとし、バックアップはリポジトリ外へ保存する。別の環境では同等の保存先を設定する。

- 改修対象ファイルを上書きする前に、日時付きバックアップを作成する
- Illustrator用スクリプトのバックアップは、次のフォルダ内へ保存する
  `../Illustrator/開発中/BU`
- InDesign用スクリプトのバックアップは、次のフォルダ内へ保存する
  `../InDesign/開発中/BU`
- バックアップを改修対象ファイルと同じ階層へ置かない

## ScriptUI レイアウト基準

- ScriptUI を実装する場合は、`開発中/indd_FilePlacePalette_v1_0_1.jsx` の余白設計を基準値として参照する
- ScriptUI の操作用ダイアログおよびパレットは、不透明度を `97%`（`win.opacity = 0.97`）とすることを基本とし、値は可能な限り定数化して実装する
- パレット全体の外周余白は `win.margins = [8, 8, 8, 3]`、全体の要素間隔は `win.spacing = 6` を基本とする
- 上部の主要パネル内余白は `[15, 20, 16, 12]`、パネル内の行間は `10` を基本とする
- リストなど中央の主要パネル内余白は `[8, 12, 8, 12]`、密な一覧表示の行間は `3` を基本とする
- 下部ボタン群の余白は `[10, 5, 10, 10]`、ボタン群の配置は右寄せを基本とする
- ボタンサイズは同一グループ内で極力統一し、上部の主要ボタンは `104 x 25`、クリア系ボタンは `105 x 25`、下部の通常ボタン幅は `80`、主要実行ボタン幅は `100` を基準とする
- 詳細設定などのダイアログでは、ダイアログ全体の外周余白は `14`、パネル内余白は `13`、全体の要素間隔は `10` を基本とする
- グループ内の横方向の間隔は、通常行で `6`、チェックボックスなど並列オプションで `8` を基本とする
- 画面サイズ、対象アプリの ScriptUI 表示差、項目数により調整が必要な場合も、この基準値からの差分が分かるように定数化して実装する

## UI文言

- ラベル・選択肢は短く具体的にする。目安はラベル8字、選択肢12字以内。
- 常駐する補助文は原則省略し、必要な場合も1行に収める。
- 重複説明・長い括弧補足・実装の説明をUIへ載せない。
- 詳細は使い方へ移し、ツールチップも必要な1文に絞る（40字程度）。
- 操作の方向や復元時の差異など、判断に必要な情報は短く残す。
- コードコメントは意図や注意点に絞り、処理の逐語説明を避ける。

## コメント入力UIのキー操作

- コメント入力UIの作成・改修では、次の操作を標準とする
  - Command+Return：コメントを確定
  - Shift+Return：強制改行
  - Return：通常改行
- Command+Shift+Return は改行を優先し、確定しない
- 既存の入力検証・保存処理と、日本語IMEの通常の確定操作を維持する
- ExtendScript では ES3 互換性を保つ

## Scripta! / SCRIPTMETA 仕様

- このプロジェクトの JavaScript / JSX は、Scripta! というアプリケーションで使用・管理される前提とする
- Scripta! 用のメタデータとして SCRIPTMETA v1.4 仕様を考慮する
- SCRIPTMETA は、スクリプト本体や配布ページに書ける軽量なメタデータ形式で、主な用途は更新確認とローカルのスクリプト一覧での説明表示
- SCRIPTMETA は自動ダウンロードや自動インストールを目的としない
- 更新検知後の取得と導入は、利用者が配布ページを確認して手動で行う

### script 側メタデータ

- script 側は `SCRIPTMETA-BEGIN` と `SCRIPTMETA-END` を使う
- JSX の先頭にブロックコメントとして記述できる
- Update Profile では `Script-ID`、`Version`、`Meta-URL` を必須とする
- Update Profile では `Description`、`Target-App`、`Name`、`Author` を推奨する
- Local Subset では `Script-ID` のみ必須とする
- Local Subset では `Description`、`Version`、`Target-App`、`Name` を推奨する
- Local Subset には `Meta-URL` を書かない
- 更新確認対象にするのは、少なくとも `Version` と `Meta-URL` を持つ script 項目

### 配布ページ側メタデータ

- 配布ページ側は `SCRIPTMETA-DIST-BEGIN` と `SCRIPTMETA-DIST-END` を優先して使う
- 配布ページ側の必須項目は `Script-ID`
- 最新版を直接示す場合は `Version` を必須とする
- 別ページへ案内する場合は `Latest-URL` を必須とする
- `Version` と `Latest-URL` の両方がある場合は `Latest-URL` を優先する
- `Latest-URL` は配布ファイルそのものではなく、次に参照する SCRIPTMETA 情報ページの URL とする
- 配布ページ側の 1 ブロックには複数のスクリプト情報を記述できる
- 複数レコードでは `Script-ID` をレコードの先頭に置き、次の `Script-ID` までを同一レコードとみなす
- 配布ページ側の `Description` は無視する
- v1.1 互換として、配布ページ側では旧形式の `SCRIPTMETA-BEGIN` / `SCRIPTMETA-END` も候補にできる
- 同一ページに複数のメタブロックがある場合は、`SCRIPTMETA-DIST-BEGIN` / `SCRIPTMETA-DIST-END` を最優先し、次に `Meta-URL` を含まない旧形式ブロックを候補にする
- 旧形式ブロックの中で `Meta-URL` を含むものは script 本体由来のブロックとみなし、配布ページ判定から除外する

### Script-ID

- `Script-ID` は Update Profile でも Local Subset でも必須
- `Script-ID` はスクリプト識別子であり、全配布者の中で一意になることを強く目指す
- `Script-ID` は逆ドメイン記法に近い形式を推奨する
- 使用可能文字の目安は `A-Z`、`a-z`、`0-9`、`.`、`_`、`-`
- `Name` は表示名であり、識別には使わない
- 識別には必ず `Script-ID` を使う

### Description

- `Description` は `Description-BEGIN` と `Description-END` の間に複数行で記述する
- `Description-BEGIN` と `Description-END` の間の内容は、改行込みで説明文として保持する
- `Description-BEGIN` と `Description-END` は、前後の空白を除いた行全体がタグと一致する場合だけタグとして扱う
- `Description` 内ではキー解析をしない
- `Description` ブロックは直前の `Script-ID` のレコードに属する
- `Description` ブロックは 1 レコードにつき 1 個までとする
- `■ Description-END` や `本文 Description-END` は終端タグではなく本文として扱う
- `Description` は Scripta! の一覧で読む短い説明として、2〜3行程度に収める
- `Description` には、そのスクリプトで何ができるか（1行）と、修飾キーなどの起動方法に絞って書く
- 内部の仕組み（色空間や計算方法など）、細かな設定値、ダイアログ内の各機能の説明は `Description` に書かない（必要ならツールチップやコード内のコメントに書く）
- 改修で機能を追加しても、`Description` に追記して長くしない

### Version

- `Version` は Update Profile の script 側では必須
- 配布ページ側では、最新版を直接示すレコードで `Version` を必須とする
- Local Subset では `Version` を推奨する
- バージョンは `.` 区切りの整数列を基本とする
- `v1.2.3` のような表記は、数値部分を取り出して比較してもよい

### Meta-URL / Latest-URL

- `Meta-URL` は Update Profile の script 側で必須
- `Meta-URL` には、最初に見に行く SCRIPTMETA 情報ページ URL を指定する
- `Meta-URL` には、note、Qiita、gist、GitHub リポジトリなどの URL を指定できる
- Local Subset では `Meta-URL` を書かない
- `Latest-URL` の追跡では循環参照を検出し、追跡回数に上限を設ける

### Author / Edit-Password-SHA256

- `Author` は作者名であり、識別には使わない
- Update Profile では `Author` を推奨する
- Local Subset では `Author` は任意
- `Edit-Password-SHA256` を書く場合は、同じブロック内に `Author` も必須とする
- `Edit-Password-SHA256` は `<salt>:<sha256>` 形式で扱う
- `sha256` は `salt + ":" + password` を UTF-8 として SHA-256 にした 64 桁の小文字 16 進文字列
- パスワードそのものは書かない
- `Edit-Password-SHA256` は編集 UI 用の確認タグであり、更新確認、配布元の正当性判定、自動ダウンロード、自動インストールには使わない
- SCRIPTMETA はプレーンテキストなので、`Edit-Password-SHA256` を本当の改ざん防止や作者証明として扱わない

### 記述ルール

- `Key=Value` 形式で記述する
- 区切りは最初の `=` のみ
- UTF-8 テキストを推奨する
- 空行は無視する
- 不明キーは無視可能
- 複数行の値は禁止する
- ただし説明文は `Description-BEGIN` と `Description-END` のブロック形式で記述可能
- HTML の見た目、文字サイズ、色、CSS による表示状態では判定しない
- 取得できた本文テキストだけを対象にする
- gist を使う場合は `SCRIPTMETA.txt` を作成し、そこに配布ページ側の情報を記述する
- GitHub リポジトリを配布ページとして使う場合も、repo 直下の `SCRIPTMETA.txt` を更新判定の正本とする
- GitHub Releases や README の本文は、更新判定の正本として扱わない


## このリポジトリでの作業

- 開発・改修先はこのリポジトリとし、Ai（Illustrator）、Id（InDesign）、Ps（Photoshop）、共用（複数アプリ）の各ディレクトリへ配置する。
- 元の作業フォルダ全体をGit管理せず、対象スクリプトだけを個別に取り込む。無関係なスクリプトやバックアップを一括登録しない。
- 既存の上位版を基に改修し、旧版だけへ後付けされた機能がある場合は差分を確認する。元ファイルを保持し、版番号の重複を確認する。
- ファイル名、SCRIPT_VERSION、SCRIPTMETAのVersion、およびバージョン付きtargetengine名を整合させる。永続設定キーとコメント保存形式は互換性を維持する。
- CodexとClaudeはこのAGENTS.mdを共通の開発仕様とする。コメント入力のキー操作は上記「コメント入力UIのキー操作」を参照し、通常の編集画面と書き出し画面からの編集画面の両方へ適用する。
- キー確定は既存ボタンの入力検証・保存経路を呼ぶ。Return単独は既定処理へ任せ、Shift付きはCommand付きでも改行を優先する。
- Adobeアプリでの実行テストは明示依頼がある場合のみ行う。静的検査と元コードとの差分レビューの結果、および実機未確認事項を報告する。
- ScriptUIのレイアウト参照元は、元の作業フォルダ内の `バックアップ/InDesign/indd_FilePlacePalette_v1_0_1.jsx` にも保存されている。参照のために無関係なスクリプトをリポジトリへ取り込まない。
