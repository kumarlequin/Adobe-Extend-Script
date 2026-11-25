# Id

Adobe InDesign向けスクリプトを配置します。

## コメント付きPDF書き出し v1.3.2

[indd_ExportPDFWithCommentsXFDF_v1_3_2.jsx](indd_ExportPDFWithCommentsXFDF_v1_3_2.jsx) はInDesign 2024以降・macOSを主対象とします。
文字範囲・テキストフレーム・画像や図形へコメントを登録し、PDFと注釈用XFDFを書き出します。

対象を選んで起動すると「PDFコメント編集」を開きます。選択なしで起動すると書き出し画面を開き、一覧から「コメント編集」を開けます。

両方のコメント入力欄の操作は次のとおりです。

| 操作 | 動作 |
| --- | --- |
| Command+Return | 確定。「PDFコメント編集」では「反映して閉じる」、「コメント編集」では「反映」を実行 |
| Shift+Return | 選択文字列またはカーソル位置へ強制改行 |
| Return | 通常改行。日本語IMEの通常の確定は既定の入力処理に任せる |
| Command+Shift+Return | 強制改行を優先し、確定しない |

v1.3.0のページサムネイル選択・一時PNGの後片付け・ページ範囲変換・PDF/XFDF生成・Acrobat連携・コメント保存処理を保持しています。
v1.3.2で、v1.3.1のCommand+Returnが効かない不具合を修正しました。
元ファイルは元の作業フォルダに保持しています。静的検査と模擬キーイベント検証を実施し、Command+Returnの動作はユーザーがInDesignで確認済みです。その他の動作は未確認です。
詳細は [検証記録](../docs/indesign-comment-input-v1.3.2.md) を参照してください。
