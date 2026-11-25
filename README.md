# Adobe-Extend-Script

Adobe Illustrator・InDesign・Photoshop向けExtendScriptの開発・改修先です。

| フォルダ | 対象 |
| --- | --- |
| [Ai](Ai/) | Illustrator |
| [Id](Id/) | InDesign |
| [Ps](Ps/) | Photoshop |
| [共用](共用/) | 複数アプリで使うスクリプト |

今回登録するスクリプトは、[InDesignのコメント付きPDF書き出し v1.3.1](Id/indd_ExportPDFWithCommentsXFDF_v1_3_1.jsx)です。
既存の作業フォルダやバックアップは移動せず、必要なファイルだけを個別に取り込みます。

開発の共通ルールは [AGENTS.md](AGENTS.md) を参照してください。Claudeからも [CLAUDE.md](CLAUDE.md) を通じて同じルールを参照します。
検証内容と実機未確認事項は [今回の検証記録](docs/indesign-comment-input-v1.3.1.md) にまとめます。

Scripta!の更新確認を本リポジトリで提供する場合は、ルートの `SCRIPTMETA.txt` を正本とします。今回のスクリプトはMeta-URLのないLocal Subsetで、更新確認用ファイルはまだ設置していません。
