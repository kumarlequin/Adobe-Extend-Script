#target indesign
#targetengine "inddExportPdfWithCommentsXfdf_v1_3_1_Engine"

/*
SCRIPTMETA-BEGIN
Script-ID=com.ppm.indd.export-pdf-with-comments-xfdf
Version=1.3.1
Target-App=Adobe InDesign 2024/2025
Name=コメント付きPDF書き出し(InDesign)
Release-Date=2026-11-25
Description-BEGIN
文字範囲や画像・図形へコメントを登録し、注釈用XFDFとPDFを書き出します。
対象を選んで起動するとコメント編集、選択なしで起動するとPDF書き出し画面を開きます。
Description-END
SCRIPTMETA-END

============================================================================
用途:
  1. TextFrame／文字範囲／画像・図形フレーム（長方形・楕円・多角形・線）への
     コメント登録・編集・削除（1回のUndoで戻せる）
  2. PDF書き出し（単ページ強制・プリセット選択・ページ範囲選択）
     ページ範囲はサムネイル＋ページ名の一覧からも選べる（v1.3.0）
  3. コメントを付箋／テキストハイライト注釈として配置するXFDF生成（Acrobat読み込み用）
  4. PDF/XFDFの一時ファイル→バックアップ→確定というアトミックな書き出し

注意事項:
  - InDesign 2024以降 / ExtendScript(ECMAScript 3準拠) / macOS主対象
  - コメントは TextFrame の insertLabel("com.ppm.indd.pdfComment.records", ...) に保存
  - 他スクリプトのラベルキーには一切触れない
  - PDFプリセット自体は変更しない（見開きプリセットは一時複製で単ページ化）
  - app.pdfExportPreferences の変更は成功・失敗・キャンセルにかかわらず復元
  - プリンターマーク有効時は警告のみ（マーク分の座標補正は行わない）
  - 親ページ（マスター）上のコメントは一覧表示のみでXFDF出力対象外
  - 表セル内テキストは「cell:<セルID>;table:<表ID>;name:<セル名>;story:<ストーリーID>」
    形式のコンテナIDで追跡（旧形式「cell:<id>」も読める。入れ子表は4段まで）
  - テキストレンジへのコメントはあくまで文字範囲コメントとして保存し、
    範囲特定に失敗してもTextFrame全体コメントへ代替・自動変換しない

想定テストケース（別途報告書参照）:
  基本: フレーム/文字範囲コメント追加・編集・削除、反映して閉じる/書き出し、
        選択なし起動、書き出し範囲各種
  文字追跡: 前後への文字追加、対象移動、同一文字列複数、対象削除、オーバーセット化
  InDesign固有: 連結フレーム、表内文字、セル全体、縦組み、アンカー付き、回転、
        ロック、非表示レイヤー、非印刷、ペーストボード、ページサイズ混在、
        セクション番号、親ページ、複数ページにまたがるフレーム
  PDF/XFDF: プリセット選択、見開き→単ページ強制、裁ち落とし、プリンターマーク、
        コメントページのみのページ番号対応、同位置コメント、既存ファイル退避、
        書き出し失敗時のロールバック
============================================================================
*/

(function () {

    // ------------------------------------------------------------------
    // 定数・メタ情報
    // ------------------------------------------------------------------

    var SCRIPT_NAME = "コメント付きPDF書き出し(InDesign)";
    var SCRIPT_VERSION = "1.3.1";
    var COMMENT_DIALOG_OPACITY = 0.97;
    var STORE_KEY = "__inddExportPdfWithCommentsXfdf_v1_0_0__";
    var RUNNING_KEY = STORE_KEY + "running";
    var RUNNING_LOCK_TIMEOUT_MS = 600000;   // これより古い多重起動ロックは無効とみなす
    var STORE_SCHEMA_VERSION = 3;

    // Acrobat連携（XFDF自動読み込み）用の定数
    var ACROBAT_BUNDLE_ID = "com.adobe.Acrobat.Pro";

    var COMMENT_LABEL_KEY = "com.ppm.indd.pdfComment.records";
    var RECORDS_HEADER = "PPM_INDD_PDF_COMMENT_RECORDS_V1";
    var RECORD_SCHEMA_VERSION = 1;

    var CONTEXT_LENGTH = 40;            // 前後文脈の保存文字数（参照元InDesign版と同値）
    var MAX_MEMO_TEXT_LENGTH = 8000;
    var MAX_RANGE_TEXT_LENGTH = 500;
    var MAX_NESTED_TABLE_DEPTH = 4;     // 表セル探索で辿る入れ子表の深さ

    var DEFAULT_ANNOT_WIDTH = 18;       // 付箋注釈の矩形サイズ(pt)
    var DEFAULT_ANNOT_HEIGHT = 18;
    var ANNOTATION_OFFSET_PT = 8;       // 同位置コメントのずらし量(pt)
    var ANNOTATION_OFFSET_COLUMNS = 4;
    var ANNOTATION_MAX_OFFSET_TRIES = 256;

    // Acrobatの文字選択コメントに合わせるテキストハイライト設定
    var TEXT_MARKUP_OPACITY = 0.4;
    var TEXT_MARKUP_RECT_PADDING_PT = 0.48;
    var TEXT_MARKUP_MIN_ASCENT_RATIO = 0.85;
    var TEXT_MARKUP_MIN_DESCENT_RATIO = 0.25;
    var TEXT_MARKUP_BASELINE_TOLERANCE_PT = 1.25;
    var TEXT_MARKUP_METRIC_TOLERANCE_PT = 2;
    var TEXT_MARKUP_DIRECTION_TOLERANCE = 0.998;

    // 文字座標の取得に失敗した場合にTextFrameの既定位置へ代替配置するか（安全側=false）
    var ALLOW_FRAME_FALLBACK_ON_COORD_FAIL = false;

    var STATUS_OK = "正常";
    var STATUS_TEXT_CHANGED = "対象文字変更";
    var STATUS_RANGE_UNKNOWN = "対象範囲不明";
    var STATUS_AMBIGUOUS = "複数候補";
    var STATUS_OVERSET = "オーバーセット";
    var STATUS_OFF_PAGE = "ページ外";
    var STATUS_HIDDEN = "非表示";
    var STATUS_HIDDEN_LAYER = "非表示レイヤー";
    var STATUS_NON_PRINTING = "非印刷";
    var STATUS_COORD_FAILED = "座標取得失敗";
    var STATUS_MASTER = "親ページ";
    var STATUS_INVALID = "無効";
    var STATUS_LOCKED = "ロック";
    var STATUS_OUT_OF_RANGE = "範囲外ページ";

    var EXPORT_RANGE_ALL = "ドキュメント全体";
    var EXPORT_RANGE_COMMENT_PAGES = "コメントのあるページのみ";
    var EXPORT_RANGE_CURRENT_PAGE = "現在のページ";
    var EXPORT_RANGE_CURRENT_SPREAD = "現在のスプレッド";
    var EXPORT_RANGE_CUSTOM = "指定ページ範囲";

    // ページ選択（サムネイル一覧）。1画面ぶんだけ書き出すので件数が重さの上限になる
    var PAGE_PICKER_COLUMNS = 5;
    var PAGE_PICKER_ROWS = 2;
    var PAGE_THUMB_BOX_PX = 120;        // サムネイルの最大辺(px)。等倍で描く
    var PAGE_THUMB_CELL_PADDING = 5;    // 枠とサムネイルの間隔
    var PAGE_THUMB_MIN_PPI = 1;
    var PAGE_THUMB_MAX_PPI = 72;        // 小さいページでも書き出しを重くしない
    var PAGE_PICKER_OPACITY = 0.97;
    var PAGE_PICKER_MARGINS = 14;
    var PAGE_PICKER_SPACING = 10;
    var PAGE_PICKER_GRID_MARGINS = [8, 12, 8, 12];
    var PAGE_PICKER_GRID_ROW_SPACING = 8;
    var PAGE_PICKER_GRID_COLUMN_SPACING = 8;
    var PAGE_PICKER_BUTTON_MARGINS = [10, 5, 10, 10];
    var PAGE_PICKER_BUTTON_WIDTH = 80;
    var PAGE_PICKER_MAIN_BUTTON_WIDTH = 100;
    var PAGE_PICKER_BUTTON_HEIGHT = 25;
    var PAGE_PICKER_ROW_SPACING = 6;

    function getExportRangeNames() {
        return [
            EXPORT_RANGE_ALL,
            EXPORT_RANGE_COMMENT_PAGES,
            EXPORT_RANGE_CURRENT_PAGE,
            EXPORT_RANGE_CURRENT_SPREAD,
            EXPORT_RANGE_CUSTOM
        ];
    }

    function getColorOptions() {
        return [
            { key: "red", label: "赤", hex: "#FF0000" },
            { key: "yellow", label: "黄", hex: "#FFFF00" },
            { key: "blue", label: "青", hex: "#0000FF" },
            { key: "green", label: "緑", hex: "#00A000" },
            { key: "orange", label: "オレンジ", hex: "#FF8000" },
            { key: "purple", label: "紫", hex: "#800080" },
            { key: "gray", label: "グレー", hex: "#808080" }
        ];
    }

    function getPositionOptions() {
        return [
            { key: "auto", label: "自動" },
            { key: "topLeft", label: "左上" },
            { key: "topCenter", label: "上中央" },
            { key: "topRight", label: "右上" },
            { key: "middleLeft", label: "左中央" },
            { key: "center", label: "中央" },
            { key: "middleRight", label: "右中央" },
            { key: "bottomLeft", label: "左下" },
            { key: "bottomCenter", label: "下中央" },
            { key: "bottomRight", label: "右下" }
        ];
    }

    function findOptionByKey(options, key) {
        var i;
        for (i = 0; i < options.length; i++) {
            if (options[i].key === key) return options[i];
        }
        return null;
    }

    function findOptionByLabel(options, label) {
        var i;
        for (i = 0; i < options.length; i++) {
            if (options[i].label === label) return options[i];
        }
        return null;
    }

    function colorKeyToHex(key) {
        var found = findOptionByKey(getColorOptions(), key);
        return found ? found.hex : "#FF0000";
    }

    function colorKeyToLabel(key) {
        var found = findOptionByKey(getColorOptions(), key);
        return found ? found.label : "";
    }

    function positionKeyToLabel(key) {
        var found = findOptionByKey(getPositionOptions(), key);
        return found ? found.label : "";
    }

    // ------------------------------------------------------------------
    // セッション設定（$.global に保持。InDesign終了まで有効）
    // ------------------------------------------------------------------

    function makeDefaultStore() {
        return {
            schemaVersion: STORE_SCHEMA_VERSION,
            outputFolderPath: "",
            pdfPreset: "",
            exportRange: EXPORT_RANGE_COMMENT_PAGES,
            customPageRange: "",
            author: "InDesign",
            subject: "校正コメント",
            defaultColorKey: "red",
            defaultPositionKey: "topLeft",
            includeLocked: true,
            includeHidden: false,
            includeHiddenLayers: false,
            includeNonPrinting: false,
            includeTargetText: false,
            includePageName: false,
            importXfdf: true,
            saveInAcrobat: true,
            acrobatSavePrefix: "コメント_",
            openPdf: true,
            confirmOverwrite: true,
            showPageThumbnails: true,
            editorDialogLocation: null,
            exportDialogLocation: null,
            pagePickerLocation: null
        };
    }

    function migrateStoredSettings(source) {
        var defaults = makeDefaultStore();
        var result = {};
        var key;
        for (key in defaults) {
            if (!defaults.hasOwnProperty(key)) continue;
            if (key === "schemaVersion") {
                result[key] = STORE_SCHEMA_VERSION;
            } else if (key === "editorDialogLocation" || key === "exportDialogLocation" ||
                    key === "pagePickerLocation") {
                result[key] = source && source[key] && source[key].length === 2 ?
                    [source[key][0], source[key][1]] : null;
            } else if (source && source[key] !== undefined) {
                result[key] = source[key];
            } else {
                result[key] = defaults[key];
            }
        }
        if (!findOptionByKey(getColorOptions(), result.defaultColorKey)) {
            result.defaultColorKey = defaults.defaultColorKey;
        }
        if (!findOptionByKey(getPositionOptions(), result.defaultPositionKey)) {
            result.defaultPositionKey = defaults.defaultPositionKey;
        }
        // 旧スキーマからの移行時は既定位置を新しい初期値（左上）へリセットする
        if (!source || source.schemaVersion !== STORE_SCHEMA_VERSION) {
            result.defaultPositionKey = defaults.defaultPositionKey;
        }
        return result;
    }

    function ensureStore() {
        if (!$.global[STORE_KEY]) {
            $.global[STORE_KEY] = makeDefaultStore();
        } else {
            try {
                $.global[STORE_KEY] = migrateStoredSettings($.global[STORE_KEY]);
            } catch (eMigrate) {
                $.global[STORE_KEY] = makeDefaultStore();
            }
        }
        return $.global[STORE_KEY];
    }

    // ------------------------------------------------------------------
    // 汎用ユーティリティ
    // ------------------------------------------------------------------

    function safeString(value) {
        if (value === null || value === undefined) return "";
        try {
            return String(value);
        } catch (e) {
            return "";
        }
    }

    function trim(value) {
        return safeString(value).replace(/^\s+|\s+$/g, "");
    }

    function isFiniteNumber(value) {
        return typeof value === "number" && isFinite(value) && !isNaN(value);
    }

    function clamp(value, minimum, maximum) {
        if (value < minimum) return minimum;
        if (value > maximum) return maximum;
        return value;
    }

    function padZero(value, digits) {
        var text = String(Math.abs(Math.floor(value)));
        while (text.length < digits) text = "0" + text;
        return text;
    }

    function nowIsoLocalString() {
        var d = new Date();
        return d.getFullYear() + "-" + padZero(d.getMonth() + 1, 2) + "-" + padZero(d.getDate(), 2) +
            " " + padZero(d.getHours(), 2) + ":" + padZero(d.getMinutes(), 2) + ":" + padZero(d.getSeconds(), 2);
    }

    function formatXfdfDateFromDate(d) {
        var offsetMinutes = -d.getTimezoneOffset();
        var sign = offsetMinutes >= 0 ? "+" : "-";
        var absOffset = Math.abs(offsetMinutes);
        return "D:" + d.getFullYear() + padZero(d.getMonth() + 1, 2) + padZero(d.getDate(), 2) +
            padZero(d.getHours(), 2) + padZero(d.getMinutes(), 2) + padZero(d.getSeconds(), 2) +
            sign + padZero(Math.floor(absOffset / 60), 2) + "'" + padZero(absOffset % 60, 2) + "'";
    }

    function isoLocalToXfdfDate(isoText) {
        var m = safeString(isoText).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
        var d;
        if (!m) return formatXfdfDateFromDate(new Date());
        d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
        return formatXfdfDateFromDate(d);
    }

    function makeUniqueToken() {
        return (new Date()).getTime() + "_" + Math.floor(Math.random() * 1000000);
    }

    function makeCommentRecordId() {
        return "comment_" + makeUniqueToken();
    }

    function limitTextLength(text, maxLength) {
        var s = safeString(text);
        var marker = "...[省略]";
        if (!maxLength || s.length <= maxLength) return s;
        if (maxLength <= marker.length) return s.substring(0, maxLength);
        return s.substring(0, maxLength - marker.length) + marker;
    }

    function replaceAllText(text, fromText, toText) {
        return safeString(text).split(fromText).join(toText);
    }

    function shortenMiddle(value, maximumLength) {
        var text = safeString(value);
        var leftLength;
        var rightLength;
        if (text.length <= maximumLength) return text;
        leftLength = Math.ceil((maximumLength - 1) / 2);
        rightLength = Math.floor((maximumLength - 1) / 2);
        return text.substring(0, leftLength) + "…" + text.substring(text.length - rightLength);
    }

    function makeListText(value, maximumLength) {
        var text = safeString(value).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ");
        return shortenMiddle(trim(text), maximumLength);
    }

    function getSelectedListIndices(listBox) {
        var selection = listBox ? listBox.selection : null;
        var indices = [];
        var i;
        if (!selection) return indices;
        if (selection instanceof Array || (selection.length !== undefined && selection.index === undefined)) {
            for (i = 0; i < selection.length; i++) indices.push(selection[i].index);
        } else {
            indices.push(selection.index);
        }
        indices.sort(function (a, b) { return b - a; });
        return indices;
    }

    function selectDropdownByText(dropdown, value, fallbackIndex) {
        var i;
        for (i = 0; i < dropdown.items.length; i++) {
            if (dropdown.items[i].text === value) {
                dropdown.selection = i;
                return;
            }
        }
        if (dropdown.items.length > 0) {
            dropdown.selection = clamp(fallbackIndex || 0, 0, dropdown.items.length - 1);
        }
    }

    function getObjectTypeName(obj) {
        var typeName = "";
        if (!obj) return "";
        try {
            typeName = safeString(obj.constructor.name);
        } catch (eConstructor) {
            typeName = "";
        }
        if (typeName !== "") return typeName;
        try {
            typeName = safeString(obj.reflect.name);
        } catch (eReflect) {
            typeName = "";
        }
        return typeName;
    }

    function isValidDomObject(obj) {
        if (!obj) return false;
        try {
            return obj.isValid === true;
        } catch (e) {
            return false;
        }
    }

    function getObjectIdString(obj) {
        try {
            return safeString(obj.id);
        } catch (e) {
            return "";
        }
    }

    function restoreDialogPosition(dlg, store, keyName) {
        var pos = store ? store[keyName] : null;
        if (!pos || pos.length !== 2) return;
        try {
            dlg.location = [pos[0], pos[1]];
        } catch (e) {}
    }

    function saveDialogPosition(dlg, store, keyName) {
        try {
            if (dlg.location && typeof dlg.location[0] === "number") {
                store[keyName] = [dlg.location[0], dlg.location[1]];
            }
        } catch (e) {}
    }

    // ------------------------------------------------------------------
    // 文字列・XML処理（Illustrator版から移植）
    // ------------------------------------------------------------------

    function sanitizeXmlText(value) {
        var text = safeString(value);
        var result = "";
        var i;
        var code;
        var nextCode;
        for (i = 0; i < text.length; i++) {
            code = text.charCodeAt(i);
            if (code === 0x09 || code === 0x0A || code === 0x0D || code >= 0x20) {
                if (code >= 0xD800 && code <= 0xDBFF) {
                    if (i + 1 < text.length) {
                        nextCode = text.charCodeAt(i + 1);
                        if (nextCode >= 0xDC00 && nextCode <= 0xDFFF) {
                            result += text.charAt(i) + text.charAt(i + 1);
                            i++;
                        }
                    }
                } else if (code < 0xDC00 || code > 0xDFFF) {
                    result += text.charAt(i);
                }
            }
        }
        return result;
    }

    function escapeXml(value) {
        return sanitizeXmlText(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&apos;");
    }

    function encodeUtf8Binary(value) {
        var text = safeString(value);
        var output = "";
        var i;
        var code;
        var nextCode;
        var codePoint;
        for (i = 0; i < text.length; i++) {
            code = text.charCodeAt(i);
            if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
                nextCode = text.charCodeAt(i + 1);
                if (nextCode >= 0xDC00 && nextCode <= 0xDFFF) {
                    codePoint = 0x10000 + ((code - 0xD800) << 10) + (nextCode - 0xDC00);
                    output += String.fromCharCode(0xF0 | (codePoint >> 18));
                    output += String.fromCharCode(0x80 | ((codePoint >> 12) & 0x3F));
                    output += String.fromCharCode(0x80 | ((codePoint >> 6) & 0x3F));
                    output += String.fromCharCode(0x80 | (codePoint & 0x3F));
                    i++;
                    continue;
                }
            }
            if (code < 0x80) {
                output += String.fromCharCode(code);
            } else if (code < 0x800) {
                output += String.fromCharCode(0xC0 | (code >> 6));
                output += String.fromCharCode(0x80 | (code & 0x3F));
            } else {
                output += String.fromCharCode(0xE0 | (code >> 12));
                output += String.fromCharCode(0x80 | ((code >> 6) & 0x3F));
                output += String.fromCharCode(0x80 | (code & 0x3F));
            }
        }
        return output;
    }

    function writeUtf8File(fileRef, text) {
        var opened = false;
        try {
            fileRef.encoding = "BINARY";
            opened = fileRef.open("w");
            if (!opened) throw new Error(fileRef.error || "ファイルを開けません。");
            if (!fileRef.write(encodeUtf8Binary(text))) throw new Error(fileRef.error || "ファイルを書き込めません。");
            if (!fileRef.close()) throw new Error(fileRef.error || "ファイルを閉じられません。");
            return true;
        } catch (e) {
            try { if (opened) fileRef.close(); } catch (eClose) {}
            throw e;
        }
    }

    // File.name は URIエンコードされた名前を返すため、日本語などを含むと
    // 「%E5%AE%B6...」という文字列になる。XFDFの <f href> にそのまま入れると
    // Acrobatがそれをリテラルなファイル名として探し、元PDFを見つけられない。
    // そのため fsName（実際のパス）から本来のファイル名を取り出す。
    function getFileBaseName(fileRef) {
        var path;
        var index;
        if (!fileRef) return "";
        path = safeString(fileRef.fsName);
        index = path.lastIndexOf("/");
        if (index < 0) index = path.lastIndexOf("\\");
        if (index >= 0) path = path.substring(index + 1);
        if (path) return path;
        try {
            return safeString(decodeURI(fileRef.name));
        } catch (eDecode) {
            return safeString(fileRef.name);
        }
    }

    function removeFileExtension(name) {
        var value = safeString(name);
        var index = value.lastIndexOf(".");
        if (index > 0) return value.substring(0, index);
        return value;
    }

    function sanitizeFileBaseName(value) {
        var name = safeString(value);
        name = name.replace(/\.(pdf|xfdf)$/i, "");
        name = name.replace(/[\\\/:*?"<>|]/g, "_");
        name = name.replace(/[\u0000-\u001F]/g, "_");
        name = name.replace(/^[\. \t　]+/, "");
        name = name.replace(/[\. \t　]+$/, "");
        name = name.replace(/[ \t　]{2,}/g, " ");
        if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) name = "_" + name;
        if (name.length > 180) name = name.substring(0, 180);
        return name;
    }

    function sanitizeFilePrefix(value) {
        var prefix = safeString(value);
        prefix = prefix.replace(/[\\\/:*?"<>|]/g, "_");
        prefix = prefix.replace(/[\u0000-\u001F]/g, "_");
        prefix = prefix.replace(/^[\. \t　]+/, "");
        prefix = prefix.replace(/[\. \t　]+$/, "");
        prefix = prefix.replace(/[ \t　]{2,}/g, " ");
        if (prefix.length > 60) prefix = prefix.substring(0, 60);
        return prefix;
    }

    function normalizeMemoText(value) {
        var text = safeString(value);
        text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        return text;
    }

    // ------------------------------------------------------------------
    // コメントレコードのシリアライズ
    // （参照元InDesign版の key=value + %エスケープ方式を移植・拡張）
    // ------------------------------------------------------------------

    function encodeRecordValue(value) {
        var s = safeString(value);
        s = s.replace(/%/g, "%25");
        s = s.replace(/\r/g, "%0D");
        s = s.replace(/\n/g, "%0A");
        s = replaceAllText(s, "=", "%3D");
        return s;
    }

    function decodeRecordValue(value) {
        var s = safeString(value);
        s = replaceAllText(s, "%3D", "=");
        s = s.replace(/%0A/g, "\n");
        s = s.replace(/%0D/g, "\r");
        s = s.replace(/%25/g, "%");
        return s;
    }

    function createCommentRecord() {
        return {
            id: makeCommentRecordId(),
            schemaVersion: String(RECORD_SCHEMA_VERSION),
            memo: "",
            targetType: "textFrame",
            rangeText: "",
            rangeStart: "",
            rangeLength: "",
            rangePrefix: "",
            rangeSuffix: "",
            rangeStoryId: "",
            enabled: "1",
            color: "",
            position: "",
            createdAt: nowIsoLocalString(),
            updatedAt: nowIsoLocalString()
        };
    }

    function normalizeCommentRecord(record) {
        var defaults = createCommentRecord();
        var key;
        for (key in defaults) {
            if (!defaults.hasOwnProperty(key)) continue;
            if (record[key] === undefined || record[key] === null) {
                record[key] = defaults[key];
            } else {
                record[key] = safeString(record[key]);
            }
        }
        if (!record.id) record.id = makeCommentRecordId();
        record.memo = limitTextLength(normalizeMemoText(record.memo), MAX_MEMO_TEXT_LENGTH);
        record.rangeText = limitTextLength(record.rangeText, MAX_RANGE_TEXT_LENGTH);
        if (record.targetType !== "textRange" && record.targetType !== "pageItem") {
            record.targetType = "textFrame";
        }
        // 範囲情報が壊れたtextRangeレコードはTextFrame全体コメントへ自動変換しない
        // （再特定処理で「無効」となり、出力対象から除外されるだけに留める）
        if (record.enabled !== "0") record.enabled = "1";
        if (record.color !== "" && !findOptionByKey(getColorOptions(), record.color)) {
            record.color = "";
        }
        if (record.position !== "" && !findOptionByKey(getPositionOptions(), record.position)) {
            record.position = "";
        }
        return record;
    }

    function cloneCommentRecord(record) {
        var result = {};
        var key;
        for (key in record) {
            if (record.hasOwnProperty(key)) result[key] = record[key];
        }
        return normalizeCommentRecord(result);
    }

    function cloneCommentRecordList(records) {
        var result = [];
        var i;
        for (i = 0; i < records.length; i++) result.push(cloneCommentRecord(records[i]));
        return result;
    }

    function serializeCommentRecords(records) {
        var lines = [RECORDS_HEADER];
        var i;
        var record;
        var fields = [
            "id", "schemaVersion", "memo", "targetType",
            "rangeText", "rangeStart", "rangeLength", "rangePrefix", "rangeSuffix", "rangeStoryId",
            "enabled", "color", "position", "createdAt", "updatedAt"
        ];
        var j;
        for (i = 0; i < records.length; i++) {
            record = records[i];
            if (!record || trim(record.memo) === "") continue;
            lines.push("---");
            for (j = 0; j < fields.length; j++) {
                lines.push(fields[j] + "=" + encodeRecordValue(record[fields[j]]));
            }
        }
        if (lines.length === 1) return "";
        return lines.join("\n");
    }

    function deserializeCommentRecords(text) {
        var source = safeString(text);
        var lines;
        var records = [];
        var record = null;
        var i;
        var line;
        var eq;
        var key;
        var value;
        if (source.indexOf(RECORDS_HEADER) !== 0) return records;
        lines = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        for (i = 1; i < lines.length; i++) {
            line = lines[i];
            if (line === "---") {
                if (record && trim(record.memo) !== "") {
                    records.push(normalizeCommentRecord(record));
                }
                record = createCommentRecord();
                record.memo = "";
                continue;
            }
            if (!record) continue;
            eq = line.indexOf("=");
            if (eq < 0) continue;
            key = line.substring(0, eq);
            value = decodeRecordValue(line.substring(eq + 1));
            if (record[key] !== undefined) record[key] = value;
        }
        if (record && trim(record.memo) !== "") {
            records.push(normalizeCommentRecord(record));
        }
        return records;
    }

    // ------------------------------------------------------------------
    // ラベル読み書き（専用キーのみを操作。他のラベルには触れない）
    // ------------------------------------------------------------------

    function getCommentRecordsFromTarget(frame) {
        var raw = "";
        if (!isValidDomObject(frame)) return [];
        try {
            raw = safeString(frame.extractLabel(COMMENT_LABEL_KEY));
        } catch (e) {
            return [];
        }
        try {
            return deserializeCommentRecords(raw);
        } catch (eParse) {
            return [];
        }
    }

    function saveCommentRecordsToTarget(frame, records) {
        if (!isValidDomObject(frame)) return false;
        try {
            frame.insertLabel(COMMENT_LABEL_KEY, serializeCommentRecords(records));
            return true;
        } catch (e) {
            return false;
        }
    }

    function saveCommentRecordsWithUndo(operations, undoLabel) {
        // operations: [{frame, records}] を1回のUndoでまとめて保存する
        var errorHolder = { error: null };
        try {
            app.doScript(
                function () {
                    var i;
                    for (i = 0; i < operations.length; i++) {
                        if (!saveCommentRecordsToTarget(operations[i].frame, operations[i].records)) {
                            errorHolder.error = "コメントを保存できないTextFrameがありました。";
                        }
                    }
                },
                ScriptLanguage.JAVASCRIPT,
                undefined,
                UndoModes.ENTIRE_SCRIPT,
                undoLabel || "PDFコメントを編集"
            );
        } catch (eDoScript) {
            errorHolder.error = safeString(eDoScript.message || eDoScript);
        }
        return errorHolder.error;
    }

    // ------------------------------------------------------------------
    // テキストコンテナ抽象化（Story / 表Cell）
    // 表セル内テキストは文字インデックスがセル基準のため、コンテナ単位で扱う
    // ------------------------------------------------------------------

    function getTextContainerFromTextObject(item, frame) {
        var parentObj;
        var guard = 0;
        var cellStory;
        try {
            parentObj = item.parent;
            while (parentObj && guard < 12) {
                guard++;
                if (getObjectTypeName(parentObj) === "Cell") {
                    cellStory = null;
                    try { cellStory = item.parentStory; } catch (eCellStory) { cellStory = null; }
                    if (!cellStory) {
                        try { cellStory = frame.parentStory; } catch (eFrameCellStory) { cellStory = null; }
                    }
                    return { kind: "cell", obj: parentObj, story: cellStory };
                }
                if (getObjectTypeName(parentObj) === "Story" || getObjectTypeName(parentObj) === "Document") {
                    break;
                }
                parentObj = parentObj.parent;
            }
        } catch (eWalk) {}
        try {
            if (item && item.parentStory) return { kind: "story", obj: item.parentStory };
        } catch (eItemStory) {}
        try {
            if (frame && frame.parentStory) return { kind: "story", obj: frame.parentStory };
        } catch (eFrameStory) {}
        return null;
    }

    function getContainerIdString(container) {
        if (!container) return "";
        if (container.kind === "cell") return makeCellContainerIdString(container.obj, container.story);
        return getObjectIdString(container.obj);
    }

    function getContainerText(container) {
        if (!container) return "";
        try {
            return safeString(container.obj.contents);
        } catch (e) {
            return "";
        }
    }

    // ------------------------------------------------------------------
    // 表セルの識別
    // 形式: cell:<セルID>;table:<表ID>;name:<セル名>;story:<ストーリーID>
    // セルIDは表をまたいで重複しうるため、表ID＋セル名（"列:行"）を第一の手がかりにする。
    // 旧形式 cell:<セルID> も読める
    // ------------------------------------------------------------------

    function isCellContainerIdString(idText) {
        return trim(idText).indexOf("cell:") === 0;
    }

    function getParentTableOfCell(cell) {
        var parentObj = null;
        var rowRef = null;
        var typeName;
        try { parentObj = cell.parent; } catch (eParent) { parentObj = null; }
        typeName = getObjectTypeName(parentObj);
        if (typeName === "Table") return parentObj;
        if (typeName === "Row" || typeName === "Column") {
            try { parentObj = parentObj.parent; } catch (eRowParent) { parentObj = null; }
            if (getObjectTypeName(parentObj) === "Table") return parentObj;
        }
        // タグ付き表などで親がXMLElementになる場合は行から表を辿る
        try { rowRef = cell.parentRow; } catch (eRow) { rowRef = null; }
        if (!rowRef) return null;
        try { parentObj = rowRef.parent; } catch (eRowTable) { parentObj = null; }
        if (getObjectTypeName(parentObj) === "Table") return parentObj;
        return null;
    }

    function makeCellContainerIdString(cell, story) {
        var parts = ["cell:" + getObjectIdString(cell)];
        var tableRef = getParentTableOfCell(cell);
        var cellName = "";
        var storyIdText = "";
        if (tableRef) parts.push("table:" + getObjectIdString(tableRef));
        try { cellName = safeString(cell.name); } catch (eName) { cellName = ""; }
        if (cellName !== "") parts.push("name:" + cellName);
        if (story) storyIdText = getObjectIdString(story);
        if (storyIdText !== "") parts.push("story:" + storyIdText);
        return parts.join(";");
    }

    function parseCellContainerIdString(idText) {
        var result = { cellId: "", tableId: "", name: "", storyId: "" };
        var parts = trim(idText).split(";");
        var i;
        var part;
        var colon;
        var key;
        var value;
        for (i = 0; i < parts.length; i++) {
            part = trim(parts[i]);
            colon = part.indexOf(":");
            if (colon <= 0) continue;
            key = part.substring(0, colon);
            value = trim(part.substring(colon + 1));
            if (key === "cell") result.cellId = value;
            else if (key === "table") result.tableId = value;
            else if (key === "name") result.name = value;
            else if (key === "story") result.storyId = value;
        }
        return result;
    }

    function getValidCellOrNull(cellRef) {
        var valid = false;
        if (!cellRef) return null;
        try { valid = cellRef.isValid === true; } catch (eValid) { valid = false; }
        return valid ? cellRef : null;
    }

    function getCollectionElements(collection) {
        var items = [];
        var count = 0;
        var i;
        var itemRef;
        if (!collection) return items;
        try { count = Number(collection.length); } catch (eLength) { count = 0; }
        if (!isFiniteNumber(count) || count <= 0) return items;
        try { items = collection.everyItem().getElements(); } catch (eEvery) { items = null; }
        if (items && items.length === count) return items;
        items = [];
        for (i = 0; i < count; i++) {
            itemRef = null;
            try { itemRef = collection[i]; } catch (eItem) { itemRef = null; }
            if (itemRef) items.push(itemRef);
        }
        return items;
    }

    function getTableCellElements(tableRef) {
        var cells = null;
        try { cells = tableRef.cells; } catch (eCells) { cells = null; }
        return getCollectionElements(cells);
    }

    // ストーリー内の表を浅い順に列挙する（includeNested=true で入れ子の表も含む）
    function collectTablesInStory(story, includeNested) {
        var result = [];
        var queue = [];
        var head = 0;
        var storyTables = null;
        var tables;
        var current;
        var cells;
        var innerTables;
        var innerElements;
        var i;
        var j;
        if (!story) return result;
        try { storyTables = story.tables; } catch (eTables) { storyTables = null; }
        tables = getCollectionElements(storyTables);
        for (i = 0; i < tables.length; i++) queue.push({ table: tables[i], depth: 0 });
        while (head < queue.length) {
            current = queue[head];
            head++;
            result.push(current.table);
            if (includeNested !== true || current.depth >= MAX_NESTED_TABLE_DEPTH) continue;
            cells = getTableCellElements(current.table);
            for (i = 0; i < cells.length; i++) {
                innerTables = null;
                try { innerTables = cells[i].tables; } catch (eInner) { innerTables = null; }
                innerElements = getCollectionElements(innerTables);
                for (j = 0; j < innerElements.length; j++) {
                    queue.push({ table: innerElements[j], depth: current.depth + 1 });
                }
            }
        }
        return result;
    }

    function findTableByIdInList(tables, tableIdText) {
        var i;
        for (i = 0; i < tables.length; i++) {
            if (getObjectIdString(tables[i]) === String(tableIdText)) return tables[i];
        }
        return null;
    }

    function findTableByIdInStory(story, tableIdText) {
        var found = findTableByIdInList(collectTablesInStory(story, false), tableIdText);
        if (found) return found;
        return findTableByIdInList(collectTablesInStory(story, true), tableIdText);
    }

    function getCellByName(tableRef, cellName) {
        var cellRef = null;
        if (!tableRef || cellName === "") return null;
        try { cellRef = tableRef.cells.itemByName(cellName); } catch (eByName) { cellRef = null; }
        return getValidCellOrNull(cellRef);
    }

    function getCellById(tableRef, cellIdText) {
        var cellRef = null;
        var idNumber = parseInt(cellIdText, 10);
        if (!tableRef || isNaN(idNumber)) return null;
        try { cellRef = tableRef.cells.itemByID(idNumber); } catch (eById) { cellRef = null; }
        return getValidCellOrNull(cellRef);
    }

    function getStoryForCellRecord(documentRef, frame, storyIdText) {
        var storyId = parseInt(storyIdText, 10);
        var story = null;
        if (!isNaN(storyId)) {
            try { story = documentRef.stories.itemByID(storyId); } catch (eById) { story = null; }
            if (isValidDomObject(story)) return story;
        }
        story = null;
        try { story = frame.parentStory; } catch (eFrameStory) { story = null; }
        if (isValidDomObject(story)) return story;
        return null;
    }

    // 記録したセルの候補を返す: { story, cells: [Cell], byName: Boolean }
    function findRecordedCells(documentRef, frame, idText) {
        var key = parseCellContainerIdString(idText);
        var result = { story: null, cells: [], byName: false };
        var tableRef = null;
        var cellRef;
        var tables;
        var i;
        result.story = getStoryForCellRecord(documentRef, frame, key.storyId);
        if (!result.story) return result;
        if (key.tableId !== "") {
            tableRef = findTableByIdInStory(result.story, key.tableId);
        }
        if (tableRef) {
            cellRef = getCellByName(tableRef, key.name);
            if (cellRef) {
                result.cells.push(cellRef);
                result.byName = true;
                return result;
            }
            cellRef = getCellById(tableRef, key.cellId);
            if (cellRef) {
                result.cells.push(cellRef);
                return result;
            }
        }
        // 旧形式（セルIDのみ）: 同じIDのセルが複数の表にありうるため全候補を返す
        if (key.cellId !== "") {
            tables = collectTablesInStory(result.story, true);
            for (i = 0; i < tables.length; i++) {
                cellRef = getCellById(tables[i], key.cellId);
                if (cellRef) result.cells.push(cellRef);
            }
        }
        return result;
    }

    function findContainerForRecord(documentRef, frame, storyIdText) {
        var idText = trim(storyIdText);
        var story;
        var storyId;
        storyId = parseInt(idText, 10);
        if (!isNaN(storyId)) {
            try {
                story = documentRef.stories.itemByID(storyId);
                if (isValidDomObject(story)) return { kind: "story", obj: story };
            } catch (eById) {}
        }
        // Story IDが無効な場合は保存先フレームのStoryで再探索を試みる
        story = null;
        try { story = frame ? frame.parentStory : null; } catch (eFallback) { story = null; }
        if (isValidDomObject(story)) return { kind: "story", obj: story, fallback: true };
        return null;
    }

    function getContainerTextRange(container, startIndex, lengthValue) {
        var endIndex = startIndex + lengthValue - 1;
        if (!container || startIndex < 0 || lengthValue <= 0) return null;
        try {
            if (container.obj.characters.length <= endIndex) return null;
            return container.obj.characters.itemByRange(startIndex, endIndex);
        } catch (e) {
            return null;
        }
    }

    function getContainerBaseIndex(container) {
        var baseIndex = -1;
        try { baseIndex = Number(container.obj.insertionPoints[0].index); } catch (eBase) { baseIndex = -1; }
        return isFiniteNumber(baseIndex) ? baseIndex : -1;
    }

    function getContainerFirstCharacter(container, startIndex) {
        try {
            if (startIndex < 0 || container.obj.characters.length <= startIndex) return null;
            return container.obj.characters.item(startIndex);
        } catch (e) {
            return null;
        }
    }

    // ------------------------------------------------------------------
    // 選択対象の正規化
    // ------------------------------------------------------------------

    function isTextLikeTypeName(typeName) {
        return typeName === "Text" ||
            typeName === "TextColumn" ||
            typeName === "Word" ||
            typeName === "Line" ||
            typeName === "Paragraph" ||
            typeName === "Character" ||
            typeName === "TextStyleRange" ||
            typeName === "InsertionPoint";
    }

    // 図形フレーム（画像フレームを含む）の型判定
    function isGraphicFrameTypeName(typeName) {
        return typeName === "Rectangle" ||
            typeName === "Oval" ||
            typeName === "Polygon" ||
            typeName === "GraphicLine" ||
            typeName === "SplineItem";
    }

    // フレーム内のグラフィック（ダイレクト選択時）の型判定
    function isGraphicContentTypeName(typeName) {
        return typeName === "Image" ||
            typeName === "EPS" ||
            typeName === "PDF" ||
            typeName === "WMF" ||
            typeName === "PICT" ||
            typeName === "ImportedPage" ||
            typeName === "EPSText" ||
            typeName === "Graphic";
    }

    function getPageItemTypeLabel(typeName) {
        if (typeName === "Rectangle") return "長方形";
        if (typeName === "Oval") return "楕円";
        if (typeName === "Polygon") return "多角形";
        if (typeName === "GraphicLine") return "線";
        if (typeName === "TextFrame") return "テキストフレーム";
        return typeName !== "" ? typeName : "オブジェクト";
    }

    function getGraphicLinkName(item) {
        var graphic;
        try {
            if (item.graphics && item.graphics.length > 0) {
                graphic = item.graphics[0];
                try {
                    if (graphic.itemLink && graphic.itemLink.isValid) {
                        return safeString(graphic.itemLink.name);
                    }
                } catch (eLink) {}
                return getObjectTypeName(graphic);
            }
        } catch (eGraphics) {}
        return "";
    }

    // 一覧・プレビュー用の対象表示ラベル（テキスト／画像／図形を判別）
    function getPageItemDisplayLabel(item) {
        var typeName = getObjectTypeName(item);
        var text = "";
        var linkName;
        var itemName = "";
        if (typeName === "TextFrame") {
            try { text = safeString(item.contents); } catch (eContents) {}
            return "枠: " + makeListText(text, 30);
        }
        linkName = getGraphicLinkName(item);
        if (linkName !== "") return "画像: " + makeListText(linkName, 28);
        try { itemName = safeString(item.name); } catch (eName) {}
        if (trim(itemName) !== "") {
            return getPageItemTypeLabel(typeName) + ": " + makeListText(itemName, 24);
        }
        return getPageItemTypeLabel(typeName);
    }

    function getDisplayFrameFromTextObject(item) {
        var frames;
        try {
            frames = item.parentTextFrames;
            if (frames && frames.length > 0) return frames[0];
        } catch (eFrames) {}
        return null;
    }

    function getFrameFromTextObjectOrStory(item) {
        var frame = getDisplayFrameFromTextObject(item);
        var story;
        if (frame) return frame;
        try {
            story = item.parentStory;
            if (story && story.textContainers && story.textContainers.length > 0) {
                return story.textContainers[0];
            }
        } catch (eStory) {}
        return null;
    }

    function getFrameFromTable(table) {
        var frame = null;
        try {
            if (table.storyOffset && table.storyOffset.parentTextFrames &&
                    table.storyOffset.parentTextFrames.length > 0) {
                frame = table.storyOffset.parentTextFrames[0];
            }
        } catch (eOffset) {}
        if (frame) return frame;
        try {
            if (table.parent && table.parent.textContainers && table.parent.textContainers.length > 0) {
                frame = table.parent.textContainers[0];
            }
        } catch (eParent) {}
        return frame;
    }

    function getTextObjectStartIndex(item) {
        try {
            if (item.insertionPoints && item.insertionPoints.length > 0) {
                return Number(item.insertionPoints[0].index);
            }
        } catch (eInsertion) {}
        try {
            if (typeof item.index !== "undefined") return Number(item.index);
        } catch (eIndex) {}
        return -1;
    }

    function makeRangeContext(text, startIndex, endIndex) {
        var s = safeString(text);
        var start = Math.max(0, startIndex);
        var end = Math.min(s.length, endIndex);
        if (start < 0 || end < start) return "";
        return s.substring(start, end);
    }

    // 文字範囲コメントの保存情報を作成する（参照元InDesign版の機構を移植）
    function buildRangeInfoFromTextObject(item, frame) {
        var container = getTextContainerFromTextObject(item, frame);
        var containerText;
        var selectedText = "";
        var startIndex;
        var lengthValue;
        var baseIndex;
        if (!container) return null;
        try {
            selectedText = safeString(item.contents);
        } catch (eContents) {
            selectedText = "";
        }
        if (selectedText === "") return null;
        containerText = getContainerText(container);
        lengthValue = selectedText.length;
        startIndex = getTextObjectStartIndex(item);
        if (container.kind === "cell" && startIndex >= 0 &&
                containerText.substr(startIndex, lengthValue) !== selectedText) {
            // セル内の文字位置が通し番号で返る場合に備え、セル先頭からの相対位置も試す
            baseIndex = getContainerBaseIndex(container);
            if (baseIndex > 0 && startIndex - baseIndex >= 0 &&
                    containerText.substr(startIndex - baseIndex, lengthValue) === selectedText) {
                startIndex = startIndex - baseIndex;
            }
        }
        if (startIndex < 0 || containerText.substr(startIndex, lengthValue) !== selectedText) {
            startIndex = containerText.indexOf(selectedText);
        }
        if (startIndex < 0) return null;
        return {
            text: limitTextLength(selectedText, MAX_RANGE_TEXT_LENGTH),
            startIndex: startIndex,
            length: lengthValue,
            prefix: makeRangeContext(containerText, startIndex - CONTEXT_LENGTH, startIndex),
            suffix: makeRangeContext(containerText, startIndex + lengthValue, startIndex + lengthValue + CONTEXT_LENGTH),
            storyId: getContainerIdString(container)
        };
    }

    function makeFrameTargetFromFrame(frame) {
        var typeName = getObjectTypeName(frame);
        var preview = "";
        if (typeName === "TextFrame") {
            try {
                preview = safeString(frame.contents);
            } catch (ePreview) {}
            return {
                kind: "textFrame",
                frame: frame,
                rangeInfo: null,
                previewText: limitTextLength(preview, 300)
            };
        }
        // 画像フレーム・図形フレームはオブジェクト全体コメントとして扱う
        return {
            kind: "pageItem",
            frame: frame,
            rangeInfo: null,
            previewText: getPageItemDisplayLabel(frame)
        };
    }

    function makeRangeTargetFromTextObject(item, frame) {
        var rangeInfo = buildRangeInfoFromTextObject(item, frame);
        // 文字範囲を特定できない場合、TextFrame全体コメントへは代替登録しない
        if (!rangeInfo) return null;
        return {
            kind: "textRange",
            frame: frame,
            rangeInfo: rangeInfo,
            previewText: rangeInfo.text
        };
    }

    // app.selection の種類差を吸収して、コメント対象の配列へ正規化する
    function resolveCommentTargets(selectionItems) {
        var result = { targets: [], skippedCount: 0, rangeFailedCount: 0, message: "" };
        var i;
        var item;
        var typeName;
        var frame;
        var cellText;
        var target;
        for (i = 0; i < selectionItems.length; i++) {
            item = selectionItems[i];
            if (!item) continue;
            typeName = getObjectTypeName(item);
            if (typeName === "TextFrame") {
                result.targets.push(makeFrameTargetFromFrame(item));
            } else if (isGraphicFrameTypeName(typeName)) {
                // 画像フレーム・図形フレーム
                result.targets.push(makeFrameTargetFromFrame(item));
            } else if (isGraphicContentTypeName(typeName)) {
                // フレーム内グラフィックのダイレクト選択は親フレームを対象にする
                frame = null;
                try {
                    if (item.parent && isGraphicFrameTypeName(getObjectTypeName(item.parent))) {
                        frame = item.parent;
                    }
                } catch (eGraphicParent) {}
                if (frame) {
                    result.targets.push(makeFrameTargetFromFrame(frame));
                } else {
                    result.skippedCount++;
                }
            } else if (typeName === "InsertionPoint") {
                frame = getFrameFromTextObjectOrStory(item);
                if (frame) {
                    result.targets.push(makeFrameTargetFromFrame(frame));
                } else {
                    result.skippedCount++;
                }
            } else if (isTextLikeTypeName(typeName)) {
                frame = getFrameFromTextObjectOrStory(item);
                if (!frame) {
                    result.skippedCount++;
                    continue;
                }
                target = makeRangeTargetFromTextObject(item, frame);
                if (!target) {
                    result.rangeFailedCount++;
                    continue;
                }
                result.targets.push(target);
            } else if (typeName === "Cell") {
                frame = null;
                cellText = null;
                try {
                    cellText = item.texts.length > 0 ? item.texts[0] : null;
                } catch (eCellTexts) {}
                if (cellText) frame = getFrameFromTextObjectOrStory(cellText);
                if (!frame) {
                    result.skippedCount++;
                    continue;
                }
                if (cellText && trim(safeString(cellText.contents)) !== "") {
                    target = makeRangeTargetFromTextObject(cellText, frame);
                    if (target) {
                        result.targets.push(target);
                    } else {
                        // セル内文字範囲を特定できない場合もフレームへは代替登録しない
                        result.rangeFailedCount++;
                    }
                } else {
                    result.targets.push(makeFrameTargetFromFrame(frame));
                }
            } else if (typeName === "Table") {
                frame = getFrameFromTable(item);
                if (frame) {
                    result.targets.push(makeFrameTargetFromFrame(frame));
                } else {
                    result.skippedCount++;
                }
            } else {
                // グループ全体・ボタン・メディア等は対象外
                result.skippedCount++;
            }
        }
        result.targets = uniqueCommentTargets(result.targets);
        if (result.targets.length === 0) {
            if (result.rangeFailedCount > 0) {
                result.message = "選択した文字範囲を特定できないため、コメントを登録できません。\n" +
                    "複数セルにまたがる選択などは対象外です。範囲を選び直してください。";
            } else if (result.skippedCount > 0) {
                result.message = "選択中にコメント対象（TextFrame／テキスト範囲／表セル／画像・図形フレーム）が見つかりませんでした。\n" +
                    "グループ全体・ボタン・メディアは対象外です。";
            }
        }
        return result;
    }

    function getRangeKey(rangeInfo) {
        if (!rangeInfo) return "";
        return [
            safeString(rangeInfo.text),
            String(rangeInfo.startIndex),
            String(rangeInfo.length),
            safeString(rangeInfo.storyId)
        ].join("\u001F");
    }

    function uniqueCommentTargets(targets) {
        var result = [];
        var i;
        var j;
        var found;
        for (i = 0; i < targets.length; i++) {
            if (!targets[i] || !targets[i].frame) continue;
            found = false;
            for (j = 0; j < result.length; j++) {
                if (result[j].frame === targets[i].frame &&
                        getRangeKey(result[j].rangeInfo) === getRangeKey(targets[i].rangeInfo)) {
                    found = true;
                    break;
                }
            }
            if (!found) result.push(targets[i]);
        }
        return result;
    }

    // ------------------------------------------------------------------
    // 文字範囲の再特定
    // （参照元InDesign版の文脈スコアリングを移植し、一意性判定を追加）
    // ------------------------------------------------------------------

    function recordToRangeInfo(record) {
        if (!record || trim(record.rangeText) === "") return null;
        return {
            text: record.rangeText,
            startIndex: parseInt(record.rangeStart, 10),
            length: parseInt(record.rangeLength, 10),
            prefix: safeString(record.rangePrefix),
            suffix: safeString(record.rangeSuffix),
            storyId: safeString(record.rangeStoryId)
        };
    }

    function scoreRangeContext(containerText, startIndex, info) {
        var score = 0;
        var prefix = safeString(info.prefix);
        var suffix = safeString(info.suffix);
        var actualPrefix;
        var actualSuffix;
        if (prefix !== "") {
            actualPrefix = makeRangeContext(containerText, startIndex - prefix.length, startIndex);
            if (actualPrefix === prefix) {
                score += 2;
            } else if (actualPrefix !== "" && (actualPrefix.indexOf(prefix) >= 0 || prefix.indexOf(actualPrefix) >= 0)) {
                score += 1;
            }
        }
        if (suffix !== "") {
            actualSuffix = makeRangeContext(containerText, startIndex + info.length, startIndex + info.length + suffix.length);
            if (actualSuffix === suffix) {
                score += 2;
            } else if (actualSuffix !== "" && (actualSuffix.indexOf(suffix) >= 0 || suffix.indexOf(actualSuffix) >= 0)) {
                score += 1;
            }
        }
        return score;
    }

    // 対象文字列の出現位置をすべて収集し、文脈スコア＋距離で一意に絞り込む
    function findUniqueRangeStart(containerText, info) {
        var candidates = [];
        var searchFrom = 0;
        var idx;
        var i;
        var bestScore = -1;
        var scored = [];
        var savedStart = isFiniteNumber(Number(info.startIndex)) ? Number(info.startIndex) : -1;
        var bestDistance;
        var distance;
        var nearest = [];
        while (true) {
            idx = containerText.indexOf(info.text, searchFrom);
            if (idx < 0) break;
            candidates.push(idx);
            searchFrom = idx + Math.max(1, info.text.length);
            if (candidates.length > 2000) break;
        }
        if (candidates.length === 0) return { found: false, ambiguous: false, index: -1 };
        if (candidates.length === 1) return { found: true, ambiguous: false, index: candidates[0] };
        for (i = 0; i < candidates.length; i++) {
            scored.push({ index: candidates[i], score: scoreRangeContext(containerText, candidates[i], info) });
            if (scored[i].score > bestScore) bestScore = scored[i].score;
        }
        bestDistance = -1;
        for (i = 0; i < scored.length; i++) {
            if (scored[i].score !== bestScore) continue;
            distance = savedStart >= 0 ? Math.abs(scored[i].index - savedStart) : 0;
            if (bestDistance < 0 || distance < bestDistance) {
                bestDistance = distance;
                nearest = [scored[i].index];
            } else if (distance === bestDistance) {
                nearest.push(scored[i].index);
            }
        }
        if (nearest.length === 1) return { found: true, ambiguous: false, index: nearest[0] };
        return { found: true, ambiguous: true, index: -1 };
    }

    // 複数コンテナ（表セル）にまたがる出現位置を収集する
    function collectRangeOccurrences(containers, info) {
        var occurrences = [];
        var i;
        var text;
        var idx;
        var searchFrom;
        for (i = 0; i < containers.length; i++) {
            text = getContainerText(containers[i]);
            searchFrom = 0;
            while (true) {
                idx = text.indexOf(info.text, searchFrom);
                if (idx < 0) break;
                occurrences.push({
                    container: containers[i],
                    index: idx,
                    score: scoreRangeContext(text, idx, info)
                });
                searchFrom = idx + Math.max(1, info.text.length);
                if (occurrences.length > 2000) return occurrences;
            }
        }
        return occurrences;
    }

    // 文脈スコア最大の候補を選ぶ。savedStart>=0 なら同点を記録位置との距離で絞る
    function pickUniqueOccurrence(occurrences, savedStart) {
        var bestScore = -1;
        var best = [];
        var nearest = [];
        var bestDistance = -1;
        var distance;
        var i;
        if (occurrences.length === 0) return { found: false, ambiguous: false, occurrence: null };
        for (i = 0; i < occurrences.length; i++) {
            if (occurrences[i].score > bestScore) bestScore = occurrences[i].score;
        }
        for (i = 0; i < occurrences.length; i++) {
            if (occurrences[i].score === bestScore) best.push(occurrences[i]);
        }
        if (best.length === 1) return { found: true, ambiguous: false, occurrence: best[0] };
        if (savedStart < 0) return { found: true, ambiguous: true, occurrence: null };
        for (i = 0; i < best.length; i++) {
            distance = Math.abs(best[i].index - savedStart);
            if (bestDistance < 0 || distance < bestDistance) {
                bestDistance = distance;
                nearest = [best[i]];
            } else if (distance === bestDistance) {
                nearest.push(best[i]);
            }
        }
        if (nearest.length === 1) return { found: true, ambiguous: false, occurrence: nearest[0] };
        return { found: true, ambiguous: true, occurrence: null };
    }

    function makeCellContainers(cells, story) {
        var containers = [];
        var i;
        for (i = 0; i < cells.length; i++) {
            containers.push({ kind: "cell", obj: cells[i], story: story });
        }
        return containers;
    }

    function collectAllCellContainers(story) {
        var tables = collectTablesInStory(story, true);
        var cells = [];
        var i;
        for (i = 0; i < tables.length; i++) {
            cells = cells.concat(getTableCellElements(tables[i]));
        }
        return makeCellContainers(cells, story);
    }

    // 表セル内の文字範囲を探す: { status, container, startIndex }
    // 1. 記録したセルの記録位置  2. 記録したセル内の別位置  3. ストーリー内の全セル（入れ子表を含む）
    function locateRangeInCells(documentRef, frame, info) {
        var located = { status: STATUS_RANGE_UNKNOWN, container: null, startIndex: -1 };
        var recorded = findRecordedCells(documentRef, frame, info.storyId);
        var recordedContainers = makeCellContainers(recorded.cells, recorded.story);
        var savedStart = parseInt(String(info.startIndex), 10);
        var exact = [];
        var picked;
        var i;
        var text;
        if (isNaN(savedStart)) savedStart = -1;

        if (savedStart >= 0) {
            for (i = 0; i < recordedContainers.length; i++) {
                text = getContainerText(recordedContainers[i]);
                if (text.substr(savedStart, info.text.length) === info.text) {
                    exact.push({
                        container: recordedContainers[i],
                        index: savedStart,
                        score: scoreRangeContext(text, savedStart, info)
                    });
                }
            }
        }
        if (exact.length > 0) {
            picked = pickUniqueOccurrence(exact, -1);
            if (picked.found && !picked.ambiguous) {
                located.status = STATUS_OK;
                located.container = picked.occurrence.container;
                located.startIndex = picked.occurrence.index;
                return located;
            }
        }

        picked = pickUniqueOccurrence(collectRangeOccurrences(recordedContainers, info), savedStart);
        if (picked.found) {
            if (picked.ambiguous) {
                located.status = STATUS_AMBIGUOUS;
                return located;
            }
            located.status = STATUS_TEXT_CHANGED;
            located.container = picked.occurrence.container;
            located.startIndex = picked.occurrence.index;
            return located;
        }

        // 行・列の追加やセル結合でセルの番地が変わった場合に備え、表全体から探す
        if (!recorded.story) return located;
        picked = pickUniqueOccurrence(collectRangeOccurrences(collectAllCellContainers(recorded.story), info), -1);
        if (!picked.found) return located;
        if (picked.ambiguous) {
            located.status = STATUS_AMBIGUOUS;
            return located;
        }
        located.status = STATUS_TEXT_CHANGED;
        located.container = picked.occurrence.container;
        located.startIndex = picked.occurrence.index;
        return located;
    }

    // ストーリー内の文字範囲を探す: { status, container, startIndex }
    function locateRangeInStory(documentRef, frame, info) {
        var located = { status: STATUS_RANGE_UNKNOWN, container: null, startIndex: -1 };
        var container = findContainerForRecord(documentRef, frame, info.storyId);
        var containerText;
        var startIndex;
        var searchResult;
        if (!container) return located;
        containerText = getContainerText(container);
        startIndex = parseInt(String(info.startIndex), 10);
        if (!isNaN(startIndex) && startIndex >= 0 &&
                containerText.substr(startIndex, info.text.length) === info.text) {
            located.status = container.fallback === true ? STATUS_TEXT_CHANGED : STATUS_OK;
            located.container = container;
            located.startIndex = startIndex;
            return located;
        }
        searchResult = findUniqueRangeStart(containerText, info);
        if (!searchResult.found) return located;
        if (searchResult.ambiguous) {
            located.status = STATUS_AMBIGUOUS;
            return located;
        }
        located.status = STATUS_TEXT_CHANGED;
        located.container = container;
        located.startIndex = searchResult.index;
        return located;
    }

    // 再特定結果: { status, container, startIndex, rangeObj, firstChar }
    function resolveRangeForRecord(documentRef, frame, record) {
        var info = recordToRangeInfo(record);
        var lengthValue;
        var located;
        var rangeObj;
        var result = {
            status: STATUS_RANGE_UNKNOWN,
            container: null,
            startIndex: -1,
            rangeObj: null,
            firstChar: null
        };
        if (!info || !isFiniteNumber(Number(info.length)) || Number(info.length) <= 0) {
            result.status = STATUS_INVALID;
            return result;
        }
        lengthValue = Number(info.length);
        if (isCellContainerIdString(info.storyId)) {
            located = locateRangeInCells(documentRef, frame, info);
        } else {
            located = locateRangeInStory(documentRef, frame, info);
        }
        result.status = located.status;
        if (!located.container || located.startIndex < 0) {
            if (result.status === STATUS_OK || result.status === STATUS_TEXT_CHANGED) {
                result.status = STATUS_RANGE_UNKNOWN;
            }
            return result;
        }
        result.container = located.container;
        result.startIndex = located.startIndex;

        rangeObj = getContainerTextRange(result.container, result.startIndex, Math.min(lengthValue, info.text.length));
        if (!rangeObj) {
            result.status = STATUS_RANGE_UNKNOWN;
            return result;
        }
        result.rangeObj = rangeObj;
        result.firstChar = getContainerFirstCharacter(result.container, result.startIndex);
        return result;
    }

    // ------------------------------------------------------------------
    // 対象箇所への移動（参照元InDesign版 focusOnTextFrame を移植・拡張）
    // ------------------------------------------------------------------

    function getFrameParentPage(frame) {
        var parentObj;
        if (!frame) return null;
        try {
            if (frame.parentPage && frame.parentPage.isValid) return frame.parentPage;
        } catch (eParentPage) {}
        try {
            parentObj = frame.parent;
            while (parentObj) {
                if (getObjectTypeName(parentObj) === "Page") return parentObj;
                if (getObjectTypeName(parentObj) === "Document") break;
                parentObj = parentObj.parent;
            }
        } catch (eWalk) {}
        return null;
    }

    function focusOnCommentTarget(documentRef, frame, record) {
        var resolveResult = null;
        var page = null;
        var displayFrame = frame;
        if (!isValidDomObject(frame)) return false;
        if (record && record.targetType === "textRange") {
            try {
                resolveResult = resolveRangeForRecord(documentRef, frame, record);
            } catch (eResolve) {
                resolveResult = null;
            }
        }
        if (resolveResult && resolveResult.rangeObj &&
                (resolveResult.status === STATUS_OK || resolveResult.status === STATUS_TEXT_CHANGED)) {
            try {
                app.select(resolveResult.rangeObj);
            } catch (eSelectRange) {
                try { app.select(frame); } catch (eSelectFrame) {}
            }
            if (resolveResult.firstChar) {
                var charFrame = getDisplayFrameFromTextObject(resolveResult.firstChar);
                if (charFrame) displayFrame = charFrame;
            }
        } else {
            try {
                app.select(frame);
            } catch (eSelect) {
                try { frame.select(); } catch (eSelect2) { return false; }
            }
        }
        page = getFrameParentPage(displayFrame);
        if (page) {
            try {
                app.activeWindow.activePage = page;
            } catch (ePage) {}
        }
        try {
            app.activeWindow.zoom(ZoomOptions.FIT_PAGE);
        } catch (eZoom) {
            try {
                app.menuActions.itemByName("$ID/Fit Page in Window").invoke();
            } catch (eMenu) {}
        }
        return true;
    }

    // ------------------------------------------------------------------
    // 座標環境（単位ポイント・スプレッド原点へ一時変更し、必ず復元する）
    // ------------------------------------------------------------------

    function withCoordinateEnvironment(documentRef, fn) {
        var vp = documentRef.viewPreferences;
        var saved = {};
        var hasSaved = false;
        try {
            saved.h = vp.horizontalMeasurementUnits;
            saved.v = vp.verticalMeasurementUnits;
            saved.ruler = vp.rulerOrigin;
            saved.zero = [documentRef.zeroPoint[0], documentRef.zeroPoint[1]];
            hasSaved = true;
        } catch (eCapture) {}
        try {
            try {
                vp.horizontalMeasurementUnits = MeasurementUnits.POINTS;
                vp.verticalMeasurementUnits = MeasurementUnits.POINTS;
                vp.rulerOrigin = RulerOrigin.SPREAD_ORIGIN;
                documentRef.zeroPoint = [0, 0];
            } catch (eApply) {}
            return fn();
        } finally {
            if (hasSaved) {
                try { vp.horizontalMeasurementUnits = saved.h; } catch (eH) {}
                try { vp.verticalMeasurementUnits = saved.v; } catch (eV) {}
                try { vp.rulerOrigin = saved.ruler; } catch (eR) {}
                try { documentRef.zeroPoint = saved.zero; } catch (eZ) {}
            }
        }
    }

    // ------------------------------------------------------------------
    // 矩形ユーティリティ（InDesign境界値順序 [y1, x1, y2, x2]）
    // ------------------------------------------------------------------

    function copyBoundsValue(bounds) {
        if (!bounds || bounds.length !== 4) throw new Error("境界を取得できません。");
        return [Number(bounds[0]), Number(bounds[1]), Number(bounds[2]), Number(bounds[3])];
    }

    function isValidBoundsValue(bounds) {
        return bounds && bounds.length === 4 &&
            isFiniteNumber(bounds[0]) && isFiniteNumber(bounds[1]) &&
            isFiniteNumber(bounds[2]) && isFiniteNumber(bounds[3]);
    }

    function rectFromBounds(bounds) {
        // InDesignはy下向き。top=小さいy、bottom=大きいy
        return {
            top: Math.min(bounds[0], bounds[2]),
            bottom: Math.max(bounds[0], bounds[2]),
            left: Math.min(bounds[1], bounds[3]),
            right: Math.max(bounds[1], bounds[3])
        };
    }

    function getIntersectionArea(rectA, rectB) {
        var width = Math.min(rectA.right, rectB.right) - Math.max(rectA.left, rectB.left);
        var height = Math.min(rectA.bottom, rectB.bottom) - Math.max(rectA.top, rectB.top);
        if (width <= 0 || height <= 0) return 0;
        return width * height;
    }

    function isPointInRect(x, y, rect) {
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }

    // ------------------------------------------------------------------
    // ページ情報・状態判定
    // ------------------------------------------------------------------

    function buildPageInfo(page) {
        var info = {
            id: -1,
            name: "",
            documentOffset: -1,
            bounds: null,
            rect: null,
            side: "right"
        };
        try { info.id = page.id; } catch (eId) {}
        try { info.name = safeString(page.name); } catch (eName) {}
        try { info.documentOffset = Number(page.documentOffset); } catch (eOffset) {}
        try {
            info.bounds = copyBoundsValue(page.bounds);
            info.rect = rectFromBounds(info.bounds);
        } catch (eBounds) {}
        try {
            if (page.side === PageSideOptions.LEFT_HAND) info.side = "left";
        } catch (eSide) {}
        return info;
    }

    function ensurePageInfo(pageInfoCache, page) {
        var idText = getObjectIdString(page);
        if (idText === "") return null;
        if (!pageInfoCache.byId["p" + idText]) {
            pageInfoCache.byId["p" + idText] = buildPageInfo(page);
        }
        return pageInfoCache.byId["p" + idText];
    }

    function makePageInfoCache() {
        return { byId: {} };
    }

    function getSpreadOfFrame(frame) {
        var parentObj;
        var guard = 0;
        try {
            if (frame.parentPage && frame.parentPage.isValid) return frame.parentPage.parent;
        } catch (eParentPage) {}
        try {
            parentObj = frame.parent;
            while (parentObj && guard < 12) {
                guard++;
                if (getObjectTypeName(parentObj) === "Spread" || getObjectTypeName(parentObj) === "MasterSpread") {
                    return parentObj;
                }
                if (getObjectTypeName(parentObj) === "Document") break;
                parentObj = parentObj.parent;
            }
        } catch (eWalk) {}
        return null;
    }

    function isMasterFrame(frame) {
        var spread = getSpreadOfFrame(frame);
        return getObjectTypeName(spread) === "MasterSpread";
    }

    function getFrameFlags(frame) {
        var flags = { hidden: false, hiddenLayer: false, nonPrinting: false, locked: false };
        var layer = null;
        var parentObj;
        var guard = 0;
        try { if (frame.visible === false) flags.hidden = true; } catch (eVisible) {}
        try { if (frame.nonprinting === true) flags.nonPrinting = true; } catch (eNonPrinting) {}
        try { if (frame.locked === true) flags.locked = true; } catch (eLocked) {}
        try { layer = frame.itemLayer; } catch (eLayer) {}
        if (layer) {
            try { if (layer.visible === false) flags.hiddenLayer = true; } catch (eLayerVisible) {}
            try { if (layer.locked === true) flags.locked = true; } catch (eLayerLocked) {}
            try { if (layer.printable === false) flags.nonPrinting = true; } catch (eLayerPrintable) {}
        }
        // グループ等の親の非表示・ロックも簡易チェック
        try {
            parentObj = frame.parent;
            while (parentObj && guard < 10) {
                guard++;
                if (getObjectTypeName(parentObj) === "Group") {
                    try { if (parentObj.visible === false) flags.hidden = true; } catch (eGroupVisible) {}
                    try { if (parentObj.locked === true) flags.locked = true; } catch (eGroupLocked) {}
                    try { if (parentObj.nonprinting === true) flags.nonPrinting = true; } catch (eGroupPrint) {}
                } else if (getObjectTypeName(parentObj) === "Spread" ||
                        getObjectTypeName(parentObj) === "MasterSpread" ||
                        getObjectTypeName(parentObj) === "Document") {
                    break;
                }
                parentObj = parentObj.parent;
            }
        } catch (eParent) {}
        return flags;
    }

    function isVerticalFrame(frame) {
        try {
            return frame.parentStory.storyPreferences.storyOrientation === StoryHorizontalOrVertical.VERTICAL;
        } catch (e) {
            return false;
        }
    }

    // フレームまたはアンカー点が属するページを判定する
    function findPageForFrame(frame, pageInfoCache, anchorPoint) {
        var page = null;
        var spread;
        var pages;
        var i;
        var info;
        var frameRect = null;
        var bestInfo = null;
        var bestArea = 0;
        var area;
        try {
            frameRect = rectFromBounds(copyBoundsValue(frame.geometricBounds));
        } catch (eBounds) {}
        spread = getSpreadOfFrame(frame);
        // 1. アンカー点を含むページを優先
        if (anchorPoint && spread) {
            try {
                pages = spread.pages;
                for (i = 0; i < pages.length; i++) {
                    info = ensurePageInfo(pageInfoCache, pages[i]);
                    if (info && info.rect && isPointInRect(anchorPoint[0], anchorPoint[1], info.rect)) {
                        return info;
                    }
                }
            } catch (ePoint) {}
        }
        // 2. parentPage
        try {
            if (frame.parentPage && frame.parentPage.isValid) page = frame.parentPage;
        } catch (eParentPage) {}
        if (page) {
            info = ensurePageInfo(pageInfoCache, page);
            if (info) return info;
        }
        // 3. 交差面積が最大のページ
        if (spread && frameRect) {
            try {
                pages = spread.pages;
                for (i = 0; i < pages.length; i++) {
                    info = ensurePageInfo(pageInfoCache, pages[i]);
                    if (!info || !info.rect) continue;
                    area = getIntersectionArea(frameRect, info.rect);
                    if (area > bestArea) {
                        bestArea = area;
                        bestInfo = info;
                    }
                }
            } catch (eArea) {}
        }
        return bestInfo; // 交差なしなら null（ページ外）
    }

    function readTextPoint(textRef) {
        var x = NaN;
        var y = NaN;
        if (!textRef) return null;
        try { x = Number(textRef.horizontalOffset); } catch (eX) { x = NaN; }
        try { y = Number(textRef.baseline); } catch (eY) { y = NaN; }
        if (isFiniteNumber(x) && isFiniteNumber(y)) return [x, y];
        return null;
    }

    // 文字範囲の先頭の座標（スプレッド座標）。先頭文字→範囲先頭の挿入点の順に試す
    function getTextAnchorSpreadPoint(rangeResult) {
        var point = readTextPoint(rangeResult.firstChar);
        var insertionPoint = null;
        if (point) return point;
        try { insertionPoint = rangeResult.rangeObj.insertionPoints[0]; } catch (eInsertion) { insertionPoint = null; }
        return readTextPoint(insertionPoint);
    }

    // コメント1件の状態・座標を解決する（座標環境内で呼び出すこと）
    function resolveCommentEntry(documentRef, entry, pageInfoCache) {
        var res = {
            baseStatus: STATUS_OK,
            flags: { hidden: false, hiddenLayer: false, nonPrinting: false, locked: false },
            isMaster: false,
            pageInfo: null,
            anchorKind: "frame",
            frameBounds: null,
            anchorX: 0,
            anchorY: 0,
            isVertical: false,
            targetLabel: "",
            textMarkupSegments: []
        };
        var frame = entry.frame;
        var record = entry.record;
        var rangeResult = null;
        var displayFrame = frame;
        var x;
        var y;
        var coordOk = false;
        var frameRect;
        var anchorPoint;

        if (record.targetType === "textRange") {
            res.targetLabel = "文字: " + makeListText(record.rangeText, 30);
        }

        if (!isValidDomObject(frame)) {
            res.baseStatus = STATUS_INVALID;
            return res;
        }

        if (res.targetLabel === "") {
            res.targetLabel = getPageItemDisplayLabel(frame);
        }

        if (isMasterFrame(frame)) {
            res.isMaster = true;
            res.baseStatus = STATUS_MASTER;
            return res;
        }

        res.flags = getFrameFlags(frame);
        res.isVertical = isVerticalFrame(frame);

        if (record.targetType === "textRange") {
            rangeResult = resolveRangeForRecord(documentRef, frame, record);
            if (rangeResult.status !== STATUS_OK && rangeResult.status !== STATUS_TEXT_CHANGED) {
                res.baseStatus = rangeResult.status;
                return res;
            }
            res.baseStatus = rangeResult.status;
            displayFrame = rangeResult.firstChar ? getDisplayFrameFromTextObject(rangeResult.firstChar) : null;
            if (!displayFrame) {
                // 表示フレームが無い＝オーバーセット
                res.baseStatus = STATUS_OVERSET;
                return res;
            }
            res.flags = getFrameFlags(displayFrame);
            res.isVertical = isVerticalFrame(displayFrame) || res.isVertical;
            anchorPoint = getTextAnchorSpreadPoint(rangeResult);
            if (anchorPoint) {
                x = anchorPoint[0];
                y = anchorPoint[1];
                coordOk = true;
            }
            try {
                res.frameBounds = copyBoundsValue(displayFrame.geometricBounds);
            } catch (eFrameBounds) {
                res.frameBounds = null;
            }
            if (coordOk && res.frameBounds && isValidBoundsValue(res.frameBounds)) {
                // 座標の妥当性チェック：表示フレーム外接矩形へクランプ
                frameRect = rectFromBounds(res.frameBounds);
                x = clamp(x, frameRect.left, frameRect.right);
                y = clamp(y, frameRect.top, frameRect.bottom);
            }
            if (!coordOk) {
                res.baseStatus = STATUS_COORD_FAILED;
                if (!ALLOW_FRAME_FALLBACK_ON_COORD_FAIL || !res.frameBounds) {
                    return res;
                }
                res.anchorKind = "frame";
            } else {
                res.anchorKind = "point";
                res.anchorX = x;
                res.anchorY = y;
            }
        } else {
            try {
                res.frameBounds = copyBoundsValue(frame.geometricBounds);
                if (!isValidBoundsValue(res.frameBounds)) throw new Error("bounds");
            } catch (eBounds2) {
                res.baseStatus = STATUS_COORD_FAILED;
                return res;
            }
            res.anchorKind = "frame";
        }

        res.pageInfo = findPageForFrame(displayFrame, pageInfoCache,
            res.anchorKind === "point" ? [res.anchorX, res.anchorY] : null);
        if (!res.pageInfo || !res.pageInfo.rect) {
            res.baseStatus = STATUS_OFF_PAGE;
            res.pageInfo = null;
            return res;
        }
        if (record.targetType === "textRange" && rangeResult && rangeResult.rangeObj) {
            try {
                res.textMarkupSegments = buildTextMarkupSegments(rangeResult.rangeObj, res.pageInfo);
            } catch (eMarkup) {
                res.textMarkupSegments = [];
            }
        }
        return res;
    }

    // 現在の書き出し設定で有効な表示状態と出力可否を返す
    function getEffectiveStatus(res, settings) {
        var excludedStatuses = {};
        excludedStatuses[STATUS_INVALID] = true;
        excludedStatuses[STATUS_MASTER] = true;
        excludedStatuses[STATUS_OVERSET] = true;
        excludedStatuses[STATUS_OFF_PAGE] = true;
        excludedStatuses[STATUS_RANGE_UNKNOWN] = true;
        excludedStatuses[STATUS_AMBIGUOUS] = true;
        if (excludedStatuses[res.baseStatus] === true) {
            return { status: res.baseStatus, exportable: false };
        }
        if (res.baseStatus === STATUS_COORD_FAILED) {
            return { status: STATUS_COORD_FAILED, exportable: ALLOW_FRAME_FALLBACK_ON_COORD_FAIL && res.frameBounds !== null };
        }
        if (res.flags.hidden && settings.includeHidden !== true) {
            return { status: STATUS_HIDDEN, exportable: false };
        }
        if (res.flags.hiddenLayer && settings.includeHiddenLayers !== true) {
            return { status: STATUS_HIDDEN_LAYER, exportable: false };
        }
        if (res.flags.nonPrinting && settings.includeNonPrinting !== true) {
            return { status: STATUS_NON_PRINTING, exportable: false };
        }
        if (res.flags.locked && settings.includeLocked !== true) {
            return { status: STATUS_LOCKED, exportable: false };
        }
        return { status: res.baseStatus, exportable: true };
    }

    // ------------------------------------------------------------------
    // コメント収集
    // ------------------------------------------------------------------

    function collectFramesWithComments(documentRef) {
        var result = [];
        var seen = {};
        var frames = [];
        var i;
        var j;
        var records;
        var idText;
        // テキストフレームに加え、画像フレーム・図形フレーム等の全PageItemを走査
        try {
            var allItems = documentRef.allPageItems;
            for (i = 0; i < allItems.length; i++) frames.push(allItems[i]);
        } catch (eAll) {
            try {
                frames = documentRef.textFrames.everyItem().getElements();
            } catch (eEvery) {
                frames = [];
                try {
                    for (i = 0; i < documentRef.textFrames.length; i++) frames.push(documentRef.textFrames[i]);
                } catch (eLoop) {}
            }
        }
        // 親ページ（マスター）上のオブジェクトも一覧表示用に収集
        try {
            for (i = 0; i < documentRef.masterSpreads.length; i++) {
                try {
                    var masterItems = documentRef.masterSpreads[i].allPageItems;
                    for (j = 0; j < masterItems.length; j++) frames.push(masterItems[j]);
                } catch (eMaster) {}
            }
        } catch (eMasters) {}
        for (i = 0; i < frames.length; i++) {
            idText = getObjectIdString(frames[i]);
            if (idText !== "" && seen["f" + idText] === true) continue;
            if (idText !== "") seen["f" + idText] = true;
            records = getCommentRecordsFromTarget(frames[i]);
            for (j = 0; j < records.length; j++) {
                result.push({ frame: frames[i], record: records[j] });
            }
        }
        return result;
    }

    // ------------------------------------------------------------------
    // ページマップ生成（XFDFのpage属性は0始まりのPDFページインデックス）
    // ------------------------------------------------------------------

    function buildPageMap(pageInfos) {
        var sorted = pageInfos.slice(0);
        var entries = [];
        var byId = {};
        var i;
        var rangeParts = [];
        sorted.sort(function (a, b) { return a.documentOffset - b.documentOffset; });
        for (i = 0; i < sorted.length; i++) {
            entries.push({
                pageId: sorted[i].id,
                pageName: sorted[i].name,
                documentPageIndex: sorted[i].documentOffset,
                pdfPageIndex: i,
                pageInfo: sorted[i]
            });
            byId["p" + sorted[i].id] = entries[i];
            rangeParts.push("+" + (sorted[i].documentOffset + 1));
        }
        return {
            entries: entries,
            byId: byId,
            pageRangeString: rangeParts.join(",")
        };
    }

    function resolvePageToken(documentRef, token) {
        var value = trim(token);
        var page;
        var n;
        if (value === "") return -1;
        try {
            page = documentRef.pages.itemByName(value);
            if (isValidDomObject(page)) return Number(page.documentOffset);
        } catch (eByName) {}
        if (/^\+\d+$/.test(value)) {
            n = parseInt(value.substring(1), 10);
            if (n >= 1 && n <= documentRef.pages.length) return n - 1;
            return -1;
        }
        if (/^\d+$/.test(value)) {
            n = parseInt(value, 10);
            if (n >= 1 && n <= documentRef.pages.length) return n - 1;
        }
        return -1;
    }

    function parseCustomPageRange(documentRef, text) {
        var tokens = safeString(text).split(",");
        var offsets = [];
        var seen = {};
        var i;
        var token;
        var dash;
        var left;
        var right;
        var k;
        if (trim(text) === "") return { offsets: [], error: "ページ範囲を入力してください。" };
        for (i = 0; i < tokens.length; i++) {
            token = trim(tokens[i]);
            if (token === "") continue;
            // ハイフンを含むページ名（例: セクション名 A-1）を優先して単ページ解決する
            left = resolvePageToken(documentRef, token);
            if (left >= 0) {
                if (seen["o" + left] !== true) {
                    seen["o" + left] = true;
                    offsets.push(left);
                }
                continue;
            }
            dash = token.indexOf("-");
            // 先頭の+付き表記（+3-+5）にも対応するため、区切りのハイフンを探す
            if (dash === 0) dash = token.indexOf("-", 1);
            if (dash > 0) {
                left = resolvePageToken(documentRef, token.substring(0, dash));
                right = resolvePageToken(documentRef, token.substring(dash + 1));
                if (left < 0 || right < 0 || left > right) {
                    return { offsets: [], error: "ページ範囲「" + token + "」を解釈できません。\nページ名または +絶対ページ番号 で指定してください。" };
                }
                for (k = left; k <= right; k++) {
                    if (seen["o" + k] !== true) {
                        seen["o" + k] = true;
                        offsets.push(k);
                    }
                }
            } else {
                return { offsets: [], error: "ページ「" + token + "」が見つかりません。\nページ名または +絶対ページ番号 で指定してください。" };
            }
        }
        if (offsets.length === 0) return { offsets: [], error: "ページ範囲を解釈できません。" };
        offsets.sort(function (a, b) { return a - b; });
        return { offsets: offsets, error: "" };
    }

    // 書き出し対象ページの pageInfo 配列を返す（座標環境内で呼び出すこと）
    function collectExportPageInfos(documentRef, rangeChoice, customText, commentPageOffsets, pageInfoCache) {
        var result = { pageInfos: [], error: "" };
        var i;
        var page;
        var info;
        var parsed;
        var activePage = null;
        var spreadPages;
        try {
            if (rangeChoice === EXPORT_RANGE_CURRENT_PAGE || rangeChoice === EXPORT_RANGE_CURRENT_SPREAD) {
                try {
                    activePage = app.activeWindow.activePage;
                } catch (eActive) {
                    activePage = null;
                }
                if (!isValidDomObject(activePage)) {
                    result.error = "現在のページを取得できません。レイアウトウィンドウで実行してください。";
                    return result;
                }
            }
            if (rangeChoice === EXPORT_RANGE_ALL) {
                for (i = 0; i < documentRef.pages.length; i++) {
                    info = ensurePageInfo(pageInfoCache, documentRef.pages[i]);
                    if (info) result.pageInfos.push(info);
                }
            } else if (rangeChoice === EXPORT_RANGE_CURRENT_PAGE) {
                info = ensurePageInfo(pageInfoCache, activePage);
                if (info) result.pageInfos.push(info);
            } else if (rangeChoice === EXPORT_RANGE_CURRENT_SPREAD) {
                spreadPages = activePage.parent.pages;
                for (i = 0; i < spreadPages.length; i++) {
                    info = ensurePageInfo(pageInfoCache, spreadPages[i]);
                    if (info) result.pageInfos.push(info);
                }
            } else if (rangeChoice === EXPORT_RANGE_CUSTOM) {
                parsed = parseCustomPageRange(documentRef, customText);
                if (parsed.error !== "") {
                    result.error = parsed.error;
                    return result;
                }
                for (i = 0; i < parsed.offsets.length; i++) {
                    page = documentRef.pages[parsed.offsets[i]];
                    info = ensurePageInfo(pageInfoCache, page);
                    if (info) result.pageInfos.push(info);
                }
            } else {
                // コメントのあるページのみ
                for (i = 0; i < commentPageOffsets.length; i++) {
                    page = documentRef.pages[commentPageOffsets[i]];
                    info = ensurePageInfo(pageInfoCache, page);
                    if (info) result.pageInfos.push(info);
                }
            }
        } catch (eCollect) {
            result.error = "書き出しページの確定に失敗しました: " + safeString(eCollect.message || eCollect);
        }
        if (result.error === "" && result.pageInfos.length === 0) {
            result.error = "書き出し対象ページがありません。";
        }
        return result;
    }

    // ------------------------------------------------------------------
    // 裁ち落とし・プリンターマーク
    // ------------------------------------------------------------------

    function readBleedSource(documentRef, preset) {
        // 戻り値はポイント値（座標環境内で読み取ること）
        var source = { top: 0, bottom: 0, inside: 0, outside: 0 };
        var useDocumentBleed = true;
        var reader = preset || app.pdfExportPreferences;
        try {
            // InDesign DOMの正式なプロパティ名は末尾が大文字の「PDF」。
            // useDocumentBleedWithPdf では常に取得に失敗し、プリセット内に残った
            // 個別裁ち落とし値を誤ってXFDF座標へ加算する場合がある。
            useDocumentBleed = reader.useDocumentBleedWithPDF === true;
        } catch (eUsePDF) {
            // 将来／旧環境向けの互換フォールバック
            try {
                useDocumentBleed = reader.useDocumentBleedWithPdf === true;
            } catch (eUsePdf) {
                useDocumentBleed = true;
            }
        }
        if (useDocumentBleed) {
            try {
                source.top = Number(documentRef.documentPreferences.documentBleedTopOffset) || 0;
                source.bottom = Number(documentRef.documentPreferences.documentBleedBottomOffset) || 0;
                source.inside = Number(documentRef.documentPreferences.documentBleedInsideOrLeftOffset) || 0;
                source.outside = Number(documentRef.documentPreferences.documentBleedOutsideOrRightOffset) || 0;
            } catch (eDoc) {}
        } else {
            try {
                source.top = Number(reader.bleedTop) || 0;
                source.bottom = Number(reader.bleedBottom) || 0;
                source.inside = Number(reader.bleedInside) || 0;
                source.outside = Number(reader.bleedOutside) || 0;
            } catch (ePreset) {}
        }
        return source;
    }

    function getPageBleeds(bleedSource, pageInfo, facingPages) {
        // 見開き時: 左ページは外側=左、右ページは内側=左
        var isLeftPage = facingPages === true && pageInfo.side === "left";
        return {
            top: bleedSource.top,
            bottom: bleedSource.bottom,
            left: isLeftPage ? bleedSource.outside : bleedSource.inside,
            right: isLeftPage ? bleedSource.inside : bleedSource.outside
        };
    }

    function hasPrinterMarksEnabled(preset) {
        var reader = preset || app.pdfExportPreferences;
        var keys = ["cropMarks", "bleedMarks", "registrationMarks", "colorBars", "pageInformationMarks"];
        var i;
        for (i = 0; i < keys.length; i++) {
            try {
                if (reader[keys[i]] === true) return true;
            } catch (eKey) {}
        }
        return false;
    }

    // ------------------------------------------------------------------
    // コメント位置計算（スプレッド座標 → PDF座標。PDF/XFDFは左下原点）
    // ------------------------------------------------------------------

    function resolveAutoPositionKey(frameRect, pageRect, isVertical) {
        var candidates = isVertical ?
            ["topLeft", "topRight", "bottomLeft", "bottomRight", "center"] :
            ["topRight", "topLeft", "bottomRight", "bottomLeft", "center"];
        var i;
        var point;
        for (i = 0; i < candidates.length; i++) {
            point = getFrameAnchorSpreadPoint(frameRect, candidates[i]);
            if (isPointInRect(point[0], point[1], pageRect)) return candidates[i];
        }
        return "center";
    }

    function getFrameAnchorSpreadPoint(frameRect, positionKey) {
        var x = (frameRect.left + frameRect.right) / 2;
        var y = (frameRect.top + frameRect.bottom) / 2;
        if (positionKey.indexOf("Left") >= 0 || positionKey === "middleLeft") x = frameRect.left;
        if (positionKey.indexOf("Right") >= 0 || positionKey === "middleRight") x = frameRect.right;
        if (positionKey.indexOf("top") === 0) y = frameRect.top;
        if (positionKey.indexOf("bottom") === 0) y = frameRect.bottom;
        return [x, y];
    }

    function spreadPointToPdfPoint(x, y, pageInfo, bleeds) {
        // ページローカル座標へ変換してからPDF左下原点座標へ
        var localX = x - pageInfo.rect.left;
        var localY = y - pageInfo.rect.top;
        var pageHeight = pageInfo.rect.bottom - pageInfo.rect.top;
        return [localX + bleeds.left, (pageHeight - localY) + bleeds.bottom];
    }

    function getPdfPageSize(pageInfo, bleeds) {
        return {
            width: (pageInfo.rect.right - pageInfo.rect.left) + bleeds.left + bleeds.right,
            height: (pageInfo.rect.bottom - pageInfo.rect.top) + bleeds.top + bleeds.bottom
        };
    }

    function isTextMarkupCharacter(characterRef) {
        var contents = "";
        try { contents = safeString(characterRef.contents); } catch (eContents) {}
        // 改行・フレーム区切り等には描画幅がないためQuadPointsから除外する
        return contents !== "" && !/[\r\n\u0003\u0004\u000c]/.test(contents);
    }

    function makeCharacterMarkupSegment(characterRef, pageInfo) {
        var startX;
        var startY;
        var endX;
        var endY;
        var dx;
        var dy;
        var length;
        var unitX;
        var unitY;
        var ascent;
        var descent;
        var pointSize;
        var midX;
        var midY;
        if (!isTextMarkupCharacter(characterRef)) return null;
        try {
            startX = Number(characterRef.horizontalOffset);
            startY = Number(characterRef.baseline);
            endX = Number(characterRef.endHorizontalOffset);
            endY = Number(characterRef.endBaseline);
            ascent = Math.abs(Number(characterRef.ascent));
            descent = Math.abs(Number(characterRef.descent));
            pointSize = Math.abs(Number(characterRef.pointSize));
        } catch (eMetrics) {
            return null;
        }
        if (!isFiniteNumber(startX) || !isFiniteNumber(startY) ||
                !isFiniteNumber(endX) || !isFiniteNumber(endY)) {
            return null;
        }
        if (!isFiniteNumber(pointSize) || pointSize <= 0) pointSize = 10;
        if (!isFiniteNumber(ascent)) ascent = 0;
        if (!isFiniteNumber(descent)) descent = 0;
        // PDF上でAcrobatが選ぶ文字ボックスはInDesignの字面ascent/descentより広い。
        // pointSize比の下限を設け、Acrobatのテキスト選択表示に近づける。
        ascent = Math.max(ascent, pointSize * TEXT_MARKUP_MIN_ASCENT_RATIO);
        descent = Math.max(descent, pointSize * TEXT_MARKUP_MIN_DESCENT_RATIO);
        dx = endX - startX;
        dy = endY - startY;
        length = Math.sqrt(dx * dx + dy * dy);
        if (!isFiniteNumber(length) || length < 0.01) return null;
        unitX = dx / length;
        unitY = dy / length;
        midX = (startX + endX) / 2;
        midY = (startY + endY) / 2;
        if (!pageInfo || !pageInfo.rect || !isPointInRect(midX, midY, pageInfo.rect)) return null;
        return {
            startX: startX,
            startY: startY,
            endX: endX,
            endY: endY,
            unitX: unitX,
            unitY: unitY,
            ascent: ascent,
            descent: descent
        };
    }

    function canMergeTextMarkupSegments(previous, current) {
        var dot;
        var gapX;
        var gapY;
        var perpendicularGap;
        if (!previous || !current) return false;
        dot = previous.unitX * current.unitX + previous.unitY * current.unitY;
        if (dot < TEXT_MARKUP_DIRECTION_TOLERANCE) return false;
        gapX = current.startX - previous.endX;
        gapY = current.startY - previous.endY;
        perpendicularGap = Math.abs(gapX * (-previous.unitY) + gapY * previous.unitX);
        if (perpendicularGap > TEXT_MARKUP_BASELINE_TOLERANCE_PT) return false;
        if (Math.abs(previous.ascent - current.ascent) > TEXT_MARKUP_METRIC_TOLERANCE_PT ||
                Math.abs(previous.descent - current.descent) > TEXT_MARKUP_METRIC_TOLERANCE_PT) {
            return false;
        }
        // 逆方向へ戻る、または改行後の離れた位置へ移るものは別Quadにする
        if (gapX * previous.unitX + gapY * previous.unitY < -TEXT_MARKUP_BASELINE_TOLERANCE_PT) {
            return false;
        }
        return true;
    }

    function buildTextMarkupSegments(rangeObj, pageInfo) {
        var result = [];
        var characters;
        var i;
        var current;
        var previous;
        try { characters = rangeObj.characters; } catch (eCharacters) { return result; }
        if (!characters) return result;
        for (i = 0; i < characters.length; i++) {
            current = makeCharacterMarkupSegment(characters[i], pageInfo);
            if (!current) {
                previous = null;
                continue;
            }
            if (previous && canMergeTextMarkupSegments(previous, current)) {
                previous.endX = current.endX;
                previous.endY = current.endY;
                previous.ascent = Math.max(previous.ascent, current.ascent);
                previous.descent = Math.max(previous.descent, current.descent);
            } else {
                result.push(current);
                previous = current;
            }
        }
        return result;
    }

    function textMarkupSegmentToPdfQuad(segment, pageInfo, bleeds) {
        // InDesignはy下向き。進行方向に対する上側法線は [unitY, -unitX]。
        var topX = segment.unitY;
        var topY = -segment.unitX;
        var topStart = spreadPointToPdfPoint(
            segment.startX + topX * segment.ascent,
            segment.startY + topY * segment.ascent,
            pageInfo, bleeds);
        var topEnd = spreadPointToPdfPoint(
            segment.endX + topX * segment.ascent,
            segment.endY + topY * segment.ascent,
            pageInfo, bleeds);
        var bottomStart = spreadPointToPdfPoint(
            segment.startX - topX * segment.descent,
            segment.startY - topY * segment.descent,
            pageInfo, bleeds);
        var bottomEnd = spreadPointToPdfPoint(
            segment.endX - topX * segment.descent,
            segment.endY - topY * segment.descent,
            pageInfo, bleeds);
        return [
            topStart[0], topStart[1],
            topEnd[0], topEnd[1],
            bottomStart[0], bottomStart[1],
            bottomEnd[0], bottomEnd[1]
        ];
    }

    function makeTextMarkupRect(quads, pageWidth, pageHeight) {
        var minX = pageWidth;
        var minY = pageHeight;
        var maxX = 0;
        var maxY = 0;
        var i;
        for (i = 0; i < quads.length; i += 2) {
            minX = Math.min(minX, quads[i]);
            maxX = Math.max(maxX, quads[i]);
            minY = Math.min(minY, quads[i + 1]);
            maxY = Math.max(maxY, quads[i + 1]);
        }
        return [
            clamp(minX - TEXT_MARKUP_RECT_PADDING_PT, 0, pageWidth),
            clamp(minY - TEXT_MARKUP_RECT_PADDING_PT, 0, pageHeight),
            clamp(maxX + TEXT_MARKUP_RECT_PADDING_PT, 0, pageWidth),
            clamp(maxY + TEXT_MARKUP_RECT_PADDING_PT, 0, pageHeight)
        ];
    }

    function makeAnnotationRectPdf(pdfPoint, widthPt, heightPt, pageWidth, pageHeight) {
        var width = Math.min(Math.max(widthPt, 1), pageWidth);
        var height = Math.min(Math.max(heightPt, 1), pageHeight);
        var left = pdfPoint[0] - width / 2;
        var bottom = pdfPoint[1] - height / 2;
        left = clamp(left, 0, Math.max(0, pageWidth - width));
        bottom = clamp(bottom, 0, Math.max(0, pageHeight - height));
        return [left, bottom, left + width, bottom + height];
    }

    // ------------------------------------------------------------------
    // 衝突回避（Illustrator版から移植）
    // ------------------------------------------------------------------

    function rectsOverlapWithTolerance(rectA, rectB, tolerance) {
        var value = Math.max(0, Number(tolerance) || 0);
        return !(rectA[2] <= rectB[0] + value || rectA[0] >= rectB[2] - value ||
            rectA[3] <= rectB[1] + value || rectA[1] >= rectB[3] - value);
    }

    function clampAnnotationRect(rect, pageWidth, pageHeight) {
        var width = rect[2] - rect[0];
        var height = rect[3] - rect[1];
        var left = clamp(rect[0], 0, Math.max(0, pageWidth - width));
        var bottom = clamp(rect[1], 0, Math.max(0, pageHeight - height));
        return [left, bottom, left + width, bottom + height];
    }

    function applyAnnotationCollisionOffset(baseRect, page, usedRectsByPage, pageWidth, pageHeight) {
        var key = "p" + page;
        var used = usedRectsByPage[key] || [];
        var xSpaceRight = pageWidth - baseRect[2];
        var xSpaceLeft = baseRect[0];
        var ySpaceTop = pageHeight - baseRect[3];
        var ySpaceBottom = baseRect[1];
        var xDirection = xSpaceRight >= ANNOTATION_OFFSET_PT * (ANNOTATION_OFFSET_COLUMNS - 1) || xSpaceRight >= xSpaceLeft ? 1 : -1;
        // PDFはy上向きのため「下へずらす」= yマイナス方向を基本とする
        var yDirection = ySpaceBottom >= ANNOTATION_OFFSET_PT || ySpaceBottom >= ySpaceTop ? -1 : 1;
        var candidate = baseRect;
        var column;
        var row;
        var overlaps;
        var i;
        var j;
        for (i = 0; i < ANNOTATION_MAX_OFFSET_TRIES; i++) {
            column = i % ANNOTATION_OFFSET_COLUMNS;
            row = Math.floor(i / ANNOTATION_OFFSET_COLUMNS);
            candidate = clampAnnotationRect([
                baseRect[0] + column * ANNOTATION_OFFSET_PT * xDirection,
                baseRect[1] + row * ANNOTATION_OFFSET_PT * yDirection,
                baseRect[2] + column * ANNOTATION_OFFSET_PT * xDirection,
                baseRect[3] + row * ANNOTATION_OFFSET_PT * yDirection
            ], pageWidth, pageHeight);
            overlaps = false;
            for (j = 0; j < used.length; j++) {
                if (rectsOverlapWithTolerance(candidate, used[j], 0.75)) {
                    overlaps = true;
                    break;
                }
            }
            if (!overlaps) break;
        }
        used.push(candidate);
        usedRectsByPage[key] = used;
        return candidate;
    }

    // ------------------------------------------------------------------
    // XFDF生成（Illustrator版を移植し、name/日時属性を追加）
    // ------------------------------------------------------------------

    function formatPdfNumber(value) {
        var rounded = Math.round(Number(value) * 1000) / 1000;
        if (!isFiniteNumber(rounded)) throw new Error("コメント座標が不正です。");
        return String(rounded);
    }

    function formatAnnotationRect(rect) {
        return formatPdfNumber(rect[0]) + "," + formatPdfNumber(rect[1]) + "," +
            formatPdfNumber(rect[2]) + "," + formatPdfNumber(rect[3]);
    }

    function formatQuadPoints(quads) {
        var values = [];
        var i;
        for (i = 0; i < quads.length; i++) values.push(formatPdfNumber(quads[i]));
        return values.join(",");
    }

    function buildXfdf(pdfFileName, annotations, settings) {
        var lines = [];
        var i;
        var annotation;
        var author = escapeXml(settings.author);
        var subject = escapeXml(settings.subject);
        lines.push("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
        lines.push("<xfdf xmlns=\"http://ns.adobe.com/xfdf/\" xml:space=\"preserve\">");
        lines.push("  <f href=\"" + escapeXml(pdfFileName) + "\"/>");
        lines.push("  <annots>");
        for (i = 0; i < annotations.length; i++) {
            annotation = annotations[i];
            if (annotation.type === "highlight") {
                lines.push("    <highlight page=\"" + annotation.page +
                    "\" coords=\"" + escapeXml(formatQuadPoints(annotation.quads)) +
                    "\" rect=\"" + escapeXml(formatAnnotationRect(annotation.rect)) +
                    "\" color=\"" + escapeXml(annotation.color) +
                    "\" opacity=\"" + formatPdfNumber(TEXT_MARKUP_OPACITY) +
                    "\" flags=\"print\" IT=\"HighlightNote\" title=\"" + author +
                    "\" subject=\"" + subject +
                    "\" name=\"" + escapeXml(annotation.name) +
                    "\" creationdate=\"" + escapeXml(annotation.creationDate) +
                    "\" date=\"" + escapeXml(annotation.modifiedDate) + "\">");
                lines.push("      <contents>" + escapeXml(annotation.text) + "</contents>");
                lines.push("    </highlight>");
            } else {
                lines.push("    <text page=\"" + annotation.page +
                    "\" rect=\"" + escapeXml(formatAnnotationRect(annotation.rect)) +
                    "\" color=\"" + escapeXml(annotation.color) +
                    "\" title=\"" + author +
                    "\" subject=\"" + subject +
                    "\" name=\"" + escapeXml(annotation.name) +
                    "\" creationdate=\"" + escapeXml(annotation.creationDate) +
                    "\" date=\"" + escapeXml(annotation.modifiedDate) +
                    "\" icon=\"Comment\" open=\"no\">");
                lines.push("      <contents>" + escapeXml(annotation.text) + "</contents>");
                lines.push("    </text>");
            }
        }
        lines.push("  </annots>");
        lines.push("</xfdf>");
        return lines.join("\n") + "\n";
    }

    // ------------------------------------------------------------------
    // 注釈データの組み立て
    // ------------------------------------------------------------------

    function buildAnnotationBody(row, settings) {
        var body = safeString(row.entry.record.memo);
        var extras = [];
        if (row.entry.record.targetType === "textRange") {
            // 文字範囲コメントは親文字（対象文字列）を常に本文へ含める
            extras.push("対象テキスト: " + safeString(row.entry.record.rangeText));
        } else if (settings.includeTargetText === true && row.resolution.targetLabel !== "") {
            // TextFrameは本文、画像・図形は種別／ファイル名を付記する（オプション時のみ）
            extras.push("対象: " + row.resolution.targetLabel.replace(/^枠: /, ""));
        }
        if (settings.includePageName === true && row.resolution.pageInfo) {
            extras.push("ページ: " + row.resolution.pageInfo.name);
        }
        if (extras.length > 0) {
            body = body + "\n----\n" + extras.join("\n");
        }
        return body;
    }

    function prepareAnnotations(rows, settings, pageMap, bleedSource, facingPages, diagnostics) {
        var annotations = [];
        var usedRectsByPage = {};
        var i;
        var row;
        var effective;
        var mapEntry;
        var bleeds;
        var pdfSize;
        var frameRect;
        var positionKey;
        var anchorSpread;
        var pdfPoint;
        var rect;
        var quads;
        var q;
        var segmentIndex;
        var record;
        var counter = 0;
        for (i = 0; i < rows.length; i++) {
            row = rows[i];
            record = row.entry.record;
            effective = getEffectiveStatus(row.resolution, settings);
            if (record.enabled !== "1") {
                diagnostics.addExcluded("出力OFF");
                continue;
            }
            if (!effective.exportable) {
                diagnostics.addExcluded(effective.status);
                continue;
            }
            mapEntry = pageMap.byId["p" + row.resolution.pageInfo.id];
            if (!mapEntry) {
                diagnostics.addExcluded(STATUS_OUT_OF_RANGE);
                continue;
            }
            try {
                bleeds = getPageBleeds(bleedSource, mapEntry.pageInfo, facingPages);
                pdfSize = getPdfPageSize(mapEntry.pageInfo, bleeds);
                counter++;
                if (record.targetType === "textRange" &&
                        row.resolution.textMarkupSegments &&
                        row.resolution.textMarkupSegments.length > 0) {
                    quads = [];
                    for (segmentIndex = 0; segmentIndex < row.resolution.textMarkupSegments.length; segmentIndex++) {
                        q = textMarkupSegmentToPdfQuad(
                            row.resolution.textMarkupSegments[segmentIndex], mapEntry.pageInfo, bleeds);
                        quads = quads.concat(q);
                    }
                    rect = makeTextMarkupRect(quads, pdfSize.width, pdfSize.height);
                    annotations.push({
                        type: "highlight",
                        page: mapEntry.pdfPageIndex,
                        rect: rect,
                        quads: quads,
                        text: buildAnnotationBody(row, settings),
                        color: record.color !== "" ? colorKeyToHex(record.color) : colorKeyToHex(settings.defaultColorKey),
                        name: "ppm-indd-" + safeString(record.id) + "-" + counter,
                        creationDate: isoLocalToXfdfDate(record.createdAt),
                        modifiedDate: isoLocalToXfdfDate(record.updatedAt)
                    });
                    continue;
                }
                if (row.resolution.anchorKind === "point") {
                    anchorSpread = [
                        clamp(row.resolution.anchorX, mapEntry.pageInfo.rect.left, mapEntry.pageInfo.rect.right),
                        clamp(row.resolution.anchorY, mapEntry.pageInfo.rect.top, mapEntry.pageInfo.rect.bottom)
                    ];
                } else {
                    frameRect = rectFromBounds(row.resolution.frameBounds);
                    positionKey = record.position !== "" ? record.position : settings.defaultPositionKey;
                    if (positionKey === "auto" || positionKey === "") {
                        positionKey = resolveAutoPositionKey(frameRect, mapEntry.pageInfo.rect, row.resolution.isVertical);
                    }
                    anchorSpread = getFrameAnchorSpreadPoint(frameRect, positionKey);
                    anchorSpread[0] = clamp(anchorSpread[0], mapEntry.pageInfo.rect.left, mapEntry.pageInfo.rect.right);
                    anchorSpread[1] = clamp(anchorSpread[1], mapEntry.pageInfo.rect.top, mapEntry.pageInfo.rect.bottom);
                }
                pdfPoint = spreadPointToPdfPoint(anchorSpread[0], anchorSpread[1], mapEntry.pageInfo, bleeds);
                rect = makeAnnotationRectPdf(pdfPoint, DEFAULT_ANNOT_WIDTH, DEFAULT_ANNOT_HEIGHT, pdfSize.width, pdfSize.height);
                rect = applyAnnotationCollisionOffset(rect, mapEntry.pdfPageIndex, usedRectsByPage, pdfSize.width, pdfSize.height);
                annotations.push({
                    type: "text",
                    page: mapEntry.pdfPageIndex,
                    rect: rect,
                    text: buildAnnotationBody(row, settings),
                    color: record.color !== "" ? colorKeyToHex(record.color) : colorKeyToHex(settings.defaultColorKey),
                    name: "ppm-indd-" + safeString(record.id) + "-" + counter,
                    creationDate: isoLocalToXfdfDate(record.createdAt),
                    modifiedDate: isoLocalToXfdfDate(record.updatedAt)
                });
            } catch (eAnnotation) {
                diagnostics.addExcluded(STATUS_COORD_FAILED);
                diagnostics.errors.push("注釈座標: " + safeString(eAnnotation.message || eAnnotation));
            }
        }
        return annotations;
    }

    // ------------------------------------------------------------------
    // PDF書き出し（InDesign用 exportFile。プリセット自体は変更しない）
    // ------------------------------------------------------------------

    function capturePdfExportPrefs() {
        var saved = {};
        try { saved.pageRange = app.pdfExportPreferences.pageRange; } catch (ePageRange) {}
        try { saved.exportReaderSpreads = app.pdfExportPreferences.exportReaderSpreads; } catch (eSpreads) {}
        try { saved.viewPDF = app.pdfExportPreferences.viewPDF; } catch (eView) {}
        return saved;
    }

    function restorePdfExportPrefs(saved) {
        if (!saved) return;
        try { if (saved.pageRange !== undefined) app.pdfExportPreferences.pageRange = saved.pageRange; } catch (ePageRange) {}
        try { if (saved.exportReaderSpreads !== undefined) app.pdfExportPreferences.exportReaderSpreads = saved.exportReaderSpreads; } catch (eSpreads) {}
        try { if (saved.viewPDF !== undefined) app.pdfExportPreferences.viewPDF = saved.viewPDF; } catch (eView) {}
    }

    function getPdfPresetByName(presetName) {
        var preset;
        if (trim(presetName) === "") return null;
        try {
            preset = app.pdfExportPresets.itemByName(presetName);
            if (isValidDomObject(preset)) return preset;
        } catch (e) {}
        return null;
    }

    function getPdfPresetNames() {
        var result = { names: [], error: "" };
        var presets;
        var i;
        try {
            presets = app.pdfExportPresets.everyItem().getElements();
            for (i = 0; i < presets.length; i++) result.names.push(safeString(presets[i].name));
        } catch (e) {
            result.error = safeString(e.message || e);
        }
        return result;
    }

    function exportPdfSinglePages(documentRef, pdfFile, presetName, pageRangeValue, useAllPages) {
        var savedPrefs = capturePdfExportPrefs();
        var preset = getPdfPresetByName(presetName);
        var tempPreset = null;
        var exportPreset = preset;
        try {
            // 見開きプリセットは一時複製で単ページへ（ユーザーのプリセットは変更しない）
            if (preset) {
                try {
                    if (preset.exportReaderSpreads === true) {
                        tempPreset = preset.duplicate();
                        tempPreset.name = "__ppm_indd_xfdf_temp_" + makeUniqueToken();
                        tempPreset.exportReaderSpreads = false;
                        exportPreset = tempPreset;
                    }
                } catch (eDuplicate) {
                    tempPreset = null;
                    exportPreset = preset;
                }
            }
            try {
                app.pdfExportPreferences.pageRange = useAllPages ? PageRange.ALL_PAGES : pageRangeValue;
            } catch (eRange) {
                throw new Error("ページ範囲を設定できません: " + safeString(eRange.message || eRange));
            }
            try { app.pdfExportPreferences.exportReaderSpreads = false; } catch (eSpreads) {}
            try { app.pdfExportPreferences.viewPDF = false; } catch (eView) {}
            if (exportPreset) {
                documentRef.exportFile(ExportFormat.PDF_TYPE, pdfFile, false, exportPreset);
            } else {
                documentRef.exportFile(ExportFormat.PDF_TYPE, pdfFile, false);
            }
            if (!pdfFile.exists || pdfFile.length <= 0) {
                throw new Error("PDFファイルが生成されませんでした。");
            }
            return true;
        } finally {
            restorePdfExportPrefs(savedPrefs);
            if (tempPreset) {
                try { tempPreset.remove(); } catch (eRemove) {}
            }
        }
    }

    // ------------------------------------------------------------------
    // 安全なファイル確定（Illustrator版から移植）
    // ------------------------------------------------------------------

    function safeRemoveFile(fileRef) {
        try { if (fileRef && fileRef.exists) return fileRef.remove(); } catch (e) {}
        return false;
    }

    function copyFileOrThrow(sourceFile, destinationFile) {
        if (!sourceFile.copy(destinationFile.fsName)) {
            throw new Error(sourceFile.error || "ファイルをコピーできません。");
        }
        if (!destinationFile.exists || destinationFile.length <= 0) {
            throw new Error("コピー先ファイルを確認できません。");
        }
    }

    function makeTemporaryOutputFiles(folder, baseName) {
        var token = makeUniqueToken();
        return {
            pdfFile: new File(folder.fsName + "/." + baseName + ".__indd_xfdf_" + token + ".pdf"),
            xfdfFile: new File(folder.fsName + "/." + baseName + ".__indd_xfdf_" + token + ".xfdf"),
            token: token
        };
    }

    function commitOutputPair(tempFiles, outputFiles) {
        var backupPdf = new File(outputFiles.pdfFile.parent.fsName + "/.__indd_xfdf_backup_" + tempFiles.token + ".pdf");
        var backupXfdf = new File(outputFiles.xfdfFile.parent.fsName + "/.__indd_xfdf_backup_" + tempFiles.token + ".xfdf");
        var hadPdf = outputFiles.pdfFile.exists;
        var hadXfdf = outputFiles.xfdfFile.exists;
        var newPdfCommitted = false;
        var newXfdfCommitted = false;
        try {
            safeRemoveFile(backupPdf);
            safeRemoveFile(backupXfdf);
            if (hadPdf) copyFileOrThrow(outputFiles.pdfFile, backupPdf);
            if (hadXfdf) copyFileOrThrow(outputFiles.xfdfFile, backupXfdf);
            if (hadPdf && !safeRemoveFile(outputFiles.pdfFile) && outputFiles.pdfFile.exists) {
                throw new Error("既存PDFを置き換えられません。");
            }
            if (hadXfdf && !safeRemoveFile(outputFiles.xfdfFile) && outputFiles.xfdfFile.exists) {
                throw new Error("既存XFDFを置き換えられません。");
            }
            copyFileOrThrow(tempFiles.pdfFile, outputFiles.pdfFile);
            newPdfCommitted = true;
            copyFileOrThrow(tempFiles.xfdfFile, outputFiles.xfdfFile);
            newXfdfCommitted = true;
            safeRemoveFile(tempFiles.pdfFile);
            safeRemoveFile(tempFiles.xfdfFile);
            safeRemoveFile(backupPdf);
            safeRemoveFile(backupXfdf);
            return true;
        } catch (e) {
            if (newPdfCommitted) safeRemoveFile(outputFiles.pdfFile);
            if (newXfdfCommitted) safeRemoveFile(outputFiles.xfdfFile);
            try { if (hadPdf && backupPdf.exists) copyFileOrThrow(backupPdf, outputFiles.pdfFile); } catch (eRestorePdf) {}
            try { if (hadXfdf && backupXfdf.exists) copyFileOrThrow(backupXfdf, outputFiles.xfdfFile); } catch (eRestoreXfdf) {}
            safeRemoveFile(backupPdf);
            safeRemoveFile(backupXfdf);
            safeRemoveFile(tempFiles.pdfFile);
            safeRemoveFile(tempFiles.xfdfFile);
            throw e;
        }
    }

    function askOverwriteChoice() {
        var dialog = new Window("dialog", "同名ファイル");
        var text;
        var buttons;
        var overwriteButton;
        var renameButton;
        var cancelButton;
        var choice = "cancel";
        dialog.orientation = "column";
        dialog.alignChildren = ["fill", "top"];
        dialog.margins = 14;
        dialog.spacing = 10;
        text = dialog.add("statictext", undefined, "同名のPDFまたはXFDFが存在します。", { multiline: true });
        text.preferredSize = [360, 36];
        buttons = dialog.add("group");
        buttons.orientation = "row";
        buttons.alignment = "right";
        buttons.spacing = 6;
        overwriteButton = buttons.add("button", undefined, "上書き");
        overwriteButton.preferredSize.width = 80;
        renameButton = buttons.add("button", undefined, "別名で保存");
        renameButton.preferredSize.width = 100;
        cancelButton = buttons.add("button", undefined, "キャンセル", { name: "cancel" });
        cancelButton.preferredSize.width = 80;
        dialog.cancelElement = cancelButton;
        overwriteButton.onClick = function () { choice = "overwrite"; dialog.close(1); };
        renameButton.onClick = function () { choice = "rename"; dialog.close(1); };
        cancelButton.onClick = function () { choice = "cancel"; dialog.close(0); };
        dialog.show();
        return choice;
    }

    function chooseAlternativeBaseName(folder, initialBaseName) {
        var candidate = initialBaseName + "_2";
        var input;
        var sanitized;
        var pdf;
        var xfdf;
        while (true) {
            input = prompt("別名のベース名を入力してください。", candidate, SCRIPT_NAME);
            if (input === null) return null;
            sanitized = sanitizeFileBaseName(input);
            if (!sanitized) {
                alert("ファイル名が不正です。", SCRIPT_NAME, true);
                continue;
            }
            pdf = new File(folder.fsName + "/" + sanitized + ".pdf");
            xfdf = new File(folder.fsName + "/" + sanitized + ".xfdf");
            if (!pdf.exists && !xfdf.exists) return sanitized;
            alert("同名のPDFまたはXFDFが存在します。", SCRIPT_NAME, true);
            candidate = sanitized + "_2";
        }
    }

    function resolveOutputFiles(folder, baseName, confirmOverwrite) {
        var currentBaseName = baseName;
        var pdfFile;
        var xfdfFile;
        var choice;
        while (true) {
            pdfFile = new File(folder.fsName + "/" + currentBaseName + ".pdf");
            xfdfFile = new File(folder.fsName + "/" + currentBaseName + ".xfdf");
            if (!pdfFile.exists && !xfdfFile.exists) break;
            if (!confirmOverwrite) break;
            choice = askOverwriteChoice();
            if (choice === "cancel") return null;
            if (choice === "overwrite") break;
            currentBaseName = chooseAlternativeBaseName(folder, currentBaseName);
            if (currentBaseName === null) return null;
        }
        return {
            baseName: currentBaseName,
            pdfFile: pdfFile,
            xfdfFile: xfdfFile
        };
    }

    // 注釈読み込み後のPDFは元PDFとは別名で保存する。
    // 既存ファイルを上書きしないよう、同名時は _2、_3... を付ける。
    function resolveAcrobatSavedPdfFile(sourcePdfFile, prefix) {
        var folder = sourcePdfFile.parent;
        var sourceBaseName = removeFileExtension(getFileBaseName(sourcePdfFile));
        var baseName = sanitizeFileBaseName(sanitizeFilePrefix(prefix) + sourceBaseName);
        var candidate = new File(folder.fsName + "/" + baseName + ".pdf");
        var suffix = 2;
        var suffixText;
        var suffixedBaseName;
        while (candidate.exists) {
            suffixText = "_" + suffix;
            suffixedBaseName = baseName;
            if (suffixedBaseName.length + suffixText.length > 180) {
                suffixedBaseName = suffixedBaseName.substring(0, 180 - suffixText.length);
            }
            candidate = new File(folder.fsName + "/" + suffixedBaseName + suffixText + ".pdf");
            suffix++;
        }
        return candidate;
    }

    // ------------------------------------------------------------------
    // 設定保存・復元（選択状態・アクティブページ）
    // ------------------------------------------------------------------

    function captureViewState(documentRef) {
        var state = { selection: null, activePageId: -1, zoomPercentage: null };
        var i;
        try {
            state.selection = [];
            for (i = 0; i < app.selection.length; i++) state.selection.push(app.selection[i]);
        } catch (eSelection) {
            state.selection = null;
        }
        try {
            state.activePageId = app.activeWindow.activePage.id;
        } catch (ePage) {}
        try {
            state.zoomPercentage = app.activeWindow.zoomPercentage;
        } catch (eZoom) {}
        return state;
    }

    function restoreViewState(documentRef, state) {
        var i;
        var page;
        if (!state) return;
        if (state.activePageId >= 0) {
            try {
                page = documentRef.pages.itemByID(state.activePageId);
                if (isValidDomObject(page)) app.activeWindow.activePage = page;
            } catch (ePage) {}
        }
        if (state.zoomPercentage !== null) {
            try { app.activeWindow.zoomPercentage = state.zoomPercentage; } catch (eZoom) {}
        }
        if (state.selection !== null) {
            try {
                documentRef.select(NothingEnum.NOTHING);
                for (i = 0; i < state.selection.length; i++) {
                    try {
                        if (isValidDomObject(state.selection[i])) {
                            app.select(state.selection[i], SelectionOptions.ADD_TO);
                        }
                    } catch (eOne) {}
                }
            } catch (eSelect) {}
        }
    }

    function openExportedPdf(pdfFile) {
        try { return pdfFile.execute() === true; } catch (e) { return false; }
    }

    // ------------------------------------------------------------------
    // Acrobat連携（XFDF自動読み込み／別名PDF自動保存）
    //   XFDFは <f href="..."> で元PDFを参照するため、XFDFをAcrobatで開くだけで
    //   Acrobatが参照先PDFを開き、注釈を読み込む。フォルダレベルJavaScriptや
    //   受け渡しファイル・権限操作は一切不要で、Acrobatの版・パッケージング
    //   （従来版／Unified App）に依存しない。
    //   自動保存を指定した場合だけAppleScript経由でAcrobat JavaScriptを実行し、
    //   読み込み後のPDFを別名保存する。失敗時は従来のXFDFオープンへフォールバックする。
    // ------------------------------------------------------------------

    function isMacOs() {
        return /Macintosh|Mac OS/i.test(safeString($.os));
    }

    // AppleScript文字列リテラルへ埋め込むためのエスケープ
    function escapeForAppleScriptString(value) {
        return safeString(value)
            .replace(/\\/g, "\\\\")
            .replace(/"/g, "\\\"");
    }

    // Acrobat JavaScript文字列リテラルへ埋め込むためのエスケープ
    function escapeForJsString(value) {
        return safeString(value)
            .replace(/\\/g, "\\\\")
            .replace(/"/g, "\\\"")
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n");
    }

    // Acrobat JavaScriptが受け取れるデバイス非依存パスへ変換する。
    function toAcrobatDevicePath(fsName) {
        var path = safeString(fsName);
        if (/^[A-Za-z]:[\\\/]/.test(path)) {
            path = "/" + path.charAt(0) + path.substring(2);
        }
        return path.replace(/\\/g, "/");
    }

    // AppleScriptを実行して結果を返す。実行できない場合は null（呼び出し側でフォールバック）。
    // Acrobat自動保存ではApple Eventを送るため、初回だけmacOSの自動化許可が表示される場合がある。
    function runAppleScript(scriptText) {
        if (!isMacOs()) return null;
        try {
            return app.doScript(scriptText, ScriptLanguage.APPLESCRIPT_LANGUAGE);
        } catch (eScript) {
            return null;
        }
    }

    // Acrobat連携の切り分け情報（失敗時に原因を特定するため診断へ蓄積する）
    function getAcrobatDiagnosticInfo(diagnostics) {
        if (!diagnostics.acrobat) {
            diagnostics.acrobat = {
                detection: "",  // Acrobat本体の検出方法
                appPath: ""     // 検出したAcrobatのパス
            };
        }
        return diagnostics.acrobat;
    }

    function describeAcrobatEnvironment(info) {
        return "［連携診断］Acrobat検出: " + (info.detection || "未実行") +
            (info.appPath ? "（" + info.appPath + "）" : "");
    }

    function isAcrobatAppBundleName(name) {
        var value = safeString(name);
        return /\.app$/i.test(value) && /acrobat/i.test(value) && !/distiller/i.test(value);
    }

    // Launch Services（AppleScript）でAcrobatの実体を解決する。
    // インストール先の構成（囲いフォルダの有無・製品名）に依存しないため最も確実。
    function findAcrobatApplicationViaLaunchServices() {
        var queries = [
            "POSIX path of (path to application id \"" + ACROBAT_BUNDLE_ID + "\")",
            "POSIX path of (path to application \"Adobe Acrobat\")"
        ];
        var path;
        var i;
        for (i = 0; i < queries.length; i++) {
            path = safeString(runAppleScript(queries[i]));
            if (!path) continue;
            path = path.replace(/\/+$/, "");    // POSIX pathは末尾に「/」が付く
            if (!path || /distiller/i.test(path)) continue;
            if (new Folder(path).exists || new File(path).exists) {
                return new File(path);
            }
        }
        return null;
    }

    // AppleScriptが使えない環境（Windows等）向けのパス走査フォールバック。
    // 統合インストーラは囲いフォルダ無しで /Applications 直下へ置くため、
    // 「フォルダ内の.app」と「直下の.app」の両方を探索する。
    function findAcrobatApplicationByScan() {
        var candidates = [
            "/Applications/Adobe Acrobat DC/Adobe Acrobat.app",
            "/Applications/Adobe Acrobat/Adobe Acrobat.app",
            "/Applications/Adobe Acrobat Pro DC/Adobe Acrobat Pro.app",
            "/Applications/Adobe Acrobat.app",
            "/Applications/Adobe Acrobat Pro.app"
        ];
        var preferred = null;
        var fallback = null;
        var folders;
        var entries;
        var i;
        var j;
        for (i = 0; i < candidates.length; i++) {
            if (new Folder(candidates[i]).exists) return new File(candidates[i]);
        }
        try {
            // /Applications 直下の .app バンドル
            entries = new Folder("/Applications").getFiles(function (entry) {
                return isAcrobatAppBundleName(entry.name);
            });
            for (i = 0; entries && i < entries.length; i++) {
                if (/reader/i.test(safeString(entries[i].name))) {
                    if (!fallback) fallback = new File(entries[i].fsName);
                } else if (!preferred) {
                    preferred = new File(entries[i].fsName);
                }
            }
            if (preferred) return preferred;
            // Acrobat系フォルダ内の .app バンドル
            folders = new Folder("/Applications").getFiles(function (entry) {
                return entry instanceof Folder && /acrobat/i.test(safeString(entry.name)) &&
                    !/\.app$/i.test(safeString(entry.name));
            });
            for (i = 0; folders && i < folders.length; i++) {
                entries = folders[i].getFiles(function (entry) {
                    return isAcrobatAppBundleName(entry.name);
                });
                for (j = 0; entries && j < entries.length; j++) {
                    if (/reader/i.test(safeString(entries[j].name))) {
                        if (!fallback) fallback = new File(entries[j].fsName);
                    } else {
                        return new File(entries[j].fsName);
                    }
                }
            }
        } catch (eScan) {}
        return fallback;    // Proが無い環境ではReaderを最終候補にする
    }

    // パス走査を先に行い、見つからない場合だけAppleScript（Launch Services）へ頼る。
    // app.doScriptは実行中スクリプトを中断させる可能性があるため、呼ぶ機会を最小化する。
    function findAcrobatApplication(diagnostics) {
        var info = diagnostics ? getAcrobatDiagnosticInfo(diagnostics) : null;
        var appFile = findAcrobatApplicationByScan();
        if (appFile) {
            if (info) {
                info.detection = "パス走査";
                info.appPath = appFile.fsName;
            }
            return appFile;
        }
        appFile = findAcrobatApplicationViaLaunchServices();
        if (info) {
            info.detection = appFile ? "Launch Services" : "検出できず";
            info.appPath = appFile ? appFile.fsName : "";
        }
        return appFile;
    }

    function launchAcrobatApplication(appFile) {
        try { return appFile.execute() === true; } catch (eLaunch) { return false; }
    }

    // 指定アプリでファイルを開く（open -a）。AppleScriptのquoted formを使うため、
    // 空白・日本語・括弧を含むパスでも安全に渡せる。
    function openFileWithApplication(appFile, targetFile) {
        var script = "do shell script \"open -a \" & quoted form of \"" +
            escapeForAppleScriptString(appFile.fsName) + "\" & \" \" & quoted form of \"" +
            escapeForAppleScriptString(targetFile.fsName) + "\"";
        return runAppleScript(script) !== null;
    }

    function activateAcrobatFront(acrobatApp) {
        // File.execute()は起動済みアプリを前面化しないため、確実な手段から順に試す。
        // どれも失敗してもエラー扱いにはしない（読み込み自体は完了しているため）。
        var appletPath = Folder.userData.fsName + "/ppmActivateAcrobat.app";
        var appFile = acrobatApp || findAcrobatApplication(null);
        // 1. 前面化専用アプレットが作成済みならそれを使う（旧環境との互換）
        if ((new Folder(appletPath)).exists || (new File(appletPath)).exists) {
            if (launchAcrobatApplication(new File(appletPath))) return;
        }
        // 2. AppleScriptのdo shell scriptで open -a（アプレット不要・自動化許可も不要）
        if (appFile) {
            if (runAppleScript("do shell script \"open -a \" & quoted form of \"" +
                    escapeForAppleScriptString(appFile.fsName) + "\"") !== null) {
                return;
            }
        }
        // 3. 最終手段
        if (appFile) launchAcrobatApplication(appFile);
    }

    // 旧版（v1.1.x以前）がAcrobatのJavaScriptsフォルダへ設置したフォルダスクリプトと
    // 受け渡しファイルを片付ける。常駐タイマーが残り続けるのを防ぐための後始末で、
    // 失敗しても書き出し結果には影響させない。セッション中は1回だけ実行する。
    function cleanupLegacyAcrobatAutoImportFiles() {
        var cleanupKey = STORE_KEY + "legacyCleanupDone";
        var results = [];
        var seen = {};
        var files;
        var scriptFile;
        var i;
        if ($.global[cleanupKey] === true) return;
        $.global[cleanupKey] = true;
        try {
            collectLegacyJavaScriptsFolders(new Folder(Folder.userData.fsName + "/Adobe/Acrobat"),
                3, results, seen);
            for (i = 0; i < results.length; i++) {
                scriptFile = new File(results[i].fsName + "/indd_xfdf_autoimport.js");
                if (scriptFile.exists) safeRemoveFile(scriptFile);
            }
        } catch (eScript) {}
        try {
            safeRemoveFile(new File(Folder.userData.fsName + "/inddExportPdfXfdfImportQueue.txt"));
            files = new Folder(Folder.userData.fsName).getFiles("inddXfdfAutoimport.*.fdf");
            for (i = 0; files && i < files.length; i++) {
                if (files[i] instanceof File) safeRemoveFile(files[i]);
            }
            files = new Folder(Folder.userData.fsName).getFiles("inddExportPdfXfdfImportQueue.txt.*");
            for (i = 0; files && i < files.length; i++) {
                if (files[i] instanceof File) safeRemoveFile(files[i]);
            }
        } catch (eQueue) {}
    }

    function collectLegacyJavaScriptsFolders(root, depth, results, seen) {
        var entries;
        var name;
        var i;
        if (!root || depth < 0) return;
        try {
            if (!root.exists) return;
            entries = root.getFiles(function (entry) { return entry instanceof Folder; });
        } catch (eList) {
            return;
        }
        for (i = 0; entries && i < entries.length; i++) {
            name = safeString(entries[i].name);
            if (/^JavaScripts$/i.test(name)) {
                if (seen[entries[i].fsName] !== true) {
                    seen[entries[i].fsName] = true;
                    results.push(new Folder(entries[i].fsName));
                }
            } else if (depth > 0) {
                collectLegacyJavaScriptsFolders(entries[i], depth - 1, results, seen);
            }
        }
    }

    // XFDFを開く。XFDFの <f href="..."> により、Acrobatが同じフォルダの元PDFを開いて
    // 注釈を読み込む。受け付けられたら true を返す。
    //
    // 既定アプリで開く File.execute() を最優先にする。これはExtendScript標準の機能だけで
    // 完結し、AppleScript（app.doScript）に依存しない。app.doScriptは実行中のスクリプトを
    // 中断させる場合があり、そうなると後続処理も多重起動ロックの解除も行われないため、
    // 主経路では使わない。macOSでは開いた時点でAcrobatが前面に来るので前面化も不要。
    function openXfdfInAcrobat(xfdfFile, diagnostics) {
        var acrobatApp;
        if (!xfdfFile || !xfdfFile.exists) return false;
        cleanupLegacyAcrobatAutoImportFiles();
        try {
            if (xfdfFile.execute() === true) return true;
        } catch (eExecute) {}
        // 既定アプリが未設定・別アプリの場合のみ、Acrobatを明示指定して開く
        acrobatApp = findAcrobatApplication(diagnostics);
        if (acrobatApp && openFileWithApplication(acrobatApp, xfdfFile)) {
            return true;
        }
        if (!acrobatApp) {
            diagnostics.warnings.push("Adobe Acrobatが見つかりませんでした。" +
                "XFDFの自動読み込みを行わず、通常どおりPDFを開きます。");
            diagnostics.warnings.push(describeAcrobatEnvironment(getAcrobatDiagnosticInfo(diagnostics)));
        } else {
            diagnostics.warnings.push("XFDFを開けませんでした（" + acrobatApp.fsName +
                "）。通常どおりPDFを開きます。");
        }
        return false;
    }

    // Acrobatで元PDFを明示的に開き、XFDFを読み込み、指定先へ別名保存する。
    // フォルダレベルJavaScriptは設置せず、この実行時だけAcrobat JavaScriptを送る。
    function importXfdfAndSaveInAcrobat(pdfFile, xfdfFile, savedPdfFile, diagnostics) {
        var acrobatApp;
        var jsCode;
        var appleScript;
        var resultText;
        var verifiedFile;
        if (!isMacOs()) {
            diagnostics.warnings.push("Acrobatでの別名PDF自動保存はmacOSでのみ利用できます。");
            return false;
        }
        if (!pdfFile || !pdfFile.exists || !xfdfFile || !xfdfFile.exists || !savedPdfFile) {
            diagnostics.warnings.push("Acrobat自動保存に必要なPDFまたはXFDFが見つかりませんでした。");
            return false;
        }
        acrobatApp = findAcrobatApplication(diagnostics);
        if (!acrobatApp) {
            diagnostics.warnings.push("Adobe Acrobatが見つからないため、別名PDFを自動保存できませんでした。");
            diagnostics.warnings.push(describeAcrobatEnvironment(getAcrobatDiagnosticInfo(diagnostics)));
            return false;
        }
        cleanupLegacyAcrobatAutoImportFiles();
        jsCode = "try{" +
            "var d=app.openDoc({cPath:\"" + escapeForJsString(toAcrobatDevicePath(pdfFile.fsName)) + "\"});" +
            "d.importAnXFDF({cPath:\"" + escapeForJsString(toAcrobatDevicePath(xfdfFile.fsName)) + "\"});" +
            "d.saveAs({cPath:\"" + escapeForJsString(toAcrobatDevicePath(savedPdfFile.fsName)) + "\"});" +
            "d.bringToFront();" +
            "event.value=\"OK|\"+d.path;" +
            "}catch(e){event.value=\"ERROR|\"+String(e);}";
        appleScript = "set jsCode to \"" + escapeForAppleScriptString(jsCode) + "\"\n" +
            "tell application id \"" + ACROBAT_BUNDLE_ID + "\"\n" +
            "activate\n" +
            "set resultText to do script jsCode\n" +
            "end tell\n" +
            "return resultText";
        resultText = safeString(runAppleScript(appleScript));
        verifiedFile = new File(savedPdfFile.fsName);
        if (resultText.indexOf("OK|") === 0 && verifiedFile.exists && verifiedFile.length > 0) {
            return true;
        }
        if (resultText.indexOf("ERROR|") === 0) {
            diagnostics.warnings.push("Acrobatで別名PDFを保存できませんでした: " + resultText.substring(6));
        } else {
            diagnostics.warnings.push("Acrobatで別名PDFを保存できませんでした。macOSの「自動化」でInDesignからAcrobatへの操作が許可されているか確認してください。");
        }
        return false;
    }
    // ------------------------------------------------------------------
    // 進捗表示・診断
    // ------------------------------------------------------------------

    function createProgressPalette() {
        var windowRef = new Window("palette", SCRIPT_NAME);
        var statusText;
        var progressBar;
        var closed = false;
        windowRef.orientation = "column";
        windowRef.alignChildren = ["fill", "top"];
        windowRef.margins = 14;
        windowRef.spacing = 10;
        statusText = windowRef.add("statictext", undefined, "準備中...");
        statusText.preferredSize.width = 420;
        progressBar = windowRef.add("progressbar", undefined, 0, 100);
        progressBar.preferredSize = [420, 18];
        windowRef.show();
        try { windowRef.update(); } catch (eShow) {}
        return {
            set: function (value, message) {
                if (closed) return;
                progressBar.value = clamp(Math.round(value), 0, 100);
                if (message !== undefined) statusText.text = safeString(message);
                try { windowRef.update(); } catch (eUpdate) {}
            },
            close: function () {
                if (closed) return;
                closed = true;
                try { windowRef.close(); } catch (eClose) {}
            }
        };
    }

    function makeDiagnostics() {
        var diagnostics = {
            excludedCounts: {},
            excludedTotal: 0,
            errors: [],
            warnings: [],
            savedPdfPath: ""
        };
        diagnostics.addExcluded = function (reason) {
            var key = safeString(reason) || "その他";
            if (!diagnostics.excludedCounts[key]) diagnostics.excludedCounts[key] = 0;
            diagnostics.excludedCounts[key]++;
            diagnostics.excludedTotal++;
        };
        return diagnostics;
    }

    function showExclusionSummary(diagnostics, exportedCount, outputFolder) {
        var lines = [];
        var key;
        var i;
        if (diagnostics.excludedTotal === 0 && diagnostics.errors.length === 0 &&
                diagnostics.warnings.length === 0 && !diagnostics.savedPdfPath) return;
        lines.push("出力した注釈: " + exportedCount + "件");
        if (diagnostics.savedPdfPath) {
            lines.push("Acrobat保存PDF: " + diagnostics.savedPdfPath);
        }
        if (diagnostics.excludedTotal > 0) {
            lines.push("除外したコメント: " + diagnostics.excludedTotal + "件");
            for (key in diagnostics.excludedCounts) {
                if (diagnostics.excludedCounts.hasOwnProperty(key)) {
                    lines.push("  " + key + ": " + diagnostics.excludedCounts[key] + "件");
                }
            }
        }
        if (diagnostics.errors.length > 0) {
            lines.push("エラー: " + diagnostics.errors[0]);
            if (diagnostics.errors.length > 1) lines.push("ほか " + (diagnostics.errors.length - 1) + "件");
        }
        // 警告はAcrobat連携の切り分けに必要なため、すべて表示する
        for (i = 0; i < diagnostics.warnings.length; i++) {
            lines.push((i === 0 ? "警告: " : "      ") + diagnostics.warnings[i]);
        }
        if (outputFolder) lines.push("保存先: " + outputFolder.fsName);
        alert(lines.join("\n"), SCRIPT_NAME, diagnostics.errors.length > 0);
    }

    // ------------------------------------------------------------------
    // 初期保存先・初期ファイル名
    // ------------------------------------------------------------------

    function getInitialOutputFolder(documentRef, store) {
        var folder;
        if (store.outputFolderPath) {
            folder = new Folder(store.outputFolderPath);
            if (folder.exists) return folder;
        }
        try {
            if (documentRef.saved && documentRef.fullName) {
                folder = documentRef.fullName.parent;
                if (folder && folder.exists) return folder;
            }
        } catch (eFullName) {}
        return Folder.desktop;
    }

    function getInitialBaseName(documentRef) {
        var name = "書き出し";
        try {
            name = removeFileExtension(documentRef.name);
        } catch (eName) {}
        name = sanitizeFileBaseName(name);
        return name || "書き出し";
    }

    function getSelectionArray() {
        var result = [];
        var i;
        try {
            for (i = 0; i < app.selection.length; i++) result.push(app.selection[i]);
        } catch (e) {}
        return result;
    }

    // ------------------------------------------------------------------
    // コメント編集UI
    // ------------------------------------------------------------------

    // 共通規則: Command+Returnで確定、Shift+Returnで強制改行、Returnで通常改行。
    function bindCommentInputKeys(memoInput, confirmButton) {
        memoInput.helpTip = "Command+Returnで確定。Returnで改行。";
        memoInput.addEventListener("keydown", function (event) {
            var keyName = safeString(event.keyName).toUpperCase();
            var hasCommand = event.metaKey === true;
            var hasShift = event.shiftKey === true;
            var keyState = null;
            if (keyName !== "ENTER" && keyName !== "RETURN") return;
            try { keyState = ScriptUI.environment.keyboardState; } catch (eKeyboard) {}
            if (keyState) {
                if (event.metaKey === undefined) hasCommand = keyState.metaKey === true;
                if (event.shiftKey === undefined) hasShift = keyState.shiftKey === true;
            }
            // Return単独はwantReturnによる通常入力に任せ、IMEの確定操作を妨げない。
            if (!hasCommand && !hasShift) return;
            try { event.preventDefault(); } catch (ePrevent) {}
            try { event.stopPropagation(); } catch (eStop) {}
            if (hasShift) {
                // Shiftを優先し、選択中の文字列またはカーソル位置へ改行を挿入する。
                memoInput.textselection = "\n";
            } else {
                // 既存ボタンと同じ検証・保存処理を通す。
                confirmButton.onClick();
            }
        }, true);
    }

    function makeColorDropdownItems() {
        var items = ["（既定色）"];
        var options = getColorOptions();
        var i;
        for (i = 0; i < options.length; i++) items.push(options[i].label);
        return items;
    }

    function makePositionDropdownItems() {
        var items = ["（既定位置）"];
        var options = getPositionOptions();
        var i;
        for (i = 0; i < options.length; i++) items.push(options[i].label);
        return items;
    }

    function selectColorDropdown(dropdown, colorKey) {
        if (colorKey === "") {
            dropdown.selection = 0;
            return;
        }
        selectDropdownByText(dropdown, colorKeyToLabel(colorKey), 0);
    }

    function selectPositionDropdown(dropdown, positionKey) {
        if (positionKey === "") {
            dropdown.selection = 0;
            return;
        }
        selectDropdownByText(dropdown, positionKeyToLabel(positionKey), 0);
    }

    function getColorKeyFromDropdown(dropdown) {
        var found;
        if (!dropdown.selection || dropdown.selection.index === 0) return "";
        found = findOptionByLabel(getColorOptions(), dropdown.selection.text);
        return found ? found.key : "";
    }

    function getPositionKeyFromDropdown(dropdown) {
        var found;
        if (!dropdown.selection || dropdown.selection.index === 0) return "";
        found = findOptionByLabel(getPositionOptions(), dropdown.selection.text);
        return found ? found.key : "";
    }

    function describeTargetKind(target) {
        if (target.kind === "textRange") return "文字範囲";
        if (target.kind === "pageItem") return "オブジェクト全体（画像・図形）";
        return "TextFrame全体";
    }

    // コメント編集ダイアログ。戻り値: { action: "close" | "export" | "cancel" }
    function showCommentEditorDialog(documentRef, targets, store) {
        var isMulti = targets.length > 1;
        var target = targets[0];
        var workingRecords = isMulti ? [] : cloneCommentRecordList(getCommentRecordsFromTarget(target.frame));
        var editingId = null;
        var result = { action: "cancel" };
        var dlg = new Window("dialog", "PDFコメント編集");
        var headerText;
        var previewInput;
        var listPanel = null;
        var recordList = null;
        var listButtonRow = null;
        var addButton = null;
        var deleteButton = null;
        var fieldPanel;
        var memoInput;
        var optionRow;
        var colorDropdown;
        var positionDropdown;
        var enabledCheckbox;
        var buttonRow;
        var cancelButton;
        var exportButton;
        var closeButton;
        var i;

        dlg.orientation = "column";
        dlg.alignChildren = ["fill", "top"];
        dlg.margins = 14;
        dlg.spacing = 8;
        try { dlg.opacity = COMMENT_DIALOG_OPACITY; } catch (eOpacity) {}

        headerText = dlg.add("statictext", undefined, isMulti ?
            "対象: " + targets.length + " 個のオブジェクト（同一コメントを各対象へ登録）" :
            "対象: " + describeTargetKind(target));
        headerText.characters = 60;

        previewInput = dlg.add("edittext", undefined,
            isMulti ? "（複数フレーム選択中）" : makeListText(target.previewText, 280),
            { multiline: true, scrolling: true, readonly: true });
        previewInput.preferredSize = [520, 52];

        if (!isMulti) {
            listPanel = dlg.add("panel", undefined, "既存コメント");
            listPanel.orientation = "column";
            listPanel.alignChildren = ["fill", "top"];
            listPanel.margins = 10;
            listPanel.spacing = 6;
            recordList = listPanel.add("listbox", undefined, "", {
                numberOfColumns: 5,
                showHeaders: true,
                columnTitles: ["出力", "種別", "色", "位置", "コメント"],
                columnWidths: [38, 70, 70, 62, 260]
            });
            recordList.preferredSize = [520, 120];
            listButtonRow = listPanel.add("group");
            listButtonRow.orientation = "row";
            listButtonRow.alignment = "right";
            listButtonRow.spacing = 6;
            addButton = listButtonRow.add("button", undefined, "新規追加");
            deleteButton = listButtonRow.add("button", undefined, "削除");
        }

        fieldPanel = dlg.add("panel", undefined, "コメント内容");
        fieldPanel.orientation = "column";
        fieldPanel.alignChildren = ["fill", "top"];
        fieldPanel.margins = 10;
        fieldPanel.spacing = 6;
        memoInput = fieldPanel.add("edittext", undefined, "", { multiline: true, scrolling: true, wantReturn: true });
        memoInput.preferredSize = [520, 140];
        optionRow = fieldPanel.add("group");
        optionRow.orientation = "row";
        optionRow.alignChildren = ["left", "center"];
        optionRow.spacing = 6;
        optionRow.add("statictext", undefined, "色:");
        colorDropdown = optionRow.add("dropdownlist", undefined, makeColorDropdownItems());
        colorDropdown.preferredSize.width = 110;
        colorDropdown.selection = 0;
        optionRow.add("statictext", undefined, "位置:");
        positionDropdown = optionRow.add("dropdownlist", undefined, makePositionDropdownItems());
        positionDropdown.preferredSize.width = 110;
        positionDropdown.selection = 0;
        enabledCheckbox = optionRow.add("checkbox", undefined, "PDFへ出力する");
        enabledCheckbox.value = true;

        buttonRow = dlg.add("group");
        buttonRow.orientation = "row";
        buttonRow.alignment = "right";
        buttonRow.margins = [10, 5, 10, 5];
        buttonRow.spacing = 6;
        cancelButton = buttonRow.add("button", undefined, "キャンセル", { name: "cancel" });
        cancelButton.preferredSize.width = 90;
        exportButton = buttonRow.add("button", undefined, "反映してPDF書き出し");
        exportButton.preferredSize.width = 160;
        closeButton = buttonRow.add("button", undefined, "反映して閉じる", { name: "ok" });
        closeButton.preferredSize.width = 130;
        dlg.defaultElement = closeButton;
        dlg.cancelElement = cancelButton;

        function findWorkingRecordById(recordId) {
            var n;
            for (n = 0; n < workingRecords.length; n++) {
                if (workingRecords[n].id === recordId) return workingRecords[n];
            }
            return null;
        }

        function loadRecordToFields(record) {
            memoInput.text = record.memo;
            selectColorDropdown(colorDropdown, record.color);
            selectPositionDropdown(positionDropdown, record.position);
            enabledCheckbox.value = record.enabled === "1";
        }

        function clearFields() {
            memoInput.text = "";
            colorDropdown.selection = 0;
            positionDropdown.selection = 0;
            enabledCheckbox.value = true;
        }

        function applyTargetToRecord(record) {
            if (target.kind === "textRange" && target.rangeInfo) {
                record.targetType = "textRange";
                record.rangeText = limitTextLength(target.rangeInfo.text, MAX_RANGE_TEXT_LENGTH);
                record.rangeStart = String(target.rangeInfo.startIndex);
                record.rangeLength = String(target.rangeInfo.length);
                record.rangePrefix = safeString(target.rangeInfo.prefix);
                record.rangeSuffix = safeString(target.rangeInfo.suffix);
                record.rangeStoryId = safeString(target.rangeInfo.storyId);
            } else {
                record.targetType = target.kind === "pageItem" ? "pageItem" : "textFrame";
                record.rangeText = "";
                record.rangeStart = "";
                record.rangeLength = "";
                record.rangePrefix = "";
                record.rangeSuffix = "";
                record.rangeStoryId = "";
            }
        }

        // 入力欄の内容を編集中レコード（または新規レコード）へ反映する
        function commitFieldsToWorking() {
            var memoText = normalizeMemoText(memoInput.text);
            var colorKey = getColorKeyFromDropdown(colorDropdown);
            var positionKey = getPositionKeyFromDropdown(positionDropdown);
            var enabledValue = enabledCheckbox.value === true ? "1" : "0";
            var record = editingId !== null ? findWorkingRecordById(editingId) : null;
            var changed;
            if (record) {
                changed = record.memo !== memoText || record.color !== colorKey ||
                    record.position !== positionKey || record.enabled !== enabledValue;
                if (changed) {
                    record.memo = limitTextLength(memoText, MAX_MEMO_TEXT_LENGTH);
                    record.color = colorKey;
                    record.position = positionKey;
                    record.enabled = enabledValue;
                    record.updatedAt = nowIsoLocalString();
                }
                return record;
            }
            if (trim(memoText) === "") return null;
            record = createCommentRecord();
            record.memo = limitTextLength(memoText, MAX_MEMO_TEXT_LENGTH);
            record.color = colorKey;
            record.position = positionKey;
            record.enabled = enabledValue;
            applyTargetToRecord(record);
            workingRecords.push(record);
            editingId = record.id;
            return record;
        }

        function rebuildRecordList(selectId) {
            var n;
            var item;
            var record;
            if (!recordList) return;
            try { recordList.selection = null; } catch (eSelection) {}
            try { recordList.removeAll(); } catch (eRemove) {}
            for (n = 0; n < workingRecords.length; n++) {
                record = workingRecords[n];
                item = recordList.add("item", record.enabled === "1" ? "○" : "－");
                item.subItems[0].text = record.targetType === "textRange" ? "文字範囲" :
                    (record.targetType === "pageItem" ? "オブジェクト" : "フレーム");
                item.subItems[1].text = record.color === "" ? "既定" : colorKeyToLabel(record.color);
                item.subItems[2].text = record.position === "" ? "既定" : positionKeyToLabel(record.position);
                item.subItems[3].text = makeListText(record.memo, 40);
                if (selectId !== undefined && record.id === selectId) {
                    try { recordList.selection = n; } catch (eSelect) {}
                }
            }
        }

        function handleListSelectionChange() {
            var indices = getSelectedListIndices(recordList);
            var record;
            if (indices.length !== 1) return;
            record = workingRecords[indices[0]];
            if (!record || record.id === editingId) return;
            commitFieldsToWorking();
            editingId = record.id;
            loadRecordToFields(record);
            rebuildRecordList(editingId);
        }

        if (!isMulti) {
            recordList.onChange = handleListSelectionChange;
            addButton.onClick = function () {
                commitFieldsToWorking();
                editingId = null;
                clearFields();
                try { recordList.selection = null; } catch (eSelection) {}
                rebuildRecordList();
                try { memoInput.active = true; } catch (eActive) {}
            };
            deleteButton.onClick = function () {
                var indices = getSelectedListIndices(recordList);
                var kept = [];
                var removeIds = {};
                var n;
                if (indices.length === 0) {
                    alert("削除するコメントを一覧から選択してください。", SCRIPT_NAME, true);
                    return;
                }
                if (!confirm("選択した " + indices.length + " 件のコメントを削除しますか？", false, SCRIPT_NAME)) return;
                for (n = 0; n < indices.length; n++) {
                    if (workingRecords[indices[n]]) removeIds["r" + workingRecords[indices[n]].id] = true;
                }
                for (n = 0; n < workingRecords.length; n++) {
                    if (removeIds["r" + workingRecords[n].id] !== true) kept.push(workingRecords[n]);
                }
                workingRecords = kept;
                if (editingId !== null && removeIds["r" + editingId] === true) {
                    editingId = null;
                    clearFields();
                }
                rebuildRecordList(editingId !== null ? editingId : undefined);
            };
        }

        function commitAndSave() {
            var operations = [];
            var filtered = [];
            var n;
            var record;
            var errorText;
            if (isMulti) {
                var memoText = normalizeMemoText(memoInput.text);
                if (trim(memoText) === "") {
                    alert("コメント本文を入力してください。", SCRIPT_NAME, true);
                    try { memoInput.active = true; } catch (eActive) {}
                    return false;
                }
                for (n = 0; n < targets.length; n++) {
                    record = createCommentRecord();
                    record.memo = limitTextLength(memoText, MAX_MEMO_TEXT_LENGTH);
                    record.color = getColorKeyFromDropdown(colorDropdown);
                    record.position = getPositionKeyFromDropdown(positionDropdown);
                    record.enabled = enabledCheckbox.value === true ? "1" : "0";
                    record.targetType = targets[n].kind === "pageItem" ? "pageItem" : "textFrame";
                    operations.push({
                        frame: targets[n].frame,
                        records: getCommentRecordsFromTarget(targets[n].frame).concat([record])
                    });
                }
            } else {
                commitFieldsToWorking();
                for (n = 0; n < workingRecords.length; n++) {
                    if (trim(workingRecords[n].memo) !== "") filtered.push(workingRecords[n]);
                }
                operations.push({ frame: target.frame, records: filtered });
            }
            errorText = saveCommentRecordsWithUndo(operations, "PDFコメントを編集");
            if (errorText) {
                alert("コメントの保存に失敗しました:\n" + errorText, SCRIPT_NAME, true);
                return false;
            }
            return true;
        }

        closeButton.onClick = function () {
            if (!commitAndSave()) return;
            result.action = "close";
            saveDialogPosition(dlg, store, "editorDialogLocation");
            dlg.close(1);
        };
        exportButton.onClick = function () {
            if (!commitAndSave()) return;
            result.action = "export";
            saveDialogPosition(dlg, store, "editorDialogLocation");
            dlg.close(1);
        };
        cancelButton.onClick = function () {
            result.action = "cancel";
            saveDialogPosition(dlg, store, "editorDialogLocation");
            dlg.close(0);
        };

        dlg.onMove = function () {
            saveDialogPosition(dlg, store, "editorDialogLocation");
        };
        dlg.onShow = function () {
            restoreDialogPosition(dlg, store, "editorDialogLocation");
            try { memoInput.active = true; } catch (eActive) {}
        };

        if (!isMulti) {
            // 同一文字範囲の既存コメントがあれば編集対象として読み込む
            if (target.kind === "textRange" && target.rangeInfo) {
                for (i = 0; i < workingRecords.length; i++) {
                    if (workingRecords[i].targetType === "textRange" &&
                            getRangeKey(recordToRangeInfo(workingRecords[i])) === getRangeKey(target.rangeInfo)) {
                        editingId = workingRecords[i].id;
                        loadRecordToFields(workingRecords[i]);
                        break;
                    }
                }
            }
            rebuildRecordList(editingId !== null ? editingId : undefined);
        }

        bindCommentInputKeys(memoInput, closeButton);
        dlg.show();
        return result;
    }

    // 書き出しダイアログからの単一コメント編集
    function showSingleRecordEditDialog(record, store) {
        var dlg = new Window("dialog", "コメント編集");
        var memoInput;
        var optionRow;
        var colorDropdown;
        var positionDropdown;
        var enabledCheckbox;
        var buttons;
        var cancelButton;
        var okButton;
        var result = null;
        dlg.orientation = "column";
        dlg.alignChildren = ["fill", "top"];
        dlg.margins = 14;
        dlg.spacing = 8;
        try { dlg.opacity = COMMENT_DIALOG_OPACITY; } catch (eOpacity) {}
        dlg.add("statictext", undefined, record.targetType === "textRange" ?
            "対象: 文字範囲「" + makeListText(record.rangeText, 40) + "」" :
            (record.targetType === "pageItem" ? "対象: オブジェクト全体（画像・図形）" : "対象: TextFrame全体"));
        memoInput = dlg.add("edittext", undefined, record.memo, { multiline: true, scrolling: true, wantReturn: true });
        memoInput.preferredSize = [480, 160];
        optionRow = dlg.add("group");
        optionRow.orientation = "row";
        optionRow.spacing = 6;
        optionRow.add("statictext", undefined, "色:");
        colorDropdown = optionRow.add("dropdownlist", undefined, makeColorDropdownItems());
        colorDropdown.preferredSize.width = 110;
        selectColorDropdown(colorDropdown, record.color);
        optionRow.add("statictext", undefined, "位置:");
        positionDropdown = optionRow.add("dropdownlist", undefined, makePositionDropdownItems());
        positionDropdown.preferredSize.width = 110;
        selectPositionDropdown(positionDropdown, record.position);
        enabledCheckbox = optionRow.add("checkbox", undefined, "PDFへ出力する");
        enabledCheckbox.value = record.enabled === "1";
        buttons = dlg.add("group");
        buttons.orientation = "row";
        buttons.alignment = "right";
        buttons.spacing = 6;
        cancelButton = buttons.add("button", undefined, "キャンセル", { name: "cancel" });
        okButton = buttons.add("button", undefined, "反映", { name: "ok" });
        dlg.defaultElement = okButton;
        dlg.cancelElement = cancelButton;
        okButton.onClick = function () {
            var memoText = normalizeMemoText(memoInput.text);
            if (trim(memoText) === "") {
                alert("コメント本文を空にはできません。削除する場合は一覧の「削除」を使用してください。", SCRIPT_NAME, true);
                try { memoInput.active = true; } catch (eActive) {}
                return;
            }
            result = {
                memo: limitTextLength(memoText, MAX_MEMO_TEXT_LENGTH),
                color: getColorKeyFromDropdown(colorDropdown),
                position: getPositionKeyFromDropdown(positionDropdown),
                enabled: enabledCheckbox.value === true ? "1" : "0"
            };
            dlg.close(1);
        };
        bindCommentInputKeys(memoInput, okButton);
        if (dlg.show() !== 1) return null;
        return result;
    }

    // ------------------------------------------------------------------
    // コメント一覧データの構築
    // ------------------------------------------------------------------

    function buildCommentRows(documentRef, pageInfoCache) {
        var entries = collectFramesWithComments(documentRef);
        var rows = [];
        var i;
        withCoordinateEnvironment(documentRef, function () {
            for (i = 0; i < entries.length; i++) {
                var resolution;
                try {
                    resolution = resolveCommentEntry(documentRef, entries[i], pageInfoCache);
                } catch (eResolve) {
                    resolution = {
                        baseStatus: STATUS_INVALID,
                        flags: { hidden: false, hiddenLayer: false, nonPrinting: false, locked: false },
                        isMaster: false,
                        pageInfo: null,
                        anchorKind: "frame",
                        frameBounds: null,
                        anchorX: 0,
                        anchorY: 0,
                        isVertical: false,
                        targetLabel: ""
                    };
                }
                rows.push({ entry: entries[i], resolution: resolution });
            }
            return null;
        });
        rows.sort(function (a, b) {
            var pa = a.resolution.pageInfo ? a.resolution.pageInfo.documentOffset : 99999;
            var pb = b.resolution.pageInfo ? b.resolution.pageInfo.documentOffset : 99999;
            if (pa !== pb) return pa - pb;
            if (a.resolution.targetLabel < b.resolution.targetLabel) return -1;
            if (a.resolution.targetLabel > b.resolution.targetLabel) return 1;
            return 0;
        });
        return rows;
    }

    // ------------------------------------------------------------------
    // ページ選択（サムネイル一覧）
    // ------------------------------------------------------------------

    var PAGE_THUMB_BG_COLOR = [0.62, 0.62, 0.62, 1];
    var PAGE_THUMB_PAPER_COLOR = [1, 1, 1, 1];
    var PAGE_THUMB_PAPER_EDGE_COLOR = [0.45, 0.45, 0.45, 1];
    var PAGE_THUMB_SELECTED_COLOR = [0.15, 0.45, 0.95, 1];
    var PAGE_THUMB_SELECTED_WIDTH = 3;
    var PAGE_THUMB_NORMAL_COLOR = [0.5, 0.5, 0.5, 1];
    var PAGE_THUMB_NORMAL_WIDTH = 1;

    // 書き出しプリファレンスの控えと復元の順序（範囲→ページ指定の順を守る）
    var PNG_THUMB_PREF_KEYS = [
        "pngQuality", "exportResolution", "pngColorSpace", "transparentBackground",
        "antiAlias", "useDocumentBleeds", "simulateOverprint",
        "exportingSpread", "pngExportRange", "pageString", "pngSuffix"
    ];

    function isCommentRowCountable(row, filterSettings) {
        var effective = getEffectiveStatus(row.resolution, filterSettings);
        return effective.exportable && row.entry.record.enabled === "1" && row.resolution.pageInfo ? true : false;
    }

    // 出力対象コメントのあるページの documentOffset（昇順・重複なし）
    function collectCommentPageOffsets(rows, filterSettings) {
        var offsets = [];
        var seen = {};
        var n;
        var key;
        for (n = 0; n < rows.length; n++) {
            if (!isCommentRowCountable(rows[n], filterSettings)) continue;
            key = "o" + rows[n].resolution.pageInfo.documentOffset;
            if (seen[key] !== true) {
                seen[key] = true;
                offsets.push(rows[n].resolution.pageInfo.documentOffset);
            }
        }
        offsets.sort(function (a, b) { return a - b; });
        return offsets;
    }

    function countCommentsByPageOffset(rows, filterSettings) {
        var counts = {};
        var n;
        var key;
        for (n = 0; n < rows.length; n++) {
            if (!isCommentRowCountable(rows[n], filterSettings)) continue;
            key = "o" + rows[n].resolution.pageInfo.documentOffset;
            counts[key] = (counts[key] || 0) + 1;
        }
        return counts;
    }

    function isSameNumberList(listA, listB) {
        var i;
        if (!listA || !listB || listA.length !== listB.length) return false;
        for (i = 0; i < listA.length; i++) {
            if (listA[i] !== listB[i]) return false;
        }
        return true;
    }

    function sortUniqueNumbers(values) {
        var sorted = values.slice(0);
        var result = [];
        var i;
        sorted.sort(function (a, b) { return a - b; });
        for (i = 0; i < sorted.length; i++) {
            if (result.length === 0 || result[result.length - 1] !== sorted[i]) result.push(sorted[i]);
        }
        return result;
    }

    // ページ名で書けるならページ名、紛らわしければ +絶対番号
    function makePageTokenForRange(documentRef, offset, name) {
        var text = safeString(name);
        if (text !== "" && text === trim(text) && text.indexOf(",") < 0 && text.indexOf("-") < 0 &&
                resolvePageToken(documentRef, text) === offset) {
            return text;
        }
        return "+" + (offset + 1);
    }

    function buildAbsolutePageRangeText(sortedOffsets) {
        var parts = [];
        var i = 0;
        var start;
        var end;
        while (i < sortedOffsets.length) {
            start = sortedOffsets[i];
            end = start;
            while (i + 1 < sortedOffsets.length && sortedOffsets[i + 1] === end + 1) {
                i++;
                end = sortedOffsets[i];
            }
            parts.push(start === end ? "+" + (start + 1) : "+" + (start + 1) + "-+" + (end + 1));
            i++;
        }
        return parts.join(",");
    }

    // 選んだページを「指定ページ範囲」の文字列にする。読み戻して一致しなければ絶対番号で書く
    function buildPageRangeTextFromOffsets(documentRef, offsets, namesByOffset) {
        var sorted = sortUniqueNumbers(offsets);
        var parts = [];
        var i = 0;
        var start;
        var end;
        var left;
        var right;
        var combined;
        var text;
        var parsed;
        if (sorted.length === 0) return "";
        while (i < sorted.length) {
            start = sorted[i];
            end = start;
            while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
                i++;
                end = sorted[i];
            }
            left = makePageTokenForRange(documentRef, start, namesByOffset["o" + start]);
            if (start === end) {
                parts.push(left);
            } else {
                right = makePageTokenForRange(documentRef, end, namesByOffset["o" + end]);
                combined = left + "-" + right;
                // 「A-B」がそのままページ名として存在すると単ページに解釈されるため避ける
                if (resolvePageToken(documentRef, combined) >= 0) {
                    combined = "+" + (start + 1) + "-+" + (end + 1);
                }
                parts.push(combined);
            }
            i++;
        }
        text = parts.join(",");
        try {
            parsed = parseCustomPageRange(documentRef, text);
        } catch (eParse) {
            parsed = { offsets: [], error: "parse" };
        }
        if (parsed.error !== "" || !isSameNumberList(parsed.offsets, sorted)) {
            text = buildAbsolutePageRangeText(sorted);
        }
        return text;
    }

    function getDocumentPageArray(documentRef) {
        var result = [];
        var count;
        var i;
        try {
            return documentRef.pages.everyItem().getElements();
        } catch (eElements) {}
        try {
            count = documentRef.pages.length;
            for (i = 0; i < count; i++) result.push(documentRef.pages[i]);
        } catch (eLoop) {}
        return result;
    }

    // 一覧に出すページ情報（寸法はpt。座標環境内で読む）
    function collectPickerPages(documentRef, countsByOffset) {
        var pages = [];
        withCoordinateEnvironment(documentRef, function () {
            var pageRefs = getDocumentPageArray(documentRef);
            var i;
            var page;
            var info;
            var bounds;
            for (i = 0; i < pageRefs.length; i++) {
                page = pageRefs[i];
                info = { offset: i, id: "", name: "", width: 0, height: 0, masterName: "", commentCount: 0 };
                try { info.id = safeString(page.id); } catch (eId) {}
                try { info.name = safeString(page.name); } catch (eName) {}
                try { info.offset = Number(page.documentOffset); } catch (eOffset) {}
                try {
                    bounds = page.bounds;
                    info.width = Math.abs(Number(bounds[3]) - Number(bounds[1]));
                    info.height = Math.abs(Number(bounds[2]) - Number(bounds[0]));
                } catch (eBounds) {}
                try {
                    if (page.appliedMaster && page.appliedMaster.isValid) {
                        info.masterName = safeString(page.appliedMaster.name);
                    }
                } catch (eMaster) {}
                if (info.id === "") info.id = "i" + i;
                info.commentCount = countsByOffset["o" + info.offset] || 0;
                pages.push(info);
            }
            return null;
        });
        pages.sort(function (a, b) { return a.offset - b.offset; });
        return pages;
    }

    function getPickerPageLabel(page) {
        return page.name !== "" ? page.name : "+" + (page.offset + 1);
    }

    // サムネイルは書き出しダイアログを開いている間だけ一時フォルダに持つ
    function createThumbnailStore() {
        return { folder: null, files: [], images: {}, failed: {}, disabledReason: "" };
    }

    function getThumbnailFolder(thumbStore) {
        var folder;
        if (thumbStore.folder && thumbStore.folder.exists) return thumbStore.folder;
        folder = new Folder(Folder.temp.fsName + "/inddXfdfPageThumbs_" + makeUniqueToken());
        if (!folder.exists && !folder.create()) throw new Error("一時フォルダを作成できません。");
        thumbStore.folder = folder;
        return folder;
    }

    function disposeThumbnailStore(thumbStore) {
        var i;
        var leftovers;
        if (!thumbStore) return;
        thumbStore.images = {};
        for (i = 0; i < thumbStore.files.length; i++) safeRemoveFile(thumbStore.files[i]);
        thumbStore.files = [];
        if (thumbStore.folder) {
            try {
                leftovers = thumbStore.folder.getFiles();
                for (i = 0; i < leftovers.length; i++) {
                    if (leftovers[i] instanceof File) safeRemoveFile(leftovers[i]);
                }
                thumbStore.folder.remove();
            } catch (eFolder) {}
            thumbStore.folder = null;
        }
    }

    function capturePngExportPrefs(prefs) {
        var saved = {};
        var i;
        for (i = 0; i < PNG_THUMB_PREF_KEYS.length; i++) {
            try { saved[PNG_THUMB_PREF_KEYS[i]] = prefs[PNG_THUMB_PREF_KEYS[i]]; } catch (eRead) {}
        }
        return saved;
    }

    function restorePngExportPrefs(prefs, saved) {
        var i;
        var key;
        for (i = 0; i < PNG_THUMB_PREF_KEYS.length; i++) {
            key = PNG_THUMB_PREF_KEYS[i];
            if (saved[key] === undefined) continue;
            try { prefs[key] = saved[key]; } catch (eWrite) {}
        }
    }

    function setOptionalPref(prefs, key, value) {
        try { prefs[key] = value; } catch (eSet) {}
    }

    // 最大辺が PAGE_THUMB_BOX_PX に収まる解像度
    function getThumbnailResolution(page) {
        var longest = Math.max(page.width, page.height);
        if (!(longest > 0)) return 0;
        return Math.floor(clamp(72 * PAGE_THUMB_BOX_PX / longest, PAGE_THUMB_MIN_PPI, PAGE_THUMB_MAX_PPI) * 100) / 100;
    }

    function exportOnePageThumbnail(documentRef, prefs, page, folder, thumbStore) {
        var ppi = getThumbnailResolution(page);
        var file = new File(folder.fsName + "/p" + page.offset + "_" + makeUniqueToken() + ".png");
        var readPpi;
        var readPages;
        if (!(ppi > 0)) return null;
        try {
            prefs.exportResolution = ppi;
        } catch (eResolution) {
            try {
                prefs.exportResolution = Math.max(PAGE_THUMB_MIN_PPI, Math.floor(ppi));
            } catch (eResolution2) {
                return null;
            }
        }
        // 解像度が効いていないと高解像度で書き出して重くなるため、書き出さない
        try { readPpi = Number(prefs.exportResolution); } catch (eReadPpi) { readPpi = NaN; }
        if (!(readPpi > 0) || readPpi > PAGE_THUMB_MAX_PPI + 0.5) return null;
        try {
            prefs.pageString = "+" + (page.offset + 1);
        } catch (ePageString) {
            return null;
        }
        try { readPages = safeString(prefs.pageString); } catch (eReadPages) { readPages = ""; }
        if (trim(readPages) === "") return null;
        try {
            documentRef.exportFile(ExportFormat.PNG_FORMAT, file, false);
        } catch (eExport) {
            safeRemoveFile(file);
            return null;
        }
        if (!file.exists) return null;
        thumbStore.files.push(file);
        try {
            return ScriptUI.newImage(file);
        } catch (eImage) {
            return null;
        }
    }

    // 未作成のサムネイルだけ書き出す。onProgress(完了数, 総数, 完了したページ|null) は各ページの前後に呼ぶ
    function renderPageThumbnails(documentRef, thumbStore, pages, onProgress) {
        var targets = [];
        var prefs;
        var savedPrefs;
        var savedLevel = null;
        var hasSavedLevel = false;
        var folder;
        var image;
        var key;
        var i;
        var rangeValue = null;
        for (i = 0; i < pages.length; i++) {
            key = "p" + pages[i].id;
            if (!thumbStore.images[key] && thumbStore.failed[key] !== true) targets.push(pages[i]);
        }
        if (targets.length === 0 || thumbStore.disabledReason !== "") return;
        try {
            prefs = app.pngExportPreferences;
            rangeValue = PNGExportRangeEnum.EXPORT_RANGE;
        } catch (ePrefs) {
            thumbStore.disabledReason = "サムネイルを作成できません";
            return;
        }
        savedPrefs = capturePngExportPrefs(prefs);
        try {
            savedLevel = app.scriptPreferences.userInteractionLevel;
            hasSavedLevel = true;
        } catch (eLevel) {}
        try {
            try { app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT; } catch (eNever) {}
            setOptionalPref(prefs, "pngQuality", PNGQualityEnum.MEDIUM);
            setOptionalPref(prefs, "pngColorSpace", PNGColorSpaceEnum.RGB);
            setOptionalPref(prefs, "transparentBackground", false);
            setOptionalPref(prefs, "antiAlias", true);
            setOptionalPref(prefs, "useDocumentBleeds", false);
            setOptionalPref(prefs, "simulateOverprint", false);
            setOptionalPref(prefs, "exportingSpread", false);
            setOptionalPref(prefs, "pngSuffix", "");
            // 範囲指定が効かないと全ページを書き出してしまうため、読み戻して確認する
            try {
                prefs.pngExportRange = rangeValue;
            } catch (eRange) {}
            if (prefs.pngExportRange != rangeValue) {
                thumbStore.disabledReason = "サムネイルを作成できません";
                return;
            }
            folder = getThumbnailFolder(thumbStore);
            for (i = 0; i < targets.length; i++) {
                key = "p" + targets[i].id;
                if (onProgress) onProgress(i, targets.length, null);
                image = exportOnePageThumbnail(documentRef, prefs, targets[i], folder, thumbStore);
                if (image) {
                    thumbStore.images[key] = image;
                } else {
                    thumbStore.failed[key] = true;
                }
                if (onProgress) onProgress(i + 1, targets.length, targets[i]);
            }
        } catch (eRender) {
            thumbStore.disabledReason = "サムネイルを作成できません";
        } finally {
            restorePngExportPrefs(prefs, savedPrefs);
            if (hasSavedLevel) {
                try { app.scriptPreferences.userInteractionLevel = savedLevel; } catch (eRestoreLevel) {}
            }
        }
    }

    // サムネイル＋ページ名の一覧からページを選ぶ。戻り値は documentOffset の配列（キャンセルは null）
    function showPagePickerDialog(documentRef, store, pages, initialOffsets, thumbStore, reportPreparing) {
        var perScreen = PAGE_PICKER_COLUMNS * PAGE_PICKER_ROWS;
        var cellSize = PAGE_THUMB_BOX_PX + PAGE_THUMB_CELL_PADDING * 2;
        var selected = {};
        var indexByOffset = {};
        var namesByOffset = {};
        var firstIndex = 0;
        var lastClickedIndex = -1;
        var slots = [];
        var busy = false;
        var result = null;
        var dlg;
        var topRow;
        var selectAllButton;
        var clearButton;
        var commentButton;
        var thumbCheckbox;
        var progressText;
        var gridPanel;
        var navRow;
        var prevButton;
        var navText;
        var nextButton;
        var statusText;
        var buttonGroup;
        var cancelButton;
        var okButton;
        var rowGroup;
        var r;
        var c;
        var n;
        var firstSelectedIndex = -1;

        for (n = 0; n < pages.length; n++) {
            indexByOffset["o" + pages[n].offset] = n;
            namesByOffset["o" + pages[n].offset] = pages[n].name;
        }
        for (n = 0; n < initialOffsets.length; n++) {
            if (indexByOffset["o" + initialOffsets[n]] === undefined) continue;
            selected["o" + initialOffsets[n]] = true;
            if (firstSelectedIndex < 0 || indexByOffset["o" + initialOffsets[n]] < firstSelectedIndex) {
                firstSelectedIndex = indexByOffset["o" + initialOffsets[n]];
            }
        }
        // 最初に選ばれているページを含む画面から開く
        if (firstSelectedIndex > 0) firstIndex = Math.floor(firstSelectedIndex / perScreen) * perScreen;

        function isThumbnailOn() {
            return thumbCheckbox && thumbCheckbox.value === true;
        }

        function isPageSelected(page) {
            return page && selected["o" + page.offset] === true;
        }

        function setPageSelected(page, value) {
            if (!page) return;
            if (value) {
                selected["o" + page.offset] = true;
            } else {
                delete selected["o" + page.offset];
            }
        }

        function getSelectedOffsets() {
            var offsets = [];
            var k;
            for (k = 0; k < pages.length; k++) {
                if (isPageSelected(pages[k])) offsets.push(pages[k].offset);
            }
            return offsets;
        }

        function drawThumbCanvas() {
            var canvas = this;
            var g = canvas.graphics;
            var slot = canvas.__slot;
            var page = slot ? slot.page : null;
            var image = null;
            var w;
            var h;
            var imageSize;
            var drawW;
            var drawH;
            var scale;
            var paperW;
            var paperH;
            var borderWidth;
            var drawn = false;
            try {
                w = canvas.size[0];
                h = canvas.size[1];
            } catch (eSize) {
                return;
            }
            try {
                g.newPath();
                g.rectPath(0, 0, w, h);
                g.fillPath(g.newBrush(g.BrushType.SOLID_COLOR, PAGE_THUMB_BG_COLOR));
            } catch (eBackground) {}
            if (!page) return;
            if (isThumbnailOn()) image = thumbStore.images["p" + page.id] || null;
            if (image) {
                try {
                    imageSize = image.size;
                    drawW = imageSize[0];
                    drawH = imageSize[1];
                    scale = Math.min(1, PAGE_THUMB_BOX_PX / Math.max(drawW, drawH, 1));
                    if (scale < 1) {
                        drawW = Math.floor(drawW * scale);
                        drawH = Math.floor(drawH * scale);
                        g.drawImage(image, Math.floor((w - drawW) / 2), Math.floor((h - drawH) / 2), drawW, drawH);
                    } else {
                        g.drawImage(image, Math.floor((w - drawW) / 2), Math.floor((h - drawH) / 2));
                    }
                    drawn = true;
                } catch (eDrawImage) {
                    drawn = false;
                }
            }
            if (!drawn) {
                // サムネイルが無いときは用紙の縦横比だけ示す
                scale = PAGE_THUMB_BOX_PX / Math.max(page.width, page.height, 1);
                paperW = Math.max(4, Math.floor(page.width * scale));
                paperH = Math.max(4, Math.floor(page.height * scale));
                if (!(page.width > 0 && page.height > 0)) {
                    paperW = Math.floor(PAGE_THUMB_BOX_PX * 0.7);
                    paperH = PAGE_THUMB_BOX_PX;
                }
                try {
                    g.newPath();
                    g.rectPath(Math.floor((w - paperW) / 2), Math.floor((h - paperH) / 2), paperW, paperH);
                    g.fillPath(g.newBrush(g.BrushType.SOLID_COLOR, PAGE_THUMB_PAPER_COLOR));
                    g.newPath();
                    g.rectPath(Math.floor((w - paperW) / 2), Math.floor((h - paperH) / 2), paperW, paperH);
                    g.strokePath(g.newPen(g.PenType.SOLID_COLOR, PAGE_THUMB_PAPER_EDGE_COLOR, 1));
                } catch (ePaper) {}
            }
            borderWidth = isPageSelected(page) ? PAGE_THUMB_SELECTED_WIDTH : PAGE_THUMB_NORMAL_WIDTH;
            try {
                g.newPath();
                g.rectPath(borderWidth / 2, borderWidth / 2, w - borderWidth, h - borderWidth);
                g.strokePath(g.newPen(g.PenType.SOLID_COLOR,
                    isPageSelected(page) ? PAGE_THUMB_SELECTED_COLOR : PAGE_THUMB_NORMAL_COLOR, borderWidth));
            } catch (eBorder) {}
        }

        // onDraw の描き直しは表示の出し入れで確実に起こす（クリック時のみなので取りこぼしの心配は小さい）
        function redrawCanvas(canvas) {
            try {
                canvas.visible = false;
                canvas.visible = true;
            } catch (ePulse) {}
        }

        function redrawSlots() {
            var k;
            for (k = 0; k < slots.length; k++) {
                if (slots[k].page) redrawCanvas(slots[k].canvas);
            }
            try { gridPanel.layout.layout(true); } catch (eLayout) {}
            try { dlg.update(); } catch (eUpdate) {}
        }

        function redrawSlotOfPage(page) {
            var k;
            for (k = 0; k < slots.length; k++) {
                if (slots[k].page === page) {
                    redrawCanvas(slots[k].canvas);
                    try { slots[k].canvas.parent.layout.layout(true); } catch (eLayout) {}
                }
            }
            try { dlg.update(); } catch (eUpdate) {}
        }

        function syncChecks() {
            var k;
            for (k = 0; k < slots.length; k++) {
                if (slots[k].page) slots[k].check.value = isPageSelected(slots[k].page);
            }
        }

        function updateStatus() {
            var offsets = getSelectedOffsets();
            var rangeText;
            if (offsets.length === 0) {
                statusText.text = "選択: なし";
                okButton.enabled = false;
                return;
            }
            rangeText = buildPageRangeTextFromOffsets(documentRef, offsets, namesByOffset);
            statusText.text = "選択: " + offsets.length + "ページ（" + shortenMiddle(rangeText, 60) + "）";
            okButton.enabled = true;
        }

        function makePageHelpTip(page) {
            var parts = ["ページ " + getPickerPageLabel(page) + "（+" + (page.offset + 1) + "）"];
            if (page.masterName !== "") parts.push("親: " + page.masterName);
            if (page.commentCount > 0) parts.push("コメント " + page.commentCount + "件");
            return parts.join(" ／ ");
        }

        function updateSlots() {
            var k;
            var slot;
            var page;
            var lastIndex;
            for (k = 0; k < slots.length; k++) {
                slot = slots[k];
                page = pages[firstIndex + k] || null;
                slot.page = page;
                if (page) {
                    slot.check.text = getPickerPageLabel(page);
                    slot.check.value = isPageSelected(page);
                    slot.countText.text = page.commentCount > 0 ? page.commentCount + "件" : "";
                    slot.canvas.helpTip = makePageHelpTip(page);
                    slot.check.helpTip = slot.canvas.helpTip;
                    slot.cell.visible = true;
                } else {
                    slot.cell.visible = false;
                }
            }
            lastIndex = Math.min(firstIndex + perScreen, pages.length);
            navText.text = (firstIndex + 1) + "-" + lastIndex + " / " + pages.length;
            prevButton.enabled = firstIndex > 0;
            nextButton.enabled = lastIndex < pages.length;
            updateStatus();
        }

        function setBusy(value) {
            busy = value;
            prevButton.enabled = !value && firstIndex > 0;
            nextButton.enabled = !value && firstIndex + perScreen < pages.length;
            thumbCheckbox.enabled = !value;
        }

        function makeProgressText(done, total) {
            return done < total ? "サムネイル作成中 " + (done + 1) + "/" + total : "";
        }

        // 呼び出し側で busy を立ててから呼ぶ
        function ensureScreenThumbnails(reporter) {
            if (!isThumbnailOn()) return;
            try {
                renderPageThumbnails(documentRef, thumbStore, pages.slice(firstIndex, firstIndex + perScreen),
                    function (done, total, page) {
                        reporter(makeProgressText(done, total), page);
                    });
            } finally {
                reporter(thumbStore.disabledReason, null);
            }
        }

        function reportInPicker(text, finishedPage) {
            progressText.text = safeString(text);
            if (finishedPage) {
                redrawSlotOfPage(finishedPage);
            } else {
                try { dlg.update(); } catch (eUpdate) {}
            }
        }

        function refreshScreen() {
            if (busy) return;
            updateSlots();
            redrawSlots();
            if (!isThumbnailOn()) return;
            setBusy(true);
            try {
                ensureScreenThumbnails(reportInPicker);
            } finally {
                setBusy(false);
            }
            redrawSlots();
        }

        function handleCellClick(slotIndex, event) {
            var page = slots[slotIndex].page;
            var pageIndex = firstIndex + slotIndex;
            var shiftKey = false;
            var targetValue;
            var from;
            var to;
            var k;
            if (!page || busy) return;
            try { shiftKey = event && event.shiftKey === true; } catch (eShift) {}
            if (!shiftKey) {
                try { shiftKey = ScriptUI.environment.keyboardState.shiftKey === true; } catch (eState) {}
            }
            if (shiftKey && lastClickedIndex >= 0 && lastClickedIndex !== pageIndex && pages[lastClickedIndex]) {
                // Shift+クリックは直前に押したページの状態で間を揃える
                targetValue = isPageSelected(pages[lastClickedIndex]);
                from = Math.min(lastClickedIndex, pageIndex);
                to = Math.max(lastClickedIndex, pageIndex);
                for (k = from; k <= to; k++) setPageSelected(pages[k], targetValue);
            } else {
                setPageSelected(page, !isPageSelected(page));
            }
            lastClickedIndex = pageIndex;
            syncChecks();
            updateStatus();
            redrawSlots();
        }

        function makeCellClickHandler(slotIndex) {
            return function (event) {
                handleCellClick(slotIndex, event);
            };
        }

        function makeCheckClickHandler(slotIndex) {
            return function () {
                var slot = slots[slotIndex];
                if (!slot.page) return;
                setPageSelected(slot.page, slot.check.value === true);
                lastClickedIndex = firstIndex + slotIndex;
                updateStatus();
                redrawSlotOfPage(slot.page);
            };
        }

        function addPickerButton(parent, text, width) {
            var button = parent.add("button", undefined, text);
            button.preferredSize = [width, PAGE_PICKER_BUTTON_HEIGHT];
            return button;
        }

        dlg = new Window("dialog", "ページ選択");
        dlg.orientation = "column";
        dlg.alignChildren = ["fill", "top"];
        dlg.margins = PAGE_PICKER_MARGINS;
        dlg.spacing = PAGE_PICKER_SPACING;
        try { dlg.opacity = PAGE_PICKER_OPACITY; } catch (eOpacity) {}

        topRow = dlg.add("group");
        topRow.orientation = "row";
        topRow.alignChildren = ["left", "center"];
        topRow.spacing = PAGE_PICKER_ROW_SPACING;
        selectAllButton = addPickerButton(topRow, "全選択", PAGE_PICKER_BUTTON_WIDTH);
        clearButton = addPickerButton(topRow, "全解除", PAGE_PICKER_BUTTON_WIDTH);
        commentButton = addPickerButton(topRow, "コメントあり", PAGE_PICKER_MAIN_BUTTON_WIDTH);
        commentButton.helpTip = "出力対象のコメントがあるページだけを選びます";
        thumbCheckbox = topRow.add("checkbox", undefined, "サムネイル");
        thumbCheckbox.value = store.showPageThumbnails !== false;
        thumbCheckbox.helpTip = "重いときはオフにするとページ名だけで選べます";
        progressText = topRow.add("statictext", undefined, "");
        progressText.characters = 22;

        gridPanel = dlg.add("panel", undefined, "");
        gridPanel.orientation = "column";
        gridPanel.alignChildren = ["left", "top"];
        gridPanel.margins = PAGE_PICKER_GRID_MARGINS;
        gridPanel.spacing = PAGE_PICKER_GRID_ROW_SPACING;
        for (r = 0; r < PAGE_PICKER_ROWS; r++) {
            rowGroup = gridPanel.add("group");
            rowGroup.orientation = "row";
            rowGroup.alignChildren = ["left", "top"];
            rowGroup.spacing = PAGE_PICKER_GRID_COLUMN_SPACING;
            for (c = 0; c < PAGE_PICKER_COLUMNS; c++) {
                (function () {
                    var slot = { page: null };
                    var labelRow;
                    slot.cell = rowGroup.add("group");
                    slot.cell.orientation = "column";
                    slot.cell.alignChildren = ["left", "top"];
                    slot.cell.spacing = 3;
                    slot.cell.margins = 0;
                    slot.canvas = slot.cell.add("panel", undefined, "");
                    slot.canvas.margins = 0;
                    slot.canvas.preferredSize = [cellSize, cellSize];
                    slot.canvas.minimumSize = [cellSize, cellSize];
                    slot.canvas.maximumSize = [cellSize, cellSize];
                    slot.canvas.__slot = slot;
                    slot.canvas.onDraw = drawThumbCanvas;
                    labelRow = slot.cell.add("group");
                    labelRow.orientation = "row";
                    labelRow.alignChildren = ["left", "center"];
                    labelRow.spacing = 4;
                    labelRow.margins = 0;
                    slot.check = labelRow.add("checkbox", undefined, "");
                    slot.check.preferredSize.width = cellSize - 40;
                    slot.countText = labelRow.add("statictext", undefined, "");
                    slot.countText.preferredSize.width = 36;
                    slots.push(slot);
                    slot.canvas.addEventListener("mousedown", makeCellClickHandler(slots.length - 1));
                    slot.check.onClick = makeCheckClickHandler(slots.length - 1);
                }());
            }
        }

        navRow = dlg.add("group");
        navRow.orientation = "row";
        navRow.alignment = ["center", "top"];
        navRow.alignChildren = ["center", "center"];
        navRow.spacing = PAGE_PICKER_ROW_SPACING;
        prevButton = addPickerButton(navRow, "前へ", PAGE_PICKER_BUTTON_WIDTH);
        navText = navRow.add("statictext", undefined, "");
        navText.characters = 14;
        navText.justify = "center";
        nextButton = addPickerButton(navRow, "次へ", PAGE_PICKER_BUTTON_WIDTH);

        statusText = dlg.add("statictext", undefined, "");
        statusText.characters = 60;

        buttonGroup = dlg.add("group");
        buttonGroup.orientation = "row";
        buttonGroup.alignment = ["right", "top"];
        buttonGroup.margins = PAGE_PICKER_BUTTON_MARGINS;
        buttonGroup.spacing = PAGE_PICKER_ROW_SPACING;
        cancelButton = buttonGroup.add("button", undefined, "キャンセル", { name: "cancel" });
        cancelButton.preferredSize = [PAGE_PICKER_BUTTON_WIDTH, PAGE_PICKER_BUTTON_HEIGHT];
        okButton = buttonGroup.add("button", undefined, "OK", { name: "ok" });
        okButton.preferredSize = [PAGE_PICKER_MAIN_BUTTON_WIDTH, PAGE_PICKER_BUTTON_HEIGHT];
        dlg.defaultElement = okButton;
        dlg.cancelElement = cancelButton;

        selectAllButton.onClick = function () {
            var k;
            if (busy) return;
            for (k = 0; k < pages.length; k++) setPageSelected(pages[k], true);
            syncChecks();
            updateStatus();
            redrawSlots();
        };
        clearButton.onClick = function () {
            if (busy) return;
            selected = {};
            syncChecks();
            updateStatus();
            redrawSlots();
        };
        commentButton.onClick = function () {
            var k;
            if (busy) return;
            selected = {};
            for (k = 0; k < pages.length; k++) {
                if (pages[k].commentCount > 0) setPageSelected(pages[k], true);
            }
            syncChecks();
            updateStatus();
            redrawSlots();
        };
        thumbCheckbox.onClick = function () {
            if (busy) return;
            store.showPageThumbnails = thumbCheckbox.value === true;
            if (thumbCheckbox.value === true) {
                refreshScreen();
            } else {
                progressText.text = "";
                redrawSlots();
            }
        };
        prevButton.onClick = function () {
            if (busy || firstIndex <= 0) return;
            firstIndex = Math.max(0, firstIndex - perScreen);
            refreshScreen();
        };
        nextButton.onClick = function () {
            if (busy || firstIndex + perScreen >= pages.length) return;
            firstIndex += perScreen;
            refreshScreen();
        };
        cancelButton.onClick = function () {
            dlg.close(2);
        };
        okButton.onClick = function () {
            var offsets = getSelectedOffsets();
            if (busy) return;
            if (offsets.length === 0) {
                alert("ページを選択してください。", SCRIPT_NAME, true);
                return;
            }
            result = offsets;
            saveDialogPosition(dlg, store, "pagePickerLocation");
            dlg.close(1);
        };
        dlg.onMove = function () {
            saveDialogPosition(dlg, store, "pagePickerLocation");
        };
        dlg.onShow = function () {
            restoreDialogPosition(dlg, store, "pagePickerLocation");
        };

        updateSlots();
        // 最初の画面ぶんは開く前に作る（進み具合は呼び出し元の画面に出す）
        if (isThumbnailOn()) {
            busy = true;
            try {
                ensureScreenThumbnails(function (text) {
                    if (reportPreparing) reportPreparing(safeString(text));
                });
            } finally {
                busy = false;
                if (reportPreparing) reportPreparing("");
            }
            progressText.text = thumbStore.disabledReason;
        }
        if (dlg.show() !== 1) return null;
        return result;
    }

    // ------------------------------------------------------------------
    // PDF/XFDF書き出しUI
    // ------------------------------------------------------------------

    function showExportDialog(documentRef, store) {
        var pageInfoCache = makePageInfoCache();
        var rows = buildCommentRows(documentRef, pageInfoCache);
        var enabledDirty = false;
        var result = null;
        var presetInfo = getPdfPresetNames();
        var initialFolder = getInitialOutputFolder(documentRef, store);
        var selectedFolder = initialFolder;
        var dlg;
        var summaryText;
        var list;
        var listButtonRow1;
        var gotoButton;
        var editButton;
        var deleteButton;
        var toggleButton;
        var selectAllButton;
        var clearAllButton;
        var reloadButton;
        var noteText;
        var pdfPanel;
        var destinationRow;
        var destinationText;
        var browseButton;
        var nameRow;
        var nameInput;
        var xfdfNameText;
        var presetRow;
        var presetDropdown;
        var rangeRow;
        var rangeDropdown;
        var customRangeInput;
        var pagePickerButton;
        var thumbStore = null;
        var dialogShown;
        var singlePageNote;
        var pdfOptionRow;
        var acrobatOptionRow;
        var importXfdfCheckbox;
        var acrobatSaveRow;
        var saveInAcrobatCheckbox;
        var acrobatSavePrefixLabel;
        var acrobatSavePrefixInput;
        var acrobatSaveNameText;
        var openPdfCheckbox;
        var overwriteCheckbox;
        var annotPanel;
        var authorRow;
        var authorInput;
        var subjectInput;
        var defaultsRow;
        var defaultColorDropdown;
        var defaultPositionDropdown;
        var filterRow1;
        var includeLockedCheckbox;
        var includeHiddenCheckbox;
        var filterRow2;
        var includeHiddenLayersCheckbox;
        var includeNonPrintingCheckbox;
        var bodyOptionRow;
        var includeTargetTextCheckbox;
        var includePageNameCheckbox;
        var buttonGroup;
        var cancelButton;
        var okButton;
        var presetNames = presetInfo.names.slice(0);

        if (rows.length === 0) {
            alert("登録済みコメントがありません。\nTextFrameまたは文字範囲を選択して実行するとコメントを登録できます。", SCRIPT_NAME);
            return null;
        }
        if (presetNames.length === 0) presetNames.push("（既定設定）");

        dlg = new Window("dialog", SCRIPT_NAME);
        dlg.orientation = "column";
        dlg.alignChildren = ["fill", "top"];
        dlg.margins = 14;
        dlg.spacing = 8;

        summaryText = dlg.add("statictext", undefined, "");
        summaryText.characters = 70;

        list = dlg.add("listbox", undefined, "", {
            multiselect: true,
            numberOfColumns: 5,
            showHeaders: true,
            columnTitles: ["出力", "ページ", "対象", "コメント", "状態"],
            columnWidths: [40, 62, 200, 320, 110]
        });
        list.preferredSize = [770, 230];

        listButtonRow1 = dlg.add("group");
        listButtonRow1.orientation = "row";
        listButtonRow1.alignment = "right";
        listButtonRow1.spacing = 6;
        gotoButton = listButtonRow1.add("button", undefined, "対象へ移動");
        editButton = listButtonRow1.add("button", undefined, "編集");
        deleteButton = listButtonRow1.add("button", undefined, "削除");
        toggleButton = listButtonRow1.add("button", undefined, "出力切替");
        selectAllButton = listButtonRow1.add("button", undefined, "全選択");
        clearAllButton = listButtonRow1.add("button", undefined, "全解除");
        reloadButton = listButtonRow1.add("button", undefined, "再読込");

        noteText = dlg.add("statictext", undefined,
            "無効なコメントは削除されず、PDF/XFDF出力対象からのみ除外されます。ダブルクリックで対象へ移動します。");
        noteText.characters = 90;

        pdfPanel = dlg.add("panel", undefined, "PDF設定");
        pdfPanel.orientation = "column";
        pdfPanel.alignChildren = ["fill", "top"];
        pdfPanel.margins = 12;
        pdfPanel.spacing = 6;

        destinationRow = pdfPanel.add("group");
        destinationRow.orientation = "row";
        destinationRow.alignChildren = ["left", "center"];
        destinationRow.spacing = 6;
        destinationRow.add("statictext", undefined, "保存先").preferredSize.width = 90;
        destinationText = destinationRow.add("statictext", undefined, "");
        destinationText.preferredSize.width = 480;
        browseButton = destinationRow.add("button", undefined, "参照");
        browseButton.preferredSize = [80, 24];

        nameRow = pdfPanel.add("group");
        nameRow.orientation = "row";
        nameRow.alignChildren = ["left", "center"];
        nameRow.spacing = 6;
        nameRow.add("statictext", undefined, "PDFファイル名").preferredSize.width = 90;
        nameInput = nameRow.add("edittext", undefined, getInitialBaseName(documentRef));
        nameInput.preferredSize.width = 260;
        xfdfNameText = nameRow.add("statictext", undefined, "");
        xfdfNameText.preferredSize.width = 300;

        presetRow = pdfPanel.add("group");
        presetRow.orientation = "row";
        presetRow.alignChildren = ["left", "center"];
        presetRow.spacing = 6;
        presetRow.add("statictext", undefined, "PDFプリセット").preferredSize.width = 90;
        presetDropdown = presetRow.add("dropdownlist", undefined, presetNames);
        presetDropdown.preferredSize.width = 380;
        selectDropdownByText(presetDropdown, store.pdfPreset, 0);

        rangeRow = pdfPanel.add("group");
        rangeRow.orientation = "row";
        rangeRow.alignChildren = ["left", "center"];
        rangeRow.spacing = 6;
        rangeRow.add("statictext", undefined, "書き出し範囲").preferredSize.width = 90;
        rangeDropdown = rangeRow.add("dropdownlist", undefined, getExportRangeNames());
        rangeDropdown.preferredSize.width = 220;
        selectDropdownByText(rangeDropdown, store.exportRange, 1);
        customRangeInput = rangeRow.add("edittext", undefined, safeString(store.customPageRange));
        customRangeInput.preferredSize.width = 230;
        customRangeInput.helpTip = "ページ名または +絶対ページ番号（例: 4,6-8,+10）";
        pagePickerButton = rangeRow.add("button", undefined, "ページ選択");
        pagePickerButton.preferredSize = [80, 24];
        pagePickerButton.helpTip = "サムネイルとページ名から選びます";

        singlePageNote = pdfPanel.add("statictext", undefined, "注釈位置を維持するため単ページで書き出します");
        singlePageNote.characters = 60;

        acrobatOptionRow = pdfPanel.add("group");
        acrobatOptionRow.orientation = "row";
        acrobatOptionRow.spacing = 12;
        importXfdfCheckbox = acrobatOptionRow.add("checkbox", undefined, "書き出し後、AcrobatでXFDFを自動読み込み");
        importXfdfCheckbox.value = store.importXfdf !== false;
        importXfdfCheckbox.helpTip =
            "書き出したXFDFをAdobe Acrobatで開きます。XFDFは元PDFを参照しているため、\n" +
            "Acrobatが対応するPDFを開いてコメントを読み込みます。";

        acrobatSaveRow = pdfPanel.add("group");
        acrobatSaveRow.orientation = "row";
        acrobatSaveRow.alignChildren = ["left", "center"];
        acrobatSaveRow.spacing = 6;
        saveInAcrobatCheckbox = acrobatSaveRow.add("checkbox", undefined, "注釈読み込み後、別名PDFとして保存");
        saveInAcrobatCheckbox.value = store.saveInAcrobat !== false;
        saveInAcrobatCheckbox.helpTip =
            "Acrobatで注釈を読み込んだ状態を、同じフォルダへ別名保存します。\n" +
            "元のPDFとXFDFは残り、同名の保存済みPDFがある場合は連番を付けます。";
        acrobatSavePrefixLabel = acrobatSaveRow.add("statictext", undefined, "プレフィックス");
        acrobatSavePrefixInput = acrobatSaveRow.add("edittext", undefined,
            safeString(store.acrobatSavePrefix || "コメント_"));
        acrobatSavePrefixInput.preferredSize.width = 120;
        acrobatSavePrefixInput.helpTip = "例: コメント_ → コメント_元のPDF名.pdf";
        acrobatSaveNameText = acrobatSaveRow.add("statictext", undefined, "");
        acrobatSaveNameText.preferredSize.width = 260;

        pdfOptionRow = pdfPanel.add("group");
        pdfOptionRow.orientation = "row";
        pdfOptionRow.spacing = 12;
        openPdfCheckbox = pdfOptionRow.add("checkbox", undefined, "書き出し後にPDFを開く");
        openPdfCheckbox.value = store.openPdf === true;
        openPdfCheckbox.helpTip =
            "Acrobatへの自動読み込みを使用しない場合、または自動読み込みに失敗した場合に、既定アプリケーションでPDFを開きます。";
        overwriteCheckbox = pdfOptionRow.add("checkbox", undefined, "同名ファイルの上書きを確認");
        overwriteCheckbox.value = store.confirmOverwrite !== false;

        annotPanel = dlg.add("panel", undefined, "注釈設定");
        annotPanel.orientation = "column";
        annotPanel.alignChildren = ["fill", "top"];
        annotPanel.margins = 12;
        annotPanel.spacing = 6;

        authorRow = annotPanel.add("group");
        authorRow.orientation = "row";
        authorRow.alignChildren = ["left", "center"];
        authorRow.spacing = 6;
        authorRow.add("statictext", undefined, "作成者").preferredSize.width = 90;
        authorInput = authorRow.add("edittext", undefined, safeString(store.author));
        authorInput.preferredSize.width = 180;
        authorRow.add("statictext", undefined, "件名").preferredSize.width = 50;
        subjectInput = authorRow.add("edittext", undefined, safeString(store.subject));
        subjectInput.preferredSize.width = 180;

        defaultsRow = annotPanel.add("group");
        defaultsRow.orientation = "row";
        defaultsRow.alignChildren = ["left", "center"];
        defaultsRow.spacing = 6;
        defaultsRow.add("statictext", undefined, "既定色").preferredSize.width = 90;
        defaultColorDropdown = defaultsRow.add("dropdownlist", undefined, (function () {
            var options = getColorOptions();
            var items = [];
            var n;
            for (n = 0; n < options.length; n++) items.push(options[n].label);
            return items;
        }()));
        defaultColorDropdown.preferredSize.width = 110;
        selectDropdownByText(defaultColorDropdown, colorKeyToLabel(store.defaultColorKey), 0);
        defaultsRow.add("statictext", undefined, "既定位置").preferredSize.width = 60;
        defaultPositionDropdown = defaultsRow.add("dropdownlist", undefined, (function () {
            var options = getPositionOptions();
            var items = [];
            var n;
            for (n = 0; n < options.length; n++) items.push(options[n].label);
            return items;
        }()));
        defaultPositionDropdown.preferredSize.width = 110;
        selectDropdownByText(defaultPositionDropdown, positionKeyToLabel(store.defaultPositionKey), 1);

        filterRow1 = annotPanel.add("group");
        filterRow1.orientation = "row";
        filterRow1.spacing = 12;
        includeLockedCheckbox = filterRow1.add("checkbox", undefined, "ロック対象を含める");
        includeLockedCheckbox.value = store.includeLocked !== false;
        includeHiddenCheckbox = filterRow1.add("checkbox", undefined, "非表示対象を含める");
        includeHiddenCheckbox.value = store.includeHidden === true;

        filterRow2 = annotPanel.add("group");
        filterRow2.orientation = "row";
        filterRow2.spacing = 12;
        includeHiddenLayersCheckbox = filterRow2.add("checkbox", undefined, "非表示レイヤーを含める");
        includeHiddenLayersCheckbox.value = store.includeHiddenLayers === true;
        includeNonPrintingCheckbox = filterRow2.add("checkbox", undefined, "非印刷対象を含める");
        includeNonPrintingCheckbox.value = store.includeNonPrinting === true;

        bodyOptionRow = annotPanel.add("group");
        bodyOptionRow.orientation = "row";
        bodyOptionRow.spacing = 12;
        includeTargetTextCheckbox = bodyOptionRow.add("checkbox", undefined, "対象テキストを本文へ含める（文字範囲は常に含める）");
        includeTargetTextCheckbox.value = store.includeTargetText === true;
        includeTargetTextCheckbox.helpTip = "文字範囲コメントは設定にかかわらず親文字（対象文字列）を本文へ含めます。\n" +
            "このオプションはTextFrame・画像・図形コメントにのみ影響します。";
        includePageNameCheckbox = bodyOptionRow.add("checkbox", undefined, "ページ名を本文へ含める");
        includePageNameCheckbox.value = store.includePageName === true;

        buttonGroup = dlg.add("group");
        buttonGroup.orientation = "row";
        buttonGroup.alignment = "right";
        buttonGroup.margins = [10, 5, 10, 5];
        buttonGroup.spacing = 6;
        cancelButton = buttonGroup.add("button", undefined, "キャンセル", { name: "cancel" });
        cancelButton.preferredSize.width = 90;
        okButton = buttonGroup.add("button", undefined, "書き出し", { name: "ok" });
        okButton.preferredSize.width = 110;
        dlg.defaultElement = okButton;
        dlg.cancelElement = cancelButton;

        function currentFilterSettings() {
            return {
                includeLocked: includeLockedCheckbox.value === true,
                includeHidden: includeHiddenCheckbox.value === true,
                includeHiddenLayers: includeHiddenLayersCheckbox.value === true,
                includeNonPrinting: includeNonPrintingCheckbox.value === true
            };
        }

        function countExportableRows() {
            var settings = currentFilterSettings();
            var count = 0;
            var n;
            var effective;
            for (n = 0; n < rows.length; n++) {
                effective = getEffectiveStatus(rows[n].resolution, settings);
                if (effective.exportable && rows[n].entry.record.enabled === "1") count++;
            }
            return count;
        }

        function rebuildListUI(keepIndices) {
            var settings = currentFilterSettings();
            var n;
            var row;
            var item;
            var effective;
            try { list.selection = null; } catch (eSelection) {}
            try { list.removeAll(); } catch (eRemove) {}
            for (n = 0; n < rows.length; n++) {
                row = rows[n];
                effective = getEffectiveStatus(row.resolution, settings);
                item = list.add("item", row.entry.record.enabled === "1" ? "○" : "－");
                item.subItems[0].text = row.resolution.pageInfo ? row.resolution.pageInfo.name : "-";
                item.subItems[1].text = makeListText(row.resolution.targetLabel, 26);
                item.subItems[2].text = makeListText(row.entry.record.memo, 44);
                item.subItems[3].text = row.entry.record.enabled === "1" ? effective.status : "出力OFF";
            }
            if (keepIndices && keepIndices.length > 0) {
                try {
                    for (n = 0; n < keepIndices.length; n++) {
                        if (keepIndices[n] >= 0 && keepIndices[n] < rows.length) {
                            list.selection = keepIndices[n];
                        }
                    }
                } catch (eKeep) {}
            }
            summaryText.text = "コメント: " + rows.length + " 件 ／ 出力対象: " + countExportableRows() + " 件";
        }

        function rebuildData() {
            pageInfoCache = makePageInfoCache();
            rows = buildCommentRows(documentRef, pageInfoCache);
            rebuildListUI();
        }

        function getSelectedRows() {
            var indices = getSelectedListIndices(list);
            var selected = [];
            var n;
            indices.sort(function (a, b) { return a - b; });
            for (n = 0; n < indices.length; n++) {
                if (rows[indices[n]]) selected.push(rows[indices[n]]);
            }
            return selected;
        }

        function updateDestinationText() {
            var path = selectedFolder ? selectedFolder.fsName : "";
            destinationText.text = shortenMiddle(path, 56);
            destinationText.helpTip = path;
        }

        function updateXfdfNameText() {
            var baseName = sanitizeFileBaseName(nameInput.text);
            xfdfNameText.text = baseName === "" ? "" : "XFDF: " + baseName + ".xfdf";
            updateAcrobatSaveControls();
        }

        function updateAcrobatSaveControls() {
            var enabled = saveInAcrobatCheckbox.value === true;
            var baseName = sanitizeFileBaseName(nameInput.text);
            var prefix = sanitizeFilePrefix(acrobatSavePrefixInput.text);
            if (enabled) importXfdfCheckbox.value = true;
            acrobatSavePrefixLabel.enabled = enabled;
            acrobatSavePrefixInput.enabled = enabled;
            acrobatSaveNameText.enabled = enabled;
            acrobatSaveNameText.text = enabled && baseName && prefix ?
                "保存PDF: " + sanitizeFileBaseName(prefix + baseName) + ".pdf" : "";
        }

        function updateCustomRangeEnabled() {
            customRangeInput.enabled = rangeDropdown.selection &&
                rangeDropdown.selection.text === EXPORT_RANGE_CUSTOM;
        }

        browseButton.onClick = function () {
            var chosen = Folder.selectDialog("PDF/XFDFの保存先を選択", selectedFolder);
            if (chosen) {
                selectedFolder = chosen;
                updateDestinationText();
            }
        };
        nameInput.onChanging = updateXfdfNameText;
        acrobatSavePrefixInput.onChanging = updateAcrobatSaveControls;
        importXfdfCheckbox.onClick = function () {
            if (importXfdfCheckbox.value !== true) saveInAcrobatCheckbox.value = false;
            updateAcrobatSaveControls();
        };
        saveInAcrobatCheckbox.onClick = function () {
            if (saveInAcrobatCheckbox.value === true) importXfdfCheckbox.value = true;
            updateAcrobatSaveControls();
        };
        rangeDropdown.onChange = updateCustomRangeEnabled;

        // 現在の書き出し範囲をページ選択の初期状態にする。決まらなければコメントのあるページ
        function getPickerInitialOffsets(commentPageOffsets) {
            var rangeChoice = rangeDropdown.selection ? rangeDropdown.selection.text : EXPORT_RANGE_COMMENT_PAGES;
            var pageResult = null;
            var offsets = [];
            var k;
            try {
                withCoordinateEnvironment(documentRef, function () {
                    pageResult = collectExportPageInfos(documentRef, rangeChoice,
                        customRangeInput.text, commentPageOffsets, pageInfoCache);
                    return null;
                });
            } catch (eInitial) {
                pageResult = null;
            }
            if (!pageResult || pageResult.error !== "") return commentPageOffsets.slice(0);
            for (k = 0; k < pageResult.pageInfos.length; k++) {
                offsets.push(pageResult.pageInfos[k].documentOffset);
            }
            return offsets;
        }

        pagePickerButton.onClick = function () {
            var filterSettings = currentFilterSettings();
            var commentPageOffsets = collectCommentPageOffsets(rows, filterSettings);
            var pages = collectPickerPages(documentRef, countCommentsByPageOffset(rows, filterSettings));
            var namesByOffset = {};
            var savedSummary = summaryText.text;
            var chosen = null;
            var k;
            if (pages.length === 0) {
                alert("ページがありません。", SCRIPT_NAME, true);
                return;
            }
            for (k = 0; k < pages.length; k++) namesByOffset["o" + pages[k].offset] = pages[k].name;
            if (!thumbStore) thumbStore = createThumbnailStore();
            try {
                chosen = showPagePickerDialog(documentRef, store, pages,
                    getPickerInitialOffsets(commentPageOffsets), thumbStore, function (text) {
                        summaryText.text = text === "" ? savedSummary : text;
                        try { dlg.update(); } catch (eUpdate) {}
                    });
            } catch (ePicker) {
                alert("ページ選択を開けません:\n" + safeString(ePicker.message || ePicker), SCRIPT_NAME, true);
                chosen = null;
            } finally {
                summaryText.text = savedSummary;
            }
            if (!chosen || chosen.length === 0) return;
            customRangeInput.text = buildPageRangeTextFromOffsets(documentRef, chosen, namesByOffset);
            selectDropdownByText(rangeDropdown, EXPORT_RANGE_CUSTOM, getExportRangeNames().length - 1);
            updateCustomRangeEnabled();
        };
        includeLockedCheckbox.onClick = function () { rebuildListUI(); };
        includeHiddenCheckbox.onClick = function () { rebuildListUI(); };
        includeHiddenLayersCheckbox.onClick = function () { rebuildListUI(); };
        includeNonPrintingCheckbox.onClick = function () { rebuildListUI(); };

        gotoButton.onClick = function () {
            var selected = getSelectedRows();
            if (selected.length !== 1) {
                alert("移動する対象を1件選択してください。", SCRIPT_NAME, true);
                return;
            }
            if (!isValidDomObject(selected[0].entry.frame)) {
                alert("対象のTextFrameが見つかりません（状態: " +
                    getEffectiveStatus(selected[0].resolution, currentFilterSettings()).status + "）。", SCRIPT_NAME, true);
                return;
            }
            focusOnCommentTarget(documentRef, selected[0].entry.frame, selected[0].entry.record);
        };
        list.onDoubleClick = gotoButton.onClick;

        editButton.onClick = function () {
            var selected = getSelectedRows();
            var edited;
            var errorText;
            var liveRecords;
            var n;
            if (selected.length !== 1) {
                alert("編集するコメントを1件選択してください。", SCRIPT_NAME, true);
                return;
            }
            edited = showSingleRecordEditDialog(cloneCommentRecord(selected[0].entry.record), store);
            if (!edited) return;
            liveRecords = getCommentRecordsFromTarget(selected[0].entry.frame);
            for (n = 0; n < liveRecords.length; n++) {
                if (liveRecords[n].id === selected[0].entry.record.id) {
                    liveRecords[n].memo = edited.memo;
                    liveRecords[n].color = edited.color;
                    liveRecords[n].position = edited.position;
                    liveRecords[n].enabled = edited.enabled;
                    liveRecords[n].updatedAt = nowIsoLocalString();
                    break;
                }
            }
            errorText = saveCommentRecordsWithUndo(
                [{ frame: selected[0].entry.frame, records: liveRecords }], "PDFコメントを編集");
            if (errorText) {
                alert("コメントの保存に失敗しました:\n" + errorText, SCRIPT_NAME, true);
                return;
            }
            rebuildData();
        };

        deleteButton.onClick = function () {
            var selected = getSelectedRows();
            var operations = [];
            var removeIdsByFrame = {};
            var frames = [];
            var n;
            var m;
            var frameKey;
            var liveRecords;
            var kept;
            var errorText;
            if (selected.length === 0) {
                alert("削除するコメントを選択してください。", SCRIPT_NAME, true);
                return;
            }
            if (!confirm("選択した " + selected.length + " 件のコメントをドキュメントから削除しますか？", false, SCRIPT_NAME)) return;
            for (n = 0; n < selected.length; n++) {
                frameKey = "f" + getObjectIdString(selected[n].entry.frame);
                if (!removeIdsByFrame[frameKey]) {
                    removeIdsByFrame[frameKey] = { frame: selected[n].entry.frame, ids: {} };
                    frames.push(frameKey);
                }
                removeIdsByFrame[frameKey].ids["r" + selected[n].entry.record.id] = true;
            }
            for (n = 0; n < frames.length; n++) {
                liveRecords = getCommentRecordsFromTarget(removeIdsByFrame[frames[n]].frame);
                kept = [];
                for (m = 0; m < liveRecords.length; m++) {
                    if (removeIdsByFrame[frames[n]].ids["r" + liveRecords[m].id] !== true) kept.push(liveRecords[m]);
                }
                operations.push({ frame: removeIdsByFrame[frames[n]].frame, records: kept });
            }
            errorText = saveCommentRecordsWithUndo(operations, "PDFコメントを削除");
            if (errorText) {
                alert("コメントの削除に失敗しました:\n" + errorText, SCRIPT_NAME, true);
                return;
            }
            rebuildData();
        };

        toggleButton.onClick = function () {
            var indices = getSelectedListIndices(list);
            var n;
            if (indices.length === 0) {
                alert("出力を切り替えるコメントを選択してください。", SCRIPT_NAME, true);
                return;
            }
            for (n = 0; n < indices.length; n++) {
                if (rows[indices[n]]) {
                    rows[indices[n]].entry.record.enabled =
                        rows[indices[n]].entry.record.enabled === "1" ? "0" : "1";
                    enabledDirty = true;
                }
            }
            rebuildListUI(indices);
        };
        selectAllButton.onClick = function () {
            var n;
            for (n = 0; n < rows.length; n++) {
                if (rows[n].entry.record.enabled !== "1") {
                    rows[n].entry.record.enabled = "1";
                    enabledDirty = true;
                }
            }
            rebuildListUI();
        };
        clearAllButton.onClick = function () {
            var n;
            for (n = 0; n < rows.length; n++) {
                if (rows[n].entry.record.enabled !== "0") {
                    rows[n].entry.record.enabled = "0";
                    enabledDirty = true;
                }
            }
            rebuildListUI();
        };
        reloadButton.onClick = function () {
            rebuildData();
        };

        dlg.onMove = function () {
            saveDialogPosition(dlg, store, "exportDialogLocation");
        };
        dlg.onShow = function () {
            restoreDialogPosition(dlg, store, "exportDialogLocation");
        };

        okButton.onClick = function () {
            var baseName = sanitizeFileBaseName(nameInput.text);
            var acrobatSavePrefix = sanitizeFilePrefix(acrobatSavePrefixInput.text);
            var filterSettings = currentFilterSettings();
            var settings;
            var exportableCount;
            var commentPageOffsets;
            var pageResult = null;
            var preset;
            var rangeChoice = rangeDropdown.selection ? rangeDropdown.selection.text : EXPORT_RANGE_COMMENT_PAGES;
            var inRangeCount = 0;

            if (!baseName) {
                alert("ファイル名が不正です。", SCRIPT_NAME, true);
                try { nameInput.active = true; } catch (eActive) {}
                return;
            }
            if (saveInAcrobatCheckbox.value === true && !acrobatSavePrefix) {
                alert("別名保存用のプレフィックスを入力してください。", SCRIPT_NAME, true);
                try { acrobatSavePrefixInput.active = true; } catch (ePrefixActive) {}
                return;
            }
            if (!selectedFolder) {
                alert("保存先を選択してください。", SCRIPT_NAME, true);
                return;
            }
            if (!selectedFolder.exists) {
                try {
                    if (!selectedFolder.create()) throw new Error("フォルダを作成できません。");
                } catch (eFolder) {
                    alert("保存先フォルダを作成できません。", SCRIPT_NAME, true);
                    return;
                }
            }
            exportableCount = countExportableRows();
            if (exportableCount === 0) {
                alert("書き出し対象のコメントがありません。\n出力ONのコメントがあるか、状態と対象外設定を確認してください。", SCRIPT_NAME, true);
                return;
            }
            commentPageOffsets = collectCommentPageOffsets(rows, filterSettings);
            withCoordinateEnvironment(documentRef, function () {
                pageResult = collectExportPageInfos(documentRef, rangeChoice,
                    customRangeInput.text, commentPageOffsets, pageInfoCache);
                return null;
            });
            if (pageResult.error !== "") {
                alert(pageResult.error, SCRIPT_NAME, true);
                return;
            }
            // 書き出しページ内に出力対象コメントがあるか確認
            (function () {
                var byOffset = {};
                var k;
                for (k = 0; k < pageResult.pageInfos.length; k++) {
                    byOffset["o" + pageResult.pageInfos[k].documentOffset] = true;
                }
                for (k = 0; k < commentPageOffsets.length; k++) {
                    if (byOffset["o" + commentPageOffsets[k]] === true) inRangeCount++;
                }
            }());
            if (inRangeCount === 0) {
                alert("書き出し対象ページに出力対象のコメントがありません。", SCRIPT_NAME, true);
                return;
            }
            preset = getPdfPresetByName(presetDropdown.selection && presetInfo.names.length > 0 ?
                presetDropdown.selection.text : "");
            if (hasPrinterMarksEnabled(preset)) {
                if (!confirm("プリンターマークが有効です。PDF上のコメント位置がずれる可能性があります。\n続行しますか？", false, SCRIPT_NAME)) {
                    return;
                }
            }

            settings = {
                outputFolder: selectedFolder,
                baseName: baseName,
                pdfPreset: preset ? safeString(preset.name) : "",
                exportRange: rangeChoice,
                customPageRange: customRangeInput.text,
                author: authorInput.text,
                subject: subjectInput.text,
                defaultColorKey: (function () {
                    var found = findOptionByLabel(getColorOptions(),
                        defaultColorDropdown.selection ? defaultColorDropdown.selection.text : "");
                    return found ? found.key : "red";
                }()),
                defaultPositionKey: (function () {
                    var found = findOptionByLabel(getPositionOptions(),
                        defaultPositionDropdown.selection ? defaultPositionDropdown.selection.text : "");
                    return found ? found.key : "topLeft";
                }()),
                includeLocked: filterSettings.includeLocked,
                includeHidden: filterSettings.includeHidden,
                includeHiddenLayers: filterSettings.includeHiddenLayers,
                includeNonPrinting: filterSettings.includeNonPrinting,
                includeTargetText: includeTargetTextCheckbox.value === true,
                includePageName: includePageNameCheckbox.value === true,
                importXfdf: importXfdfCheckbox.value === true,
                saveInAcrobat: saveInAcrobatCheckbox.value === true,
                acrobatSavePrefix: acrobatSavePrefix,
                openPdf: openPdfCheckbox.value === true,
                confirmOverwrite: overwriteCheckbox.value === true,
                pageInfos: pageResult.pageInfos,
                useAllPages: rangeChoice === EXPORT_RANGE_ALL
            };

            store.outputFolderPath = selectedFolder.fsName;
            store.pdfPreset = settings.pdfPreset;
            store.exportRange = settings.exportRange;
            store.customPageRange = settings.customPageRange;
            store.author = settings.author;
            store.subject = settings.subject;
            store.defaultColorKey = settings.defaultColorKey;
            store.defaultPositionKey = settings.defaultPositionKey;
            store.includeLocked = settings.includeLocked;
            store.includeHidden = settings.includeHidden;
            store.includeHiddenLayers = settings.includeHiddenLayers;
            store.includeNonPrinting = settings.includeNonPrinting;
            store.includeTargetText = settings.includeTargetText;
            store.includePageName = settings.includePageName;
            store.importXfdf = settings.importXfdf;
            store.saveInAcrobat = settings.saveInAcrobat;
            store.acrobatSavePrefix = settings.acrobatSavePrefix;
            store.openPdf = settings.openPdf;
            store.confirmOverwrite = settings.confirmOverwrite;
            saveDialogPosition(dlg, store, "exportDialogLocation");

            result = {
                settings: settings,
                rows: rows,
                pageInfoCache: pageInfoCache,
                enabledDirty: enabledDirty
            };
            dlg.close(1);
        };

        updateDestinationText();
        updateXfdfNameText();
        updateCustomRangeEnabled();
        rebuildListUI();
        try {
            dialogShown = dlg.show();
        } finally {
            disposeThumbnailStore(thumbStore);
        }
        if (dialogShown !== 1) return null;
        return result;
    }

    // ------------------------------------------------------------------
    // PDF/XFDF書き出しフロー
    // ------------------------------------------------------------------

    function persistEnabledFlags(rows) {
        var byFrame = {};
        var frameKeys = [];
        var operations = [];
        var i;
        var key;
        var liveRecords;
        var m;
        var n;
        for (i = 0; i < rows.length; i++) {
            if (!isValidDomObject(rows[i].entry.frame)) continue;
            key = "f" + getObjectIdString(rows[i].entry.frame);
            if (!byFrame[key]) {
                byFrame[key] = { frame: rows[i].entry.frame, records: [] };
                frameKeys.push(key);
            }
            byFrame[key].records.push(rows[i].entry.record);
        }
        for (i = 0; i < frameKeys.length; i++) {
            liveRecords = getCommentRecordsFromTarget(byFrame[frameKeys[i]].frame);
            for (m = 0; m < liveRecords.length; m++) {
                for (n = 0; n < byFrame[frameKeys[i]].records.length; n++) {
                    if (liveRecords[m].id === byFrame[frameKeys[i]].records[n].id) {
                        liveRecords[m].enabled = byFrame[frameKeys[i]].records[n].enabled;
                        break;
                    }
                }
            }
            operations.push({ frame: byFrame[frameKeys[i]].frame, records: liveRecords });
        }
        if (operations.length === 0) return null;
        return saveCommentRecordsWithUndo(operations, "PDFコメント出力設定を更新");
    }

    function runPdfXfdfExport(documentRef, store, dialogResult) {
        var settings = dialogResult.settings;
        var rows = dialogResult.rows;
        var diagnostics = makeDiagnostics();
        var viewState = captureViewState(documentRef);
        var progress = null;
        var pageMap;
        var bleedSource = null;
        var facingPages = false;
        var annotations = null;
        var outputFiles;
        var xfdfText;
        var tempFiles = null;
        var preset;
        var acrobatHandled = false;
        var acrobatSavedPdfFile = null;

        try {
            if (!isValidDomObject(documentRef)) {
                alert("ドキュメントが閉じられたため処理を中止しました。", SCRIPT_NAME, true);
                return;
            }
            if (dialogResult.enabledDirty) {
                persistEnabledFlags(rows);
            }
            progress = createProgressPalette();
            progress.set(5, "コメント位置を計算中...");

            pageMap = buildPageMap(settings.pageInfos);
            preset = getPdfPresetByName(settings.pdfPreset);
            try {
                facingPages = documentRef.documentPreferences.facingPages === true;
            } catch (eFacing) {}
            withCoordinateEnvironment(documentRef, function () {
                bleedSource = readBleedSource(documentRef, preset);
                annotations = prepareAnnotations(rows, settings, pageMap, bleedSource, facingPages, diagnostics);
                return null;
            });
            if (!annotations || annotations.length === 0) {
                progress.close();
                progress = null;
                alert("書き出し対象の注釈がありません。処理を中止しました。", SCRIPT_NAME, true);
                restoreViewState(documentRef, viewState);
                return;
            }

            progress.set(20, "保存ファイルを確認中...");
            outputFiles = resolveOutputFiles(settings.outputFolder, settings.baseName, settings.confirmOverwrite);
            if (!outputFiles) {
                progress.close();
                progress = null;
                restoreViewState(documentRef, viewState);
                return;
            }
            if (settings.saveInAcrobat === true) {
                acrobatSavedPdfFile = resolveAcrobatSavedPdfFile(outputFiles.pdfFile,
                    settings.acrobatSavePrefix);
            }

            try {
                progress.set(28, "XFDFデータを作成中...");
                xfdfText = buildXfdf(getFileBaseName(outputFiles.pdfFile), annotations, settings);
            } catch (eXml) {
                throw new Error("XFDF生成に失敗しました: " + safeString(eXml.message || eXml));
            }

            tempFiles = makeTemporaryOutputFiles(settings.outputFolder, outputFiles.baseName);
            safeRemoveFile(tempFiles.pdfFile);
            safeRemoveFile(tempFiles.xfdfFile);

            try {
                progress.set(35, "PDFを書き出し中...（単ページ）");
                exportPdfSinglePages(documentRef, tempFiles.pdfFile, settings.pdfPreset,
                    pageMap.pageRangeString, settings.useAllPages);
            } catch (ePdf) {
                safeRemoveFile(tempFiles.pdfFile);
                throw new Error("PDF書き出しに失敗しました: " + safeString(ePdf.message || ePdf));
            }

            try {
                progress.set(78, "XFDFを書き出し中...");
                writeUtf8File(tempFiles.xfdfFile, xfdfText);
                if (!tempFiles.xfdfFile.exists || tempFiles.xfdfFile.length <= 0) {
                    throw new Error("XFDFファイルが生成されませんでした。");
                }
            } catch (eXfdf) {
                safeRemoveFile(tempFiles.pdfFile);
                safeRemoveFile(tempFiles.xfdfFile);
                throw new Error("XFDF保存に失敗しました: " + safeString(eXfdf.message || eXfdf));
            }

            try {
                progress.set(88, "PDFとXFDFを確定中...");
                commitOutputPair(tempFiles, outputFiles);
                if (!outputFiles.pdfFile.exists || !outputFiles.xfdfFile.exists) {
                    throw new Error("出力ファイルを確定できませんでした。");
                }
            } catch (eCommit) {
                throw new Error("PDFとXFDFの確定に失敗しました: " + safeString(eCommit.message || eCommit));
            }

            // Acrobat自動読み込み。別名保存を指定した場合はAcrobat JavaScriptで
            // 「PDFを開く→XFDFを読み込む→プレフィックス付きPDFへ保存」まで行う。
            acrobatHandled = false;
            if (settings.importXfdf === true) {
                if (settings.saveInAcrobat === true && acrobatSavedPdfFile) {
                    progress.set(94, "Acrobatで注釈を読み込み、別名PDFを保存しています...");
                    acrobatHandled = importXfdfAndSaveInAcrobat(outputFiles.pdfFile,
                        outputFiles.xfdfFile, acrobatSavedPdfFile, diagnostics);
                    if (acrobatHandled) {
                        diagnostics.savedPdfPath = acrobatSavedPdfFile.fsName;
                    } else {
                        // 自動保存だけが失敗しても、従来どおり注釈を読み込んだPDFは開く。
                        acrobatHandled = openXfdfInAcrobat(outputFiles.xfdfFile, diagnostics);
                    }
                } else {
                    progress.set(94, "AcrobatでXFDFを開いています...");
                    acrobatHandled = openXfdfInAcrobat(outputFiles.xfdfFile, diagnostics);
                }
            }

            progress.set(100, "完了");
            progress.close();
            progress = null;
            restoreViewState(documentRef, viewState);

            // Acrobat自動読み込みが成功した場合はPDFを二重に開かない。
            // 失敗時は、openPdf または importXfdf が有効ならフォールバックで通常オープンする。
            if (!acrobatHandled && (settings.openPdf === true || settings.importXfdf === true)) {
                if (!openExportedPdf(outputFiles.pdfFile)) {
                    diagnostics.warnings.push("PDFを既定アプリケーションで開けませんでした。");
                }
            }
            // XFDFを開いた時点でAcrobatが前面に来るため、前面化処理は行わない
            // （AppleScript経由の前面化は実行中スクリプトを中断させる危険がある）
            showExclusionSummary(diagnostics, annotations.length, settings.outputFolder);
        } catch (eRun) {
            if (progress) {
                progress.close();
                progress = null;
            }
            if (tempFiles) {
                safeRemoveFile(tempFiles.pdfFile);
                safeRemoveFile(tempFiles.xfdfFile);
            }
            restoreViewState(documentRef, viewState);
            alert("書き出しに失敗しました:\n" + safeString(eRun.message || eRun), SCRIPT_NAME, true);
        }
    }

    // 多重起動防止ロック。
    // 真偽値ではなく取得時刻を保存し、一定時間より古いロックは「前回の異常終了で
    // 残ったもの」とみなして無視する。これによりロックが残っても無反応のまま
    // 復旧不能になることがない（旧版が残した true などの非数値も同様に無視する）。
    function acquireRunningLock() {
        var current = $.global[RUNNING_KEY];
        var now = (new Date()).getTime();
        if (typeof current === "number" && (now - current) >= 0 &&
                (now - current) < RUNNING_LOCK_TIMEOUT_MS) {
            return false;
        }
        $.global[RUNNING_KEY] = now;
        return true;
    }

    function releaseRunningLock() {
        $.global[RUNNING_KEY] = null;
    }

    function openExportWorkflow(documentRef, store) {
        var dialogResult = showExportDialog(documentRef, store);
        if (!dialogResult) return;
        runPdfXfdfExport(documentRef, store, dialogResult);
    }

    // ------------------------------------------------------------------
    // エントリーポイント
    // ------------------------------------------------------------------

    function main() {
        var store = ensureStore();
        var documentRef;
        var selectionItems;
        var resolved;
        var editorResult;
        if (!acquireRunningLock()) {
            // 多重起動防止（ダイアログ表示中の再実行を抑止）
            return;
        }
        try {
            if (app.documents.length === 0) {
                alert("ドキュメントが開いていません。", SCRIPT_NAME, true);
                return;
            }
            documentRef = app.activeDocument;
            selectionItems = getSelectionArray();
            resolved = resolveCommentTargets(selectionItems);
            if (resolved.targets.length > 0) {
                editorResult = showCommentEditorDialog(documentRef, resolved.targets, store);
                if (editorResult && editorResult.action === "export") {
                    openExportWorkflow(documentRef, store);
                }
            } else if (selectionItems.length > 0 && resolved.message !== "") {
                alert(resolved.message, SCRIPT_NAME);
            } else {
                openExportWorkflow(documentRef, store);
            }
        } catch (eMain) {
            alert("エラーが発生しました:\n" + safeString(eMain.message || eMain), SCRIPT_NAME, true);
        } finally {
            releaseRunningLock();
        }
    }

    main();
}());
