import fs from 'fs';
import path from 'path';

// =================================================================
// 設定
// =================================================================
const USE_CLAUDE = false; // true: Claude API / false: Ollama (ローカルLLM)

// --- Ollama (ローカルLLM) 設定 ---
const OLLAMA_API_URL = 'http://localhost:11434/api/chat';
const OLLAMA_MODEL_NAME = 'qwen-64k'; //（FROM qwen2.5:32b PARAMETER num_ctx 65536)

// --- Claude API 設定 ---
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL_NAME = 'claude-3-5-sonnet-20241022';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// 共通設定
const INPUT_DIR_NAME = 'kakuyomu_episodes';
const MAX_CHARS_PER_REQUEST = 15000;
const MAX_TOTAL_CHARS = 500000;

const CHUNK_SIZE = 1;
const NUM_CTX = 16384; 
// =================================================================

function truncateText(text, maxChars, label = '', keepEnd = true) {
    if (text.length <= maxChars) return text;

    console.warn(`[文字数制限] ${label}: ${text.length}文字 → ${maxChars}文字に切り詰めました。`);

    if (keepEnd) {
        const omitted = text.length - maxChars;
        return `...（前半 約${omitted}文字を文字数制限のため省略）...\n\n` + text.slice(text.length - maxChars);
    } else {
        return text.slice(0, maxChars) + `\n\n...（以下、文字数制限のため省略）`;
    }
}

/**
 * LLMの出力から「■ 最新の世界観・組織の力学メモ」の部分を切り出す関数
 */
function extractMemory(responseText, previousMemory) {
    const memoryMatch = responseText.match(/(?:#+\s*|■\s*)?最新の世界観・組織の力学メモ[\s\S]*?(?=\n(?:#+\s*|■)|$)/i);

    if (memoryMatch && memoryMatch[0].trim()) {
        return memoryMatch[0].trim();
    }

    console.warn('メモセクションの抽出に失敗したため、前回の文脈メモを維持します。');
    return previousMemory || '■ 最新の世界観・組織の力学メモ：\n・未評価（分析進行中）';
}

/**
 * LLMの出力から「作為的無能・描写の歪みの指摘」部分を抽出する関数
 */
function extractIncompetence(responseText) {
    const pattern = /(?:[・･■\-*]|\*\*|#+)?\s*作為的無能[・･]?描写の歪みの指摘\s*[:：]?[\s\S]*?(?=\n\s*(?:#+\s*|■)|(?:\n\s*・\s*構造的合理性)|$)/i;

    const match = responseText.match(pattern);
    if (match && match[0].trim()) {
        return match[0].trim();
    }

    return '・作為的無能・描写の歪みの指摘： 抽出失敗（形式不一致）';
}

/**
 * 指摘ログに実際に問題（作為的無能等）が含まれているかを厳密に判定する関数
 */
function isIssueDetected(incompetenceText) {
    if (!incompetenceText) return false;
    if (incompetenceText.includes('抽出失敗')) return false;

    // ヘッダー部分を取り除いて本文のみを取り出す
    const bodyText = incompetenceText.replace(/^(?:[・･■\-*]|\*\*|#+)?\s*作為的無能[・･]?描写の歪みの指摘\s*[:：]?/i, '').trim();

    // 指摘が「ない」ことを示すキーワード群
    const noIssueKeywords = [
        'なし', '特になし', '見受けられない', '見当たらない', '指摘なし', 
        '問題なし', '整合性が保たれている', '不自然な点は見られない', '顕著な歪みはない'
    ];

    // 本文が非常に短く、かつ「なし」系キーワードに該当する場合は問題なしと判定
    for (const keyword of noIssueKeywords) {
        if (bodyText === keyword || bodyText.startsWith(keyword + '。') || bodyText.startsWith(keyword + '（') || bodyText.startsWith(keyword + '\n')) {
            return false;
        }
    }

    // 「なし」などのキーワードのみで構成されているか判定
    const cleaned = bodyText.replace(/[。、\n\s（）()]/g, '');
    if (noIssueKeywords.some(k => cleaned === k)) {
        return false;
    }

    return true;
}

/**
 * 【共通APIインターフェース】
 */
async function callLLM({ systemContent, userContent, temperature = 0.0 }) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 600000); // 10分タイムアウト

    try {
        if (USE_CLAUDE) {
            if (!ANTHROPIC_API_KEY) {
                throw new Error('Claude APIキーが設定されていません。環境変数 ANTHROPIC_API_KEY を設定してください。');
            }

            const response = await fetch(CLAUDE_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01'
                },
                signal: controller.signal,
                body: JSON.stringify({
                    model: CLAUDE_MODEL_NAME,
                    max_tokens: 4000,
                    temperature: temperature,
                    system: systemContent,
                    messages: [
                        { role: 'user', content: userContent }
                    ]
                })
            });

            clearTimeout(timeoutId);
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Claude API エラー: HTTP ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            return data.content[0].text.trim();

        } else {
            const payload = {
                model: OLLAMA_MODEL_NAME,
                messages: [
                    { role: 'system', content: systemContent },
                    { role: 'user', content: userContent }
                ],
                options: { 
                    temperature: temperature,
                    num_ctx: NUM_CTX
                }, 
                stream: false
            };

            const response = await fetch(OLLAMA_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify(payload)
            });

            clearTimeout(timeoutId);
            if (!response.ok) throw new Error(`Ollama API エラー: HTTP ${response.status}`);

            const data = await response.json();
            return data.message.content.trim();
        }

    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            throw new Error(`${USE_CLAUDE ? 'Claude' : 'Ollama'}からの応答がタイムアウトしました。`);
        }
        throw err;
    }
}

// 塊ごとに監査する関数
async function auditChunk(title, episodes, currentMemory, isPartialRead = false) {
    let episodeListStr = episodes.map(ep => `【${ep.name}】\n${ep.text}`).join('\n\n');
    episodeListStr = truncateText(episodeListStr, MAX_CHARS_PER_REQUEST, 'エピソード本文（チャンク）', false);

    const coreOrganizationalPrinciples = `
【組織力学・キャラクター描写評価における最重要原則】

1. 国家・組織機能の作為的不作為の監査（マクロ視点・重要）
   - 新規勢力の出現、未確認国家との接触、重大インシデントなどの危機発生時、**現実の国家・行政・防衛組織・法体制として「当然取るべき初期対応」**が不自然に欠落していないかを厳しく検証せよ。
   - 例：他国や未確認勢力との接触時における「国体・主権の防衛声明（公式発表）」「言論・広報統制」「法規の適用検討」「危機管理ラインの発足」などを放置し、物語の展開優先で組織機能を麻痺させている場合は「国家・組織レベルの作為的無能」として弾劾すること。
   - 不自然な非合理決定や放置を「情報の非対称性」や「裏の事情」として都合よく補完することを禁止する。

2. キャラクター個々の「作為的無能」の厳格な監査（ミクロ視点・最重要）
   - 「国家や組織レベルの行動理由」がいくら正当化されていても、その中で動く個々のキャラクター（指導者・官僚・指揮官・現場の人間）の描写精度を甘く評価してはならない。
   - 特定のイベント進行や主人公の活躍・引き立て、不都合な展開の回避のためだけに、キャラクターが「本来の立場や能力に見合わない不自然な失言・判断ミス・警戒感の急激な欠落」を起こしている場合、それを「組織の歪み」と言い換えて免罪化することを厳禁とする。個人の知性崩壊・作為的描写として明確に弾劾せよ。
`;

    const partialReadInstruction = isPartialRead ? `\n※重要：今回の監査は作品全体の「部分読み」です。未登場の設定や後続の伏線がある可能性を考慮して文脈を保留しつつも、国家機能の機能不全やキャラクターの立ち回りに不自然な作為性（作劇上の強引な無能化）がないかを厳格に検証してください。` : '';

    const systemContent = `あなたは現代政治・軍事から前近代の専制政治、および人間心理と作劇論理の整合性を極限まで追求する冷徹な社会・描写アナリストです。
国家・組織の構造論理（マクロ）と危機管理対応の妥当性、および登場人物一人ひとりの行動・判断の納得感（ミクロ）の双方から妥協なく監査を行ってください。${partialReadInstruction}
${coreOrganizationalPrinciples}`;

    const userContent = `提示されたエピソード群における「国家・組織」および「個々の登場人物」の行動を監査し、その納得可能性と作為性を以下のプロセスで検証してください。

【監査・判定のプロセス】
1. 【マクロ構造と国家・組織機能の検証】
   - 作品の社会構造（現代型か前近代型か）を特定し、異常事態や接触事故において**「国家・組織として当然取るべき初期対応（公式声明、危機管理ライン発足、広報統制等）」がストーリー都合で放置・無能化されていないか**を確認します。

2. 【ミクロ（個別キャラクター行動）の検証】★最重点項目
   - 国家・組織としての理屈がついているか否にかかわらず、**個々のキャラクター（味方・敵・第三者）が展開の都合（主人公の見せ場づくりやプロットの消化）のためだけに、立場に不相応な軽率・無能な振る舞いをさせられていないか**を精密にチェックしてください。

3. 【作為的無能の特定と指摘】
   - 「国家・組織機能の不自然な放置・麻痺」および「展開都合による個々のキャラクターの知性・警戒感の露骨な低下」が存在する場合、忖度なく指摘してください。

【これまでの世界観・組織設定メモ】
${currentMemory ? currentMemory : '（最初のセッションのため未構築）'}

【今回追加される対象本文】
${episodeListStr}

【出力フォーマット】
余計な前置きは完全に排除し、以下の項目のみを出力してください。

■ 最新の世界観・組織の力学メモ（箇条書きでできるだけたくさん）：
（※作中の社会構造と、組織・登場人物が「何をインセンティブ（利害）として動いているか」を超簡潔に更新）

■ パワーバランスとキャラクター描写の検証ログ：
・構造的合理性（組織・人物の動機の納得感、または文脈の保留）： （※社会構造や人物の立場から逆算して論理的に納得できる政治劇・行動・機能不全のロジック、あるいは保留理由を記述）
・作為的無能・描写の歪みの指摘： （※「国家・組織レベルで当然行うべき広報・防衛・危機管理等の放置」や「個々のキャラがプロット都合で知性や警戒を失っている点」があれば冷酷に指摘。整合性が保たれていれば「なし」と記述）`;

    return await callLLM({ systemContent, userContent, temperature: 0.0 });
}

/**
 * これまでの全検出ログを実際に検証・分析し、作為的無能の「傾向」を盛り込んだ最終監査報告書を生成する関数
 */
async function generateFinalSummary(title, auditHistory, currentRangeStr) {
    const totalChunks = auditHistory.length;
    
    // 実際に「歪み・作為的無能」があると判定されたログのみを抽出
    const detectedIssues = auditHistory.filter(h => h.hasIssue);
    const issueCount = detectedIssues.length;

    // 抽出された実際の指摘テキスト（なければ「指摘なし」）
    const issueLogsText = issueCount > 0
        ? detectedIssues.map(h => `・[${h.rangeStr}] ${h.incompetencePoint}`).join('\n')
        : '（実質的な作為的無能・作劇上の露骨な歪みは検出されませんでした）';

    const systemContent = `あなたは小説の「組織描写・政治劇・キャラクター行動の納得感」を総合的に分析・評価する知的な文学アナリストです。
これまでの全エピソードの監査ログ（全${totalChunks}個の区間のうち、実際に不自然な歪みが指摘された区間：${issueCount}箇所）を念頭に置き、作品全体の「作為的無能や描写の歪みの有無およびその『傾向』」について包括的な判定報告書を作成してください。

【分析のガイドライン】
1. 二元論的な合格/不合格ではなく、「どのような場面で作為的無能（プロット都合の知性低下・組織の放置など）が発生しやすいか、あるいは全体を通して整合性が保たれているか」という【傾向】を言語化してください。
2. あらすじの単なる要約は【絶対禁止】です。
3. 全体の文字数は300〜400文字程度に収めてください。`;

    const userContent = `【作品タイトル】
『${title}』 (監査範囲: ${currentRangeStr} まで)

【評価対象区間数】
全 ${totalChunks} 区間（うち明らかな不自然さの指摘があった区間: ${issueCount} 箇所）

【検出された作為的無能・描写の歪みの実際の指摘一覧】
${issueLogsText}

【出力フォーマット】
以下の指定フォーマットのみを出力すること。

【システム監査ログ：全話深層スクリーニング】
『${title}』の全編（${currentRangeStr}まで）にわたる組織力学および登場人物の行動整合性の監査を完了しました。

■ 組織論理・キャラクター行動の納得感：
（※世界観や社会構造に応じた組織の動きと、登場人物の動機に基づく立ち回りの説得力を記述。あらすじは厳禁）

■ 作為的無能・描写の歪みの傾向と判定：
（※検出された指摘ログを踏まえ、「どのような展開・状況で作為的無能や不自然な描写が生じやすい傾向があるか」、または「終始一貫して高い整合性が維持されているか」という『傾向と特徴』を分析して記述。あらすじは厳禁）`;

    return await callLLM({ systemContent, userContent, temperature: 0.2 });
}

async function main() {
    try {
        const targetDir = path.join(process.cwd(), INPUT_DIR_NAME);

        // 自然数ソート
        const files = fs.readdirSync(targetDir)
            .filter(file => file.endsWith('.txt'))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

        let workTitle = '判定対象作品';
        let allEpisodes = [];

        for (const file of files) {
            const filePath = path.join(targetDir, file);
            const content = fs.readFileSync(filePath, 'utf-8');

            if (workTitle === '判定対象作品') {
                const titleMatch = content.match(/^作品名：(.+)$/m);
                if (titleMatch) workTitle = titleMatch[1].trim();
            }

            const headerIndex = content.indexOf('─'.repeat(20));
            let bodyText = content;
            let epName = file.replace('.txt', '');

            if (headerIndex !== -1) {
                bodyText = content.substring(headerIndex + 20).trim();
                const epMatch = content.match(/^エピソード：(.+)$/m);
                if (epMatch) epName = epMatch[1].trim();
            }

            if (bodyText.trim()) {
                allEpisodes.push({ name: epName, text: bodyText });
            }
        }

        const isPartialRead = process.argv.includes('--partial');

        console.log(`▶ 使用LLM: ${USE_CLAUDE ? `Claude API (${CLAUDE_MODEL_NAME})` : `Ollama (${OLLAMA_MODEL_NAME})`}`);
        console.log(`▶ 作品名: 『${workTitle}』 (全 ${allEpisodes.length} 話を読み込み完了)`);
        console.log(`▶ 解析を開始します... (部分読みモード: ${isPartialRead ? "ON" : "OFF"})\n`);

        let currentMemory = "";
        let currentFinalSummary = "";
        let totalReadChars = 0;
        const auditHistory = []; // 全区間の監査ログを蓄積する配列

        for (let i = 0; i < allEpisodes.length; i += CHUNK_SIZE) {
            const chunk = allEpisodes.slice(i, i + CHUNK_SIZE);
            const chunkChars = chunk.reduce((sum, ep) => sum + ep.text.length, 0);

            if (totalReadChars + chunkChars > MAX_TOTAL_CHARS) {
                console.log(`\n⚠ 累積文字数が上限（約${MAX_TOTAL_CHARS.toLocaleString()}字）に達したため、${i}話目（累計 ${totalReadChars.toLocaleString()}字）で解析を打ち切ります。`);
                break;
            }

            totalReadChars += chunkChars;

            const startEp = chunk[0].name;
            const endEp = chunk[chunk.length - 1].name;
            const rangeStr = (CHUNK_SIZE < 2) ? `[${startEp}]` : `[${startEp} 〜 ${endEp}]`;

            console.log(`┌───────────────────────────────┐`);
            console.log(`│ 📌 ${rangeStr} 監査実行中 (累計: ${totalReadChars.toLocaleString()} / ${MAX_TOTAL_CHARS.toLocaleString()} 字)`);
            console.log(`└───────────────────────────────┘`);

            // 1. チャンク自体の個別監査
            const result = await auditChunk(workTitle, chunk, currentMemory, isPartialRead);

            currentMemory = extractMemory(result, currentMemory); 
            const incompetencePoint = extractIncompetence(result);
            const hasIssue = isIssueDetected(incompetencePoint);

            // 履歴に保持
            auditHistory.push({
                rangeStr: rangeStr,
                incompetencePoint: incompetencePoint,
                hasIssue: hasIssue
            });

            console.log(`\n【今回の文脈メモ】\n${currentMemory}\n`);
            console.log(`⚠️ 【検出ログ】\n${incompetencePoint} (${hasIssue ? '※指摘あり' : '※指摘なし'})\n`);

            // 2. 蓄積された実際の指摘ログに基づいて「歪みの傾向」を分析した統合レポートを作成
            console.log(`▶ ${rangeStr} 時点の「統合・最終監査報告書」を更新中...`);
            currentFinalSummary = await generateFinalSummary(workTitle, auditHistory, rangeStr);

            console.log(`\n================ 生成された最終監査ログ ================`);
            console.log(currentFinalSummary);
            console.log(`\n====================================================\n`);
        }

        if (!currentFinalSummary) {
            console.log("\n[INFO] 対象テキストが存在しないか、最初の話数で文字数上限を超えたため出力をスキップします。");
            return;
        }

        console.log(`▶ 全話の監査および最終統合処理が完了しました（最終読み込み: ${totalReadChars.toLocaleString()}字）。`);
        console.log(`\n================ 最終確定 監査ログ ================`);
        console.log(currentFinalSummary);
        console.log(`==================================================\n`);

    } catch (err) {
        console.error("\n[ERROR] 致命的なエラーが発生しました:", err.message);
    }
}

main();