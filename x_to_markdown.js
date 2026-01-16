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
 */
function sanitizeFilename(title) {
    return title
        .replace(/[<>:"/\\|?*]/g, '')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .substring(0, 100)
        .replace(/^_+|_+$/g, '');
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

        // Try to click article link if available
        try {
            const articleLink = await page.$('a[href*="/article/"]');
            if (articleLink) {
                console.log('Clicking article link for full view...');
                await articleLink.click();
                await delay(2000);
            }
        } catch (e) {
            console.log('No article link found, continuing with current view...');
        }

        // Scroll to load all content
        console.log('Scrolling to load all content...');
        for (let i = 0; i < 5; i++) {
            await page.evaluate(() => window.scrollBy(0, 800));
            await delay(500);
        }
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(1000);

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
            let container = document.querySelector('article');
            if (!container) {
                container = document.querySelector('[data-testid="tweetText"]')?.closest('article');
            }
            if (!container) {
                container = document.body;
            }

            // Get all text content with hierarchy
            const textElements = container.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, [data-testid="tweetText"], div[lang]');
            const seenTexts = new Set();

            textElements.forEach(el => {
                const text = el.innerText?.trim();
                if (text && text.length > 0 && !seenTexts.has(text)) {
                    // Skip if this text is contained in a parent we already added
                    let skip = false;
                    for (const seenText of seenTexts) {
                        if (seenText.includes(text) && seenText.length > text.length) {
                            skip = true;
                            break;
                        }
                    }
                    if (!skip) {
                        seenTexts.add(text);
                        result.content.push({
                            type: 'text',
                            tag: el.tagName.toLowerCase(),
                            content: text
                        });
                    }
                }
            });

            // Extract images
            const images = container.querySelectorAll('img[src*="pbs.twimg.com"]');
            images.forEach(img => {
                if (img.width > 100 && img.height > 100) {
                    result.content.push({
                        type: 'image',
                        src: img.src,
                        alt: img.alt || 'Image'
                    });
                }
            });

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
        const title = data.title || 'x_article';
        const filename = sanitizeFilename(title) + '.md';

        // Save to file
        fs.writeFileSync(filename, markdown, 'utf-8');

        console.log('\n' + '='.repeat(60));
        console.log(`✓ Successfully created: ${filename}`);
        console.log(`  File size: ${fs.statSync(filename).size} bytes`);
        console.log(`  Content items: ${data.content?.length || 0}`);
        console.log('='.repeat(60) + '\n');

    } catch (error) {
        console.error('\nError:', error.message);
        process.exit(1);
    }
}

main();
