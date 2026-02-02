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

    const match = url.match(/\/status\/(\d+)/);
    const id = match ? match[1] : '';

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
        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

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
                }
            }

            return result;
        });

        await browser.close();
        return contentData;

    } catch (error) {
        await browser.close();
        throw error;
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
        const match = url.match(/\/status\/(\d+)/);
        if (match) {
            title = `X Article ${match[1]}`;
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
        console.log('Usage: node x_to_markdown.js <x.com_url>');
        console.log('\nExample:');
        console.log('  node x_to_markdown.js https://x.com/bozhou_ai/status/2011738838767423983');
        process.exit(1);
    }

    const url = args[0];

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
        const outputDir = path.join(homeDir, 'tmp');

        if (!homeDir || !fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) {
            console.error(`\nError: Output directory not found: ${outputDir}`);
            console.error('Please create $HOME/tmp and try again.');
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
