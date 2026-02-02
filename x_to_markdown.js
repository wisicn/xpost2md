#!/usr/bin/env node

/**
 * X.com Article to Markdown Converter
 * 
 * Extracts full content from X.com articles and saves as markdown files.
 * No AI summarization - preserves all original content.
 * 
 * Usage: node x_to_markdown.js <x.com_url>
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

/**
 * Helper function to wait/delay
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sanitize title to create a safe filename
 * English only, short, no spaces
 */
function sanitizeFilename(title) {
    if (!title) return '';
    const ascii = title
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
    return ascii.substring(0, 60);
}

function buildFilename(data, url) {
    const title = data.title || '';
    let slug = sanitizeFilename(title);

    const handle = (data.handle || '').replace(/^@/, '').trim();
    const handleSlug = sanitizeFilename(handle);

    const match = url.match(/\/status\/(\d+)|\/article\/(\d+)/);
    const id = match ? (match[1] || match[2]) : '';

    if (!slug || slug.length < 3) {
        if (handleSlug && id) return `x_${handleSlug}_${id}`;
        if (id) return `x_article_${id}`;
        if (handleSlug) return `x_${handleSlug}`;
        return 'x_article';
    }

    return slug;
}

/**
 * Extract content from X.com article
 */
async function extractXContent(url) {
    console.log('Launching browser...');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        let bestNetworkArticle = { pieces: [], title: '', author: '' };
        let networkPieces = [];
        let bestNetworkBody = '';
        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

        page.on('response', async (response) => {
            try {
                const headers = response.headers() || {};
                const contentType = headers['content-type'] || '';
                if (!contentType.includes('application/json')) return;
                const url = response.url() || '';
                if (!/graphql|article/i.test(url)) return;
                const raw = await response.text();
                const fromRaw = extractArticleBodyFromJsonRaw(raw);
                if (fromRaw && fromRaw.length >= 200 && fromRaw.length > bestNetworkBody.length) {
                    bestNetworkBody = fromRaw;
                }
                const rawPieces = extractArticlePiecesFromJsonRaw(raw);
                if (rawPieces.length) {
                    const seen = new Set(networkPieces);
                    rawPieces.forEach(piece => {
                        if (!seen.has(piece)) {
                            seen.add(piece);
                            networkPieces.push(piece);
                        }
                    });
                }
                let data = null;
                try {
                    data = JSON.parse(raw);
                } catch (e) {
                    data = null;
                }
                if (!data) return;
                const candidate = extractArticlePiecesFromObject(data);
                if (candidate.pieces && candidate.pieces.length) {
                    const seen = new Set(networkPieces);
                    candidate.pieces.forEach(piece => {
                        if (!seen.has(piece)) {
                            seen.add(piece);
                            networkPieces.push(piece);
                        }
                    });
                }
                if ((candidate.pieces || []).length > (bestNetworkArticle.pieces || []).length) {
                    bestNetworkArticle = candidate;
                }
            } catch (e) {
                // ignore response parse errors
            }
        });

        console.log(`Loading URL: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(2000);

        // Expand any truncated text before attempting article navigation
        await expandAllShowMore(page);

        // Try to click article link if available
        try {
            const articleHref = await page.evaluate(() => {
                const link = document.querySelector('a[href*="/article/"], a[href*="/i/article/"]');
                return link ? link.href : '';
            });
            if (articleHref && articleHref !== page.url()) {
                console.log('Opening article link for full view...');
                await page.goto(articleHref, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(2000);
            }
        } catch (e) {
            console.log('No article link found, continuing with current view...');
        }

        await waitForArticleContent(page);

        // Expand any truncated text after navigation
        await expandAllShowMore(page);

        // Scroll to load all content
        console.log('Scrolling to load all content...');
        for (let i = 0; i < 5; i++) {
            await page.evaluate(() => window.scrollBy(0, 800));
            await delay(500);
        }
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(1000);

        // Expand one more time after scrolling (newly loaded content)
        await expandAllShowMore(page);

        await waitForArticleContent(page);

        // Extract content
        console.log('Extracting content...');
        const contentData = await page.evaluate(() => {
            const result = {
                title: '',
                author: '',
                handle: '',
                timestamp: '',
                stats: {},
                content: []
            };

            // Extract author info
            const authorElement = document.querySelector('[data-testid="User-Name"]');
            if (authorElement) {
                const nameEl = authorElement.querySelector('span');
                const handleEl = authorElement.querySelector('a[href^="/"]');
                if (nameEl) result.author = nameEl.innerText;
                if (handleEl) result.handle = handleEl.innerText;
            }

            // Extract timestamp
            const timeElement = document.querySelector('time');
            if (timeElement) {
                result.timestamp = timeElement.getAttribute('datetime') || timeElement.innerText;
            }

            // Extract stats
            const statsElements = document.querySelectorAll('[role="group"] span');
            const statsText = [];
            statsElements.forEach(el => {
                const text = el.innerText?.trim();
                if (text && /\d/.test(text)) {
                    statsText.push(text);
                }
            });
            result.stats = statsText.join(' | ');

            // Extract main content
            const candidates = [
                document.querySelector('[data-testid="article-body"]'),
                document.querySelector('[data-testid="articleBody"]'),
                document.querySelector('article'),
                document.querySelector('[data-testid="tweetText"]')?.closest('article'),
                document.querySelector('main')
            ].filter(Boolean);
            let container = candidates[0] || document.body;
            let maxLen = 0;
            for (const el of candidates) {
                const len = (el.innerText || '').length;
                if (len > maxLen) {
                    maxLen = len;
                    container = el;
                }
            }

            // Get text and images in DOM order
            const seenTexts = new Set();
            const seenImages = new Set();
            const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);

            const isSkippable = (el) => {
                if (!el) return true;
                if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
                const role = el.getAttribute && el.getAttribute('role');
                if (role === 'button') return true;
                return false;
            };

            while (walker.nextNode()) {
                const el = walker.currentNode;
                if (isSkippable(el)) continue;

                const tag = el.tagName ? el.tagName.toLowerCase() : '';

                if (tag === 'img') {
                    const src = el.getAttribute('src') || '';
                    if (src && src.includes('pbs.twimg.com') && !seenImages.has(src)) {
                        const w = el.naturalWidth || el.width || 0;
                        const h = el.naturalHeight || el.height || 0;
                        if (w > 100 && h > 100) {
                            seenImages.add(src);
                            result.content.push({
                                type: 'image',
                                src,
                                alt: el.getAttribute('alt') || 'Image'
                            });
                        }
                    }
                    continue;
                }

                // Semantic blocks
                if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'blockquote', 'pre'].includes(tag)) {
                    const text = el.innerText?.trim();
                    if (text && !seenTexts.has(text)) {
                        seenTexts.add(text);
                        result.content.push({
                            type: 'text',
                            tag,
                            content: text
                        });
                    }
                    continue;
                }

                // Leaf nodes with text (common in X articles)
                if ((tag === 'div' || tag === 'span') && el.children.length === 0) {
                    const text = el.innerText?.trim();
                    if (text && !seenTexts.has(text)) {
                        seenTexts.add(text);
                        result.content.push({
                            type: 'text',
                            tag: 'p',
                            content: text
                        });
                    }
                }
            }

            // Fallback: if we only captured a short summary, use raw innerText lines
            const totalTextLen = result.content
                .filter(item => item.type === 'text')
                .reduce((sum, item) => sum + (item.content?.length || 0), 0);
            if (totalTextLen < 400) {
                const articleBody = document.querySelector('[data-testid="article-body"], [data-testid="articleBody"]') || container;
                const raw = (articleBody && articleBody.innerText) ? articleBody.innerText : '';
                const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
                lines.forEach(line => {
                    if (seenTexts.has(line)) return;
                    let tag = 'p';
                    let content = line;
                    if (/^[-•]\s+/.test(line)) {
                        tag = 'li';
                        content = line.replace(/^[-•]\s+/, '');
                    }
                    seenTexts.add(line);
                    result.content.push({
                        type: 'text',
                        tag,
                        content
                    });
                });
            }

            // Final fallback: parse JSON-LD articleBody if still short
            const finalTextLen = result.content
                .filter(item => item.type === 'text')
                .reduce((sum, item) => sum + (item.content?.length || 0), 0);
            if (finalTextLen < 200) {
                const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
                scripts.forEach(script => {
                    try {
                        const data = JSON.parse(script.textContent || '');
                        const items = Array.isArray(data) ? data : [data];
                        items.forEach(item => {
                            const body = item && typeof item === 'object' ? item.articleBody : '';
                            if (body && typeof body === 'string') {
                                body.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
                                    if (seenTexts.has(line)) return;
                                    seenTexts.add(line);
                                    result.content.push({
                                        type: 'text',
                                        tag: 'p',
                                        content: line
                                    });
                                });
                            }
                        });
                    } catch (e) {
                        // ignore bad JSON
                    }
                });
            }

            // State fallback: extract article body from embedded JSON state
            const stateTextLen = result.content
                .filter(item => item.type === 'text')
                .reduce((sum, item) => sum + (item.content?.length || 0), 0);
            if (stateTextLen < 200) {
                const stateObjects = [];
                if (window.__INITIAL_STATE__) stateObjects.push(window.__INITIAL_STATE__);
                if (window.__APOLLO_STATE__) stateObjects.push(window.__APOLLO_STATE__);
                if (window.__NEXT_DATA__) stateObjects.push(window.__NEXT_DATA__);

                const scripts = Array.from(document.querySelectorAll('script'));
                scripts.forEach(script => {
                    const type = script.getAttribute('type') || '';
                    const id = script.getAttribute('id') || '';
                    const text = script.textContent || '';
                    if ((type === 'application/json' && text.trim().startsWith('{')) || id === '__NEXT_DATA__') {
                        try {
                            stateObjects.push(JSON.parse(text));
                        } catch (e) {}
                    } else if (text.includes('__INITIAL_STATE__')) {
                        const match = text.match(/__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*;?\s*$/);
                        if (match) {
                            try {
                                stateObjects.push(JSON.parse(match[1]));
                            } catch (e) {}
                        }
                    } else if (text.includes('__APOLLO_STATE__')) {
                        const match = text.match(/__APOLLO_STATE__\s*=\s*({[\s\S]*?})\s*;?\s*$/);
                        if (match) {
                            try {
                                stateObjects.push(JSON.parse(match[1]));
                            } catch (e) {}
                        }
                    }
                });

                const candidates = [];
                const titleCandidates = [];
                const authorCandidates = [];

                const stack = stateObjects.map(obj => ({ value: obj, key: '' }));
                while (stack.length) {
                    const { value, key } = stack.pop();
                    if (!value) continue;
                    if (typeof value === 'string') {
                        const text = value.trim();
                        if (text.length > 50) {
                            const newlineCount = (text.match(/\n/g) || []).length;
                            const score = text.length + newlineCount * 50;
                            candidates.push({ text, score });
                        }
                        if (/title$/i.test(key) && text.length > 5) {
                            titleCandidates.push(text);
                        }
                        if (/(author|byline|name)$/i.test(key) && text.length > 2) {
                            authorCandidates.push(text);
                        }
                        continue;
                    }
                    if (typeof value !== 'object') continue;
                    if (Array.isArray(value)) {
                        value.forEach((item, idx) => stack.push({ value: item, key }));
                    } else {
                        Object.keys(value).forEach(k => {
                            stack.push({ value: value[k], key: k });
                        });
                    }
                }

                if (!result.title && titleCandidates.length) {
                    result.title = titleCandidates[0];
                }
                if (!result.author && authorCandidates.length) {
                    result.author = authorCandidates[0];
                }

                candidates.sort((a, b) => b.score - a.score);
                const best = candidates[0];
                if (best && best.text) {
                    best.text.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
                        if (seenTexts.has(line)) return;
                        seenTexts.add(line);
                        result.content.push({
                            type: 'text',
                            tag: 'p',
                            content: line
                        });
                    });
                }
            }

            // Images are extracted in DOM order above

            // Extract title
            const firstHeading = container.querySelector('h1, h2');
            if (firstHeading) {
                result.title = firstHeading.innerText.trim();
            } else {
                const tweetText = container.querySelector('[data-testid="tweetText"]');
                if (tweetText) {
                    const text = tweetText.innerText.trim();
                    result.title = text.split('\n')[0].substring(0, 100);
                } else {
                    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
                    const docTitle = document.title || '';
                    result.title = (ogTitle || docTitle || '').trim();
                }
            }

            return result;
        });

        // HTML fallback: extract article body from embedded JSON in page HTML
        if (!contentData.content || contentData.content.length === 0) {
            const html = await page.content();
            const bodyText = extractArticleBodyFromHtml(html);
            if (bodyText) {
                contentData.content = bodyText.split('\n').map(l => l.trim()).filter(Boolean).map(line => ({
                    type: 'text',
                    tag: 'p',
                    content: line
                }));
            }
        }

        // Network fallback: use best JSON response candidate
        if (!contentData.content || contentData.content.length === 0) {
            if (bestNetworkBody && bestNetworkBody.length >= 200) {
                const combined = bestNetworkBody;
                contentData.content = combined.split('\n').map(l => l.trim()).filter(Boolean).map(line => ({
                    type: 'text',
                    tag: 'p',
                    content: line
                }));
            } else {
                const pieces = networkPieces.length ? networkPieces : (bestNetworkArticle.pieces || []);
                if (pieces.length) {
                    const combined = pieces.join('\n');
                    contentData.content = combined.split('\n').map(l => l.trim()).filter(Boolean).map(line => ({
                        type: 'text',
                        tag: 'p',
                        content: line
                    }));
                }
            }
            if (!contentData.title && bestNetworkArticle.title) {
                contentData.title = bestNetworkArticle.title;
            }
            if (!contentData.author && bestNetworkArticle.author) {
                contentData.author = bestNetworkArticle.author;
            }
        }

        await browser.close();
        return contentData;

    } catch (error) {
        await browser.close();
        throw error;
    }
}

/**
 * Extract a JSON string value by key from HTML, handling escaped quotes
 */
function extractJsonStringByKey(html, key) {
    const needle = `"${key}":"`;
    const start = html.indexOf(needle);
    if (start === -1) return '';
    let i = start + needle.length;
    let out = '';
    let escaped = false;
    while (i < html.length) {
        const ch = html[i];
        if (escaped) {
            out += '\\' + ch;
            escaped = false;
        } else if (ch === '\\') {
            escaped = true;
        } else if (ch === '"') {
            break;
        } else {
            out += ch;
        }
        i += 1;
    }
    if (!out) return '';
    try {
        return JSON.parse(`"${out}"`);
    } catch (e) {
        return out.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    }
}

/**
 * Try to extract article body text from raw JSON text
 */
function extractArticleBodyFromJsonRaw(raw) {
    if (!raw || raw.indexOf('"') === -1) return '';
    const keys = ['articleBody', 'article_body', 'article_body_html', 'full_text', 'fullText', 'note_text', 'noteText'];
    let best = '';
    for (const key of keys) {
        const val = extractJsonStringByKey(raw, key);
        if (val && val.length > best.length) {
            best = stripHtml(val);
        }
    }
    return best;
}

/**
 * Extract ordered article text pieces from raw JSON text
 */
function extractArticlePiecesFromJsonRaw(raw) {
    if (!raw || raw.indexOf('"') === -1) return [];
    const keys = [
        'articleBody',
        'article_body',
        'article_body_html',
        'full_text',
        'fullText',
        'note_text',
        'noteText',
        'text',
        'content',
        'paragraph',
        'section'
    ];
    const keyPattern = keys.map(k => k.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
    const regex = new RegExp(`"(?:${keyPattern})":"`, 'g');
    const pieces = [];
    let match;
    while ((match = regex.exec(raw)) !== null) {
        const start = match.index + match[0].length;
        let i = start;
        let out = '';
        let escaped = false;
        while (i < raw.length) {
            const ch = raw[i];
            if (escaped) {
                out += '\\' + ch;
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                break;
            } else {
                out += ch;
            }
            i += 1;
        }
        if (!out) continue;
        let text = '';
        try {
            text = JSON.parse(`"${out}"`);
        } catch (e) {
            text = out.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        }
        text = stripHtml(text.trim());
        if (text.length < 20) continue;
        if (looksLikeUrl(text)) continue;
        pieces.push(text);
    }
    return pieces;
}

/**
 * Try to extract article body text from HTML with JSON-embedded fields
 */
function extractArticleBodyFromHtml(html) {
    const keys = ['articleBody', 'article_body', 'article_body_html', 'full_text', 'fullText'];
    let best = '';
    for (const key of keys) {
        const val = extractJsonStringByKey(html, key);
        if (val && val.length > best.length) {
            best = stripHtml(val);
        }
    }
    return best;
}

/**
 * Extract article text pieces/title/author from a JSON object
 */
function extractArticlePiecesFromObject(obj) {
    const candidates = [];
    const titleCandidates = [];
    const authorCandidates = [];

    const stack = [{ value: obj, key: '', path: '' }];
    let order = 0;
    while (stack.length) {
        const { value, key, path } = stack.pop();
        if (!value) continue;
        if (typeof value === 'string') {
            const text = stripHtml(value.trim());
            const lowerKey = (key || '').toLowerCase();
            const lowerPath = (path || '').toLowerCase();
            if (text.length > 20 && !looksLikeUrl(text)) {
                const newlineCount = (text.match(/\n/g) || []).length;
                let score = text.length + newlineCount * 40;
                if (/article|body|paragraph|section|content|text|note|markdown|html/.test(lowerKey)) score += 80;
                if (/article|body|paragraph|section|content|text|note|markdown|html/.test(lowerPath)) score += 40;
                if (/url|link|image|media|avatar|profile|title|name|handle|username|screen_name|id|rest_id|slug/.test(lowerKey)) score -= 80;
                if (/url|link|image|media|avatar|profile|title|name|handle|username|screen_name|id|rest_id|slug/.test(lowerPath)) score -= 40;
                if (text.length > 200) score += 50;
                candidates.push({ text, score, order: order++ });
            }
            if (/title$/i.test(key) && text.length > 5) {
                titleCandidates.push(text);
            }
            if (/(author|byline|name)$/i.test(key) && text.length > 2) {
                authorCandidates.push(text);
            }
            continue;
        }
        if (typeof value !== 'object') continue;
        if (Array.isArray(value)) {
            value.forEach(item => stack.push({ value: item, key, path }));
        } else {
            Object.keys(value).forEach(k => {
                const nextPath = path ? `${path}.${k}` : k;
                stack.push({ value: value[k], key: k, path: nextPath });
            });
        }
    }

    const maxScore = candidates.reduce((max, c) => Math.max(max, c.score), 0);
    let minScore = Math.max(60, Math.floor(maxScore * 0.4));
    candidates.sort((a, b) => a.order - b.order);
    const pieces = [];
    const seen = new Set();
    for (const candidate of candidates) {
        if (candidate.score < minScore) continue;
        if (seen.has(candidate.text)) continue;
        seen.add(candidate.text);
        pieces.push(candidate.text);
    }
    if (pieces.length < 50) {
        minScore = 20;
        for (const candidate of candidates) {
            if (candidate.score < minScore) continue;
            if (seen.has(candidate.text)) continue;
            seen.add(candidate.text);
            pieces.push(candidate.text);
        }
    }
    return {
        pieces: pieces.slice(0, 200),
        title: titleCandidates[0] || '',
        author: authorCandidates[0] || ''
    };
}

function stripHtml(text) {
    if (!text || text.indexOf('<') === -1) return text;
    return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function looksLikeUrl(text) {
    return /^https?:\/\//i.test(text) || text.includes('http://') || text.includes('https://');
}

/**
 * Wait for article body content on /article/ URLs
 */
async function waitForArticleContent(page) {
    try {
        if (!page.url().includes('/article/')) return;
        await page.waitForSelector('[data-testid="article-body"], [data-testid="articleBody"], article, main', {
            timeout: 15000
        });
        await delay(500);
    } catch (e) {
        // Best-effort wait; ignore timeouts
    }
}
/**
 * Expand any "Show more"/"Read more" truncation controls
 */
async function expandAllShowMore(page) {
    try {
        await page.evaluate(() => {
            const targets = Array.from(document.querySelectorAll(
                '[data-testid="tweet-text-show-more-link"], div[role="button"], span[role="button"], a[role="link"]'
            ));
            targets.forEach(el => {
                const text = (el.innerText || '').trim().toLowerCase();
                if (text === 'show more' || text === 'read more' || text === 'see more') {
                    el.click();
                }
            });
        });
        await delay(500);
    } catch (e) {
        // Best-effort expansion; ignore failures
    }
}

/**
 * Convert extracted content to markdown
 */
function contentToMarkdown(data, url) {
    const lines = [];

    // Title
    let title = data.title?.trim() || 'X Article';
    if (!title || title === 'X Article') {
        const match = url.match(/\/status\/(\d+)|\/article\/(\d+)/);
        if (match) {
            title = `X Article ${match[1] || match[2]}`;
        }
    }
    lines.push(`# ${title}\n`);

    // Metadata
    if (data.author || data.handle) {
        let authorLine = `**Author:** ${data.author}`;
        if (data.handle) {
            authorLine += ` (${data.handle})`;
        }
        lines.push(authorLine);
    }

    if (data.timestamp) {
        lines.push(`**Date:** ${data.timestamp}`);
    }

    lines.push(`**Source:** [${url}](${url})`);

    if (data.stats) {
        lines.push(`**Stats:** ${data.stats}`);
    }

    lines.push('\n---\n');

    // Content
    const content = data.content || [];
    let currentListType = null;

    for (const item of content) {
        if (item.type === 'text') {
            const tag = item.tag || 'p';
            const text = item.content?.trim();

            if (!text) continue;

            // End list if starting a new block
            if (currentListType && tag !== 'li') {
                currentListType = null;
                lines.push('');
            }

            if (tag === 'h1') {
                lines.push(`\n# ${text}\n`);
            } else if (tag === 'h2') {
                lines.push(`\n## ${text}\n`);
            } else if (tag === 'h3') {
                lines.push(`\n### ${text}\n`);
            } else if (tag === 'h4') {
                lines.push(`\n#### ${text}\n`);
            } else if (tag === 'h5') {
                lines.push(`\n##### ${text}\n`);
            } else if (tag === 'h6') {
                lines.push(`\n###### ${text}\n`);
            } else if (tag === 'li') {
                lines.push(`- ${text}`);
                currentListType = 'ul';
            } else {
                lines.push(`\n${text}\n`);
            }
        } else if (item.type === 'image') {
            const src = item.src || '';
            const alt = item.alt || 'Image';
            if (src) {
                lines.push(`\n![${alt}](${src})\n`);
            }
        }
    }

    return lines.join('\n');
}

/**
 * Main function
 */
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log('Usage: node x_to_markdown.js [-o output_dir] <x.com_url>');
        console.log('\nExample:');
        console.log('  node x_to_markdown.js -o ./out_put https://x.com/bozhou_ai/status/2011738838767423983');
        process.exit(1);
    }

    let outputDirArg = '';
    let url = '';

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if ((arg === '-o' || arg === '--output') && args[i + 1]) {
            outputDirArg = args[i + 1];
            i += 1;
            continue;
        }
        if (!arg.startsWith('-') && !url) {
            url = arg;
        }
    }

    if (!url) {
        console.log('Usage: node x_to_markdown.js [-o output_dir] <x.com_url>');
        console.log('\nExample:');
        console.log('  node x_to_markdown.js -o ./out_put https://x.com/bozhou_ai/status/2011738838767423983');
        process.exit(1);
    }

    // Validate URL
    if (!url.includes('x.com') && !url.includes('twitter.com')) {
        console.error('Error: URL must be from x.com or twitter.com');
        process.exit(1);
    }

    console.log('\n' + '='.repeat(60));
    console.log('X.com to Markdown Converter');
    console.log('='.repeat(60) + '\n');

    try {
        // Extract content
        const data = await extractXContent(url);

        if (!data) {
            console.error('\nError: Failed to extract content from URL');
            process.exit(1);
        }

        // Convert to markdown
        const markdown = contentToMarkdown(data, url);

        // Generate filename
        const filename = buildFilename(data, url) + '.md';

        // Determine output directory
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        const outputDir = outputDirArg
            ? path.resolve(process.cwd(), outputDirArg)
            : path.join(homeDir, 'tmp');

        if ((!homeDir && !outputDirArg) || !fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) {
            console.error(`\nError: Output directory not found: ${outputDir}`);
            if (!outputDirArg) {
                console.error('Please create $HOME/tmp and try again.');
            }
            process.exit(1);
        }

        const outputPath = path.join(outputDir, filename);

        // Save to file
        fs.writeFileSync(outputPath, markdown, 'utf-8');

        console.log('\n' + '='.repeat(60));
        console.log(`✓ Successfully created: ${outputPath}`);
        console.log(`  File size: ${fs.statSync(outputPath).size} bytes`);
        console.log(`  Content items: ${data.content?.length || 0}`);
        console.log('='.repeat(60) + '\n');

    } catch (error) {
        console.error('\nError:', error.message);
        process.exit(1);
    }
}

main();
