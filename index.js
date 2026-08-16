import puppeteer from 'puppeteer';
import path from 'path';
import os from 'os';
import fs from 'fs';

// --- 設定情報 ---
const TARGET_WORK_ID = '2912051603107883578'; 
const OUTPUT_DIR_NAME = 'kakuyomu_episodes';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function autoScrollToBottom(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 400; 
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if (totalHeight >= scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
}
async function extractEpisodeListFromNextData(page, workId) {
    const nextData = await page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__');
        return el ? JSON.parse(el.textContent) : null;
    });

    if (!nextData) {
        throw new Error("__NEXT_DATA__ が見つかりませんでした。ページ構造が変わった可能性があります。");
    }

    const apollo = nextData.props?.pageProps?.__APOLLO_STATE__;
    if (!apollo) {
        throw new Error("__APOLLO_STATE__ が見つかりませんでした。");
    }

    const workEntry = apollo[`Work:${workId}`];
    if (!workEntry || !workEntry.tableOfContentsV2) {
        throw new Error("目次情報（tableOfContentsV2）が見つかりませんでした。作品IDが正しいか確認してください。");
    }

    const episodes = [];
    for (const chapterRef of workEntry.tableOfContentsV2) {
        const chapter = apollo[chapterRef.__ref];
        if (!chapter || !chapter.episodeUnions) continue;

        for (const epRef of chapter.episodeUnions) {
            const epData = apollo[epRef.__ref];
            if (!epData) continue;
            const epId = epRef.__ref.split(':')[1];
            episodes.push({
                href: `https://kakuyomu.jp/works/${workId}/episodes/${epId}`,
                text: (epData.title || '').trim()
            });
        }
    }

    return episodes;
}

async function fetchAndSaveEpisodes(page, workId) {
    const url = `https://kakuyomu.jp/works/${workId}`;
    console.log(`[CRAWL] クロール開始: ${url}`);
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('#workTitle, [class*="title"]', { timeout: 10000 }).catch(() => null);
    
    // 1. 作品名の取得とクレンジング
    //let title = await page.$eval('#workTitle, [class*="title"]', el => el.innerText)
    //    .catch(async () => {
    //        return await page.$eval('title', el => el.innerText).catch(() => '対象作品');
    //    });
    //title = title.trim();
    //const titleClean = title.replace(/[\\/:*?"<>|]/g, '_');

    // 1. 作品名の取得とクレンジング（パンくずリストからピンポイントで取得）
    let title = await page.$eval(
        '#worksEpisodesEpisodeHeader-breadcrumbs [itemprop="itemListElement"]:first-child [itemprop="name"]', 
        el => el.innerText
    ).catch(async () => {
        // 万が一パンくずが見つからない場合のフォールバック（旧処理）
        return await page.$eval('#workTitle, [class*="title"], title', el => el.innerText).catch(() => '対象作品');
    });

    title = title.trim();
    const titleClean = title.replace(/[\\/:*?"<>|]/g, '_');


    // 2. 保存用ディレクトリの準備
    const outputDir = path.join(process.cwd(), OUTPUT_DIR_NAME);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // 3. 目次を __NEXT_DATA__ から取得（DOMスクレイピングは行わない）
    let uniqueEpisodes = await extractEpisodeListFromNextData(page, workId);

    // 念のため href ベースで重複除去
    const seenUrls = new Set();
    uniqueEpisodes = uniqueEpisodes.filter(ep => {
        if (seenUrls.has(ep.href)) return false;
        seenUrls.add(ep.href);
        return true;
    });
    
    console.log(`▶ 作品名: 『${title}』`);
    console.log(`▶ 抽出されたエピソード数: ${uniqueEpisodes.length} 件。順次テキスト化します。`);
    
    if (uniqueEpisodes.length === 0) {
        throw new Error("有効なエピソードURLが見つかりませんでした。");
    }

    // カクヨムの通常版＋書籍スタイル用を含めた網羅的セレクタ（.widget-episodeBody を追加）
    const BODY_SELECTORS = [
        '.widget-episodeBody',
        '.novel-body', 
        '.widget-novel-body', 
        '#novelView', 
        '.sheet', 
        '[class*="novel-body"]', 
        '#vertical-novel-body'
    ].join(', ');

    for (let i = 0; i < uniqueEpisodes.length; i++) {
        const episode = uniqueEpisodes[i];
        const epNumber = String(i + 1).padStart(3, '0'); // 001, 002...
        
        // 目次のテキストからファイル名を作る（無ければ「第X話」）
        let epTitle = episode.text || `第${i + 1}話`;
        const epTitleClean = epTitle.replace(/[\\/:*?"<>|]/g, '_');

        console.log(` └ [${i + 1}/${uniqueEpisodes.length}] 「${epTitle}」を取得中...`);
        
        try {
            await page.goto(episode.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
            
            // いずれかの本文要素が出るまで待つ
            await page.waitForSelector(BODY_SELECTORS, { timeout: 15000 });
            
            await autoScrollToBottom(page);
            await sleep(1500); 

            // 4. 本文の抽出とルビ記法の復元
            const episodeText = await page.evaluate((selectors) => {
                const elements = document.querySelectorAll(selectors);
                if (elements.length === 0) return '';
                
                let combinedText = [];

                elements.forEach(container => {
                    // 各段落（pタグ）をループ処理
                    const paragraphs = container.querySelectorAll('p');
                    paragraphs.forEach(p => {
                        // <ruby>タグをカクヨム記法「｜青空《あおぞら》」形式に置換
                        const rubies = p.querySelectorAll('ruby');
                        rubies.forEach(ruby => {
                            const rb = ruby.querySelector('rb');
                            const rt = ruby.querySelector('rt');
                            
                            let rbText = '';
                            if (rb) {
                                rbText = rb.innerText;
                            } else {
                                const clone = ruby.cloneNode(true);
                                const cloneRt = clone.querySelector('rt');
                                if (cloneRt) cloneRt.remove();
                                const cloneRp = clone.querySelectorAll('rp');
                                cloneRp.forEach(rp => rp.remove());
                                rbText = clone.innerText.trim();
                            }
                            
                            const rtText = rt ? rt.innerText.trim() : '';

                            if (rbText && rtText) {
                                ruby.replaceWith(`｜${rbText}《${rtText}》`);
                            }
                        });

                        combinedText.push(p.innerText.trim());
                    });
                });
                
                return combinedText.join('\n');
            }, BODY_SELECTORS).catch(() => '');
            
            if (episodeText.trim()) {
                // 5. 個別テキストファイルへの書き出し
                const fileName = `${titleClean}_${epNumber}_${epTitleClean}.txt`;
                const filePath = path.join(outputDir, fileName);
                
                const fileContent = [
                    `作品名：${title}`,
                    `エピソード：${epTitle}`,
                    '─'.repeat(20),
                    '',
                    episodeText
                ].join('\n');

                fs.writeFileSync(filePath, fileContent, 'utf-8');
                console.log(`      ✓ 保存完了: ${fileName}`);
            } else {
                console.log(`    ⚠ 本文が空でした（スキップします）`);
            }

        } catch (episodeError) {
            console.log(`    ⚠ 取得中にタイムアウトまたはエラーが発生しました（スキップ）: ${episodeError.message}`);
        }

        // サーバー負荷軽減のためのウェイト
        await sleep(4000);
    }
    
    console.log(`\n[COMPLETE] すべてのエピソードの保存が完了しました。保存先: ${outputDir}`);
}

async function main() {
    const homeDir = os.homedir();
    const chromeUserDataPath = path.join(homeDir, '.kakuyomu_puppeteer_profile');

    const browser = await puppeteer.launch({ 
        headless: false,
        userDataDir: chromeUserDataPath,
        defaultViewport: null, 
        args: [
            '--disable-blink-features=AutomationControlled',
            '--start-maximized' 
        ]
    });
    
    const pages = await browser.pages();
    const page = pages[0]; 
    
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    try {
        await fetchAndSaveEpisodes(page, TARGET_WORK_ID);
    } catch (err) {
        console.error("\n[ERROR] 致命的なエラーが発生しました:", err.message);
    } finally {
        await browser.close();
    }
}

main();