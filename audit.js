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
const CLAUDE_API_KEY = 'SECRET';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || CLAUDE_API_KEY;

// 共通設定
const INPUT_DIR_NAME = 'kakuyomu_episodes';
const MAX_CHARS_PER_REQUEST = 15000;
const LOG_SUMMARY_THRESHOLD = 12000;
const MAX_TOTAL_CHARS = 500000;

const CHUNK_SIZE = 1;
const NUM_CTX = 16384; //MAX_CHARS_PER_REQUEST(15,000字)をカバーできるサイズに設定（最大65536、約40,000 〜 45,000文字まで拡張可）
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
    const memoryMatch = responseText.match(/■\s*最新の世界観・組織の力学メモ[\s\S]*?(?=\n■|\n$|$)/);
    
    if (memoryMatch && memoryMatch[0].trim()) {
        return memoryMatch[0].trim();
    }
    
    console.warn('メモセクションの抽出に失敗したため、前回の文脈メモを維持します。');
    return previousMemory || '■ 最新の世界観・組織の力学メモ（箇条書きで最大3つ）：\n・未評価（分析進行中）';
}

/**
 * LLMの出力から「作為的無能・描写の歪みの指摘」部分を抽出する関数
 */
function extractIncompetence(responseText) {
    const pattern = /(?:[・･■\-*]|\*\*)?\s*作為的無能[・･]?描写の歪みの指摘\s*[:：]?[\s\S]*?(?=\n\s*■|\n\s*・\s*構造的合理性|\n\s*#+|\n$|$)/i;
    
    const match = responseText.match(pattern);
    if (match && match[0].trim()) {
        return match[0].trim();
    }
    
    return '・作為的無能・描写の歪みの指摘： 抽出失敗（形式不一致）';
}

// ログテキストを文字数ごとに分割する関数
function chunkText(text, chunkSize = LOG_SUMMARY_THRESHOLD) {
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
}

/**
 * 肥大化した全セッションログをブロック分割して中間要約する関数
 */
async function summarizeAllLogs(fullLog) {
    const logChunks = chunkText(fullLog, LOG_SUMMARY_THRESHOLD);
    const intermediateSummaries = [];

    console.log(`\n▶ 累積ログ(${fullLog.length.toLocaleString()}文字)が大きいため、${logChunks.length}個のブロックに分けて中間要約します...`);

    for (let i = 0; i < logChunks.length; i++) {
        console.log(`  └ ブロック [${i + 1}/${logChunks.length}] を要約中...`);
        const systemContent = "あなたは長編小説の監査ログを整理・統合する編集アシスタントです。";
        const userContent = `以下の監査ログ（パート ${i + 1}/${logChunks.length}）から、キャラクター行動の矛盾・歪み・設定の評価ポイントを箇条書きで1,000字程度に要約してください。

【対象ログ】
${logChunks[i]}`;

        // callOllama ではなく共通の callLLM を使用
        const summary = await callLLM({ systemContent, userContent, temperature: 0.0 });
        intermediateSummaries.push(summary);
    }

    const compressedLog = intermediateSummaries.join("\n\n--- 次のブロック ---\n\n");
    return compressedLog;
}

/**
 * 【共通APIインターフェース】
 * USE_CLAUDE フラグによって Ollama と Claude API を切り替えて呼び出す関数
 */
async function callLLM({ systemContent, userContent, temperature = 0.0 }) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 600000); // 10分タイムアウト

    try {
        if (USE_CLAUDE) {
            // --- Claude API の呼び出し ---
            if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY === CLAUDE_API_KEY) {
                throw new Error('Claude APIキーが設定されていません。環境変数 ANTHROPIC_API_KEY を設定するか、コード内で指定してください。');
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
            // --- Ollama API の呼び出し ---
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

// 塊ごとに監査し、世界観・組織の記憶メモを更新していく関数
async function auditChunk(title, episodes, currentMemory, isPartialRead = false) {
    let episodeListStr = episodes.map(ep => `【${ep.name}】\n${ep.text}`).join('\n\n');
    episodeListStr = truncateText(episodeListStr, MAX_CHARS_PER_REQUEST, 'エピソード本文（チャンク）', false);

    let systemContent = "";
    let userContent = "";

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

    if (isPartialRead) {
        const partialReadInstruction = `\n※重要：今回の監査は作品全体の「部分読み」です。未登場の設定や後続の伏線がある可能性を考慮して文脈を保留しつつも、国家機能の機能不全やキャラクターの立ち回りに不自然な作為性（作劇上の強引な無能化）がないかを厳格に検証してください。`;

        systemContent = `あなたは現代政治・軍事から前近代の専制政治、および人間心理と作劇論理の整合性を極限まで追求する冷徹な社会・描写アナリストです。
国家・組織の構造論理（マクロ）と危機管理対応の妥当性、および登場人物一人ひとりの行動・判断の納得感（ミクロ）の双方から妥協なく監査を行ってください。${partialReadInstruction}
${coreOrganizationalPrinciples}`;

        userContent = `提示されたエピソード群における「国家・組織」および「個々の登場人物」の行動を監査し、その納得可能性と作為性を以下のプロセスで検証してください。

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

    } else {
        systemContent = `あなたは現代政治・軍事から前近代の専制政治、および人間心理と作劇論理の整合性を極限まで追求する冷徹な社会・描写アナリストです。
国家や組織の構造（マクロ）における初期対応の妥当性から、その中で動く個々のキャラクターの行動・判断の妥当性（ミクロ）まで厳しい眼光を光らせて監査を行ってください。
${coreOrganizationalPrinciples}`;

        userContent = `提示されたエピソード群における「国家・組織」および「個々の登場人物」の行動を監査し、その納得可能性と作為性を以下のプロセスで解剖してください。

【監査・判定のプロセス】
1. 【マクロ構造と国家・組織機能の検証】
   - 舞台設定（現代型か前近代型か）に照らし、異常発生時の国家・組織の動きが妥当か、あるいは**国家防衛・広報戦略・危機管理などの初期対応がプロット進行のために不自然に麻痺・無能化されていないか**を評価します。

2. 【ミクロ（個別キャラクター行動）の検証】★最重点項目
   - 組織レベルでどのような大義名分や背景理由があろうとも、個々の登場人物の行動描写を免罪化してはなりません。
   - 「プロットを特定の方向に動かすため」「特定人物を引き立てるため」だけに、キャラクターが本来持つべき知性、危機管理意識、立場上のプライド、あるいは合理的判断を放棄していないかを厳しく検証してください。

3. 【作為的無能の弾劾】
   - 「国家・行政レベルの不自然な不作為」および「キャラの都合よい無能化・雑な失言・唐突な判断ミス」など、作劇上の作為的な歪みを明確に弾劾してください。

【これまでの世界観・組織設定メモ】
${currentMemory ? currentMemory : '（最初のセッションのため未構築）'}

【今回追加される対象本文】
${episodeListStr}

【出力フォーマット】
余計な前置きは完全に排除し、以下の項目のみを出力してください。

■ 最新の世界観・組織の力学メモ（箇条書きでできるだけたくさん）：
（※作中の社会構造と、組織・登場人物が「何をインセンティブ（利害）として動いているか」を超簡潔に更新）

■ パワーバランスとキャラクター描写の検証ログ：
・構造的合理性（組織・人物の動機の納得感、または文脈の保留）： （※社会構造や権力ライン、人物の立場から逆算して論理的に納得できる展開や政治劇のロジックを記述）
・作為的無能・描写の歪みの指摘： （※「国家として当然行うべき声明発表や広報統制などの不自然な放置」や「個々のキャラがプロット都合で不自然に知性や警戒感を喪失している点」があれば冷酷に指摘。なければ「なし」と記述）`;
    }

    return await callLLM({ systemContent, userContent, temperature: 0.0 });
}

// 最後にすべての記憶と指摘を統合して、カクヨム用の最終ログを作る関数
async function generateFinalSummary(title, finalResult, isPartialRead = false) {
    finalResult = truncateText(finalResult, MAX_CHARS_PER_REQUEST, '統合ログ（全セッション合計）', true);

    let systemContent = "";
    let userContent = "";

    const finalSummaryPrinciples = `
※重要：国家や組織の動きに政治的・構造的な理由付けが存在していることだけで満足せず、その枠組みの中で動く個々のキャラクターの行動・判断に「展開都合の作為的無能や知性の崩壊」がないかを厳格に総括してください。
`;

    if (isPartialRead) {
        systemContent = `あなたは小説における「リアルな組織描写と政治劇、およびキャラクター行動の完成度」を審査する、極めて知的なWeb小説批評家です。単なるあらすじの要約は【絶対厳禁】です。マクロ（組織）とミクロ（人物描写）の両面から精緻な評価を行ってください。${finalSummaryPrinciples}`;
        userContent = `以下の「各セッションの検証ログ」を統合し、カクヨムの応援コメント欄にそのままコピペできる形（300〜400文字程度）の、解像度の高い「構造監査報告書」を作成してください。

【監査データ】
${finalResult}

【出力のガイドライン】
・組織の意思決定の妥当性（マクロ）と、個々のキャラクターの行動の説得力・リアリティ（ミクロ）の双方を分析してください。
・国家・組織レベルの動きに理由があっても、キャラクターがイベント消化のために不自然に無能化・雑に描写されている点がないかを客観的に評価してください。
・挨拶や前置き、余計な解説は一切省き、指定のフォーマットの項目のみを出力すること。

【システム監査ログ：全話深層スクリーニング [APPROVE]】
『${title}』の全編にわたる組織力学および登場人物の行動整合性の監査を完了しました。

■ 組織論理・キャラクター行動の納得感：
（※社会構造に即した組織の動きと、個々の登場人物のインセンティブ・動機に基づく行動の説得力を記述。あらすじは厳禁）

■ 制度ハック・人物描写の歪み判定：
（※構造のスキマを突いた知的なハックが機能しているか、あるいは「国家の理由付け」の裏で個々のキャラがプロット都合で都合よく知性や警戒を失わされていないかを判定。あらすじは厳禁）`;
    } else {
        systemContent = `あなたは小説における「リアルな組織描写と政治劇、およびキャラクター行動の完成度」を審査する、極めて知的なWeb小説批評家です。単なるあらすじの要約やお世辞は【絶対厳禁】です。組織の論理とキャラクターの行動における作為的な崩壊に対して冷徹に牙を剥いてください。${finalSummaryPrinciples}`;
        userContent = `以下の「各セッションの検証ログ」を統合し、カクヨムの応援コメント欄にそのままコピペできる形（300〜400文字程度）の、解像度の高い「構造監査報告書」を作成してください。

【監査データ】
${finalResult}

【出力のガイドライン】
・国家や組織の動きに政治的・構造的な説明がついているか否かにかかわらず、登場人物個々の振る舞いに「プロット消化のための作為的な無能化・知性低下」がないかを厳しく検証・指摘してください。
・挨拶や前置き、余計な解説は一切省き、指定のフォーマットの項目のみを出力すること。

【システム監査ログ：全話深層スクリーニング [APPROVE]】
『${title}』の全編にわたる組織力学および登場人物の行動整合性の監査を完了しました。

■ 組織論理・キャラクター行動の納得感：
（※社会構造に応じた組織・国家の動きと、個々の登場人物の立ち回りのリアリティを記述。あらすじは厳禁）

■ 制度ハック・人物描写の歪み判定：
（※知的なハックや政治劇として成立しているか、あるいは「組織の背景」で誤魔化しつつキャラ個人が展開都合で不自然な失言・失策・無能化を起こしていないかを冷酷に指摘。あらすじは厳禁）`;
    }

    return await callLLM({ systemContent, userContent, temperature: 0.3 });
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
        console.log(`▶ 解析を開始します... (部分読みモード: ${isPartialRead ? "ON" : "OFF"})`);

        let currentMemory = "";
        let allPoints = [];
        let totalReadChars = 0;

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

            if(CHUNK_SIZE < 2){
                console.log(`\n┌───────────────────────────────┐`);
                console.log(`│ 📌 [${startEp}] 終了時点の状況と作為的無能チェック`);
                console.log(`└───────────────────────────────┘`);
                console.log(`▶ 監査セッション [${startEp}] を実行中... (累計: ${totalReadChars.toLocaleString()} / ${MAX_TOTAL_CHARS.toLocaleString()} 字)`);
            }else{
                console.log(`\n┌───────────────────────────────┐`);
                console.log(`│ 📌 [${startEp} 〜 ${endEp}] 終了時点の状況と作為的無能チェック`);
                console.log(`└───────────────────────────────┘`);
                console.log(`▶ 監査セッション [${startEp} 〜 ${endEp}] を実行中... (累計: ${totalReadChars.toLocaleString()} / ${MAX_TOTAL_CHARS.toLocaleString()} 字)`);        
            }
            
            const result = await auditChunk(workTitle, chunk, currentMemory, isPartialRead);
            
            currentMemory = extractMemory(result, currentMemory); 
            const incompetencePoint = extractIncompetence(result);

            console.log(`${currentMemory}\n`);
            console.log(`⚠️ 【検出ログ】${incompetencePoint}\n`);
            
            allPoints.push(`--- [${startEp}-${endEp} の指摘] ---\n${result}`);
        }

        if (allPoints.length === 0) {
            console.log("\n[INFO] 対象テキストが存在しないか、最初の2話で文字数上限を超えたため出力をスキップします。");
            return;
        }

        console.log(`\n▶ 全話の監査が完了しました（最終読み込み: ${totalReadChars.toLocaleString()}字）。`);

        let fullLogText = allPoints.join('\n\n');

        if (fullLogText.length > LOG_SUMMARY_THRESHOLD) {
            fullLogText = await summarizeAllLogs(fullLogText);
        }

        console.log(`▶ カクヨム用フォーマットに最終統合中...`);
        const finalSummary = await generateFinalSummary(workTitle, fullLogText, isPartialRead);

        console.log(`\n================ 生成された最終監査ログ ================`);
        console.log(finalSummary);
        console.log(`\n====================================================\n`);
        
    } catch (err) {
        console.error("\n[ERROR] 致命的なエラーが発生しました:", err.message);
    }
}

main();