#!/usr/bin/env python3
"""
X.com Article to Markdown Converter

This script extracts full content from X.com articles and saves them as markdown files.
It uses browser automation to handle dynamic content loading.

Usage:
    python x_to_markdown.py <x.com_url>
    
Example:
    python x_to_markdown.py https://x.com/bozhou_ai/status/2011738838767423983
"""

import sys
import re
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout


def sanitize_filename(title: str) -> str:
    """Convert title to a safe filename."""
    # Remove or replace invalid filename characters
    safe_title = re.sub(r'[<>:"/\\|?*]', '', title)
    # Replace spaces and multiple underscores
    safe_title = re.sub(r'\s+', '_', safe_title)
    safe_title = re.sub(r'_+', '_', safe_title)
    # Limit length
    safe_title = safe_title[:100]
    return safe_title.strip('_')


def extract_x_content(url: str, headless: bool = True) -> dict:
    """
    Extract full content from X.com article using browser automation.
    
    Args:
        url: X.com article URL
        headless: Run browser in headless mode
        
    Returns:
        Dictionary containing title, author, content, and metadata
    """
    with sync_playwright() as p:
        # Launch browser
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context(
            viewport={'width': 1280, 'height': 720},
            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        )
        page = context.new_page()
        
        try:
            print(f"Loading URL: {url}")
            page.goto(url, wait_until='networkidle', timeout=30000)
            
            # Wait for content to load
            page.wait_for_timeout(2000)
            
            # Try to click "Article" or "Focus mode" link if available
            try:
                article_link = page.locator('a[href*="/article/"]').first
                if article_link.is_visible(timeout=3000):
                    print("Clicking article link for full view...")
                    article_link.click()
                    page.wait_for_timeout(2000)
            except:
                print("No article link found, continuing with current view...")
            
            # Scroll to load all content
            print("Scrolling to load all content...")
            for _ in range(5):
                page.evaluate('window.scrollBy(0, 800)')
                page.wait_for_timeout(500)
            
            page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
            page.wait_for_timeout(1000)
            
            # Extract content using JavaScript
            print("Extracting content...")
            content_data = page.evaluate('''() => {
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
                
                // Extract stats (likes, retweets, etc)
                const statsElements = document.querySelectorAll('[role="group"] [data-testid*="count"]');
                statsElements.forEach(el => {
                    const text = el.innerText;
                    const testId = el.getAttribute('data-testid');
                    if (testId) {
                        result.stats[testId] = text;
                    }
                });
                
                // Extract main content - try article first, then tweet
                let container = document.querySelector('article');
                if (!container) {
                    container = document.querySelector('[data-testid="tweetText"]')?.closest('article');
                }
                if (!container) {
                    container = document.body;
                }
                
                // Get all text content with hierarchy
                const textElements = container.querySelectorAll('h1, h2, h3, h4, p, li, [data-testid="tweetText"]');
                const seenTexts = new Set();
                
                textElements.forEach(el => {
                    const text = el.innerText?.trim();
                    if (text && text.length > 0 && !seenTexts.has(text)) {
                        seenTexts.add(text);
                        result.content.push({
                            type: 'text',
                            tag: el.tagName.toLowerCase(),
                            content: text
                        });
                    }
                });
                
                // Extract images
                const images = container.querySelectorAll('img[src*="pbs.twimg.com"]');
                images.forEach(img => {
                    if (img.width > 100 && img.height > 100) { // Filter out icons
                        result.content.push({
                            type: 'image',
                            src: img.src,
                            alt: img.alt || ''
                        });
                    }
                });
                
                // Try to extract title from first heading or tweet text
                const firstHeading = container.querySelector('h1, h2');
                if (firstHeading) {
                    result.title = firstHeading.innerText.trim();
                } else {
                    const tweetText = container.querySelector('[data-testid="tweetText"]');
                    if (tweetText) {
                        const text = tweetText.innerText.trim();
                        result.title = text.split('\\n')[0].substring(0, 100);
                    }
                }
                
                return result;
            }()''')
            
            browser.close()
            return content_data
            
        except PlaywrightTimeout:
            print("Error: Timeout while loading page")
            browser.close()
            return None
        except Exception as e:
            print(f"Error: {e}")
            browser.close()
            return None


def content_to_markdown(data: dict, url: str) -> str:
    """
    Convert extracted content to markdown format.
    
    Args:
        data: Extracted content dictionary
        url: Original URL
        
    Returns:
        Formatted markdown string
    """
    md_lines = []
    
    # Title
    title = data.get('title', 'X Article').strip()
    if not title or title == 'X Article':
        # Extract from URL as fallback
        match = re.search(r'/status/(\d+)', url)
        if match:
            title = f"X Article {match.group(1)}"
    
    md_lines.append(f"# {title}\n")
    
    # Metadata
    author = data.get('author', '')
    handle = data.get('handle', '')
    timestamp = data.get('timestamp', '')
    
    if author or handle:
        author_line = f"**Author:** {author}"
        if handle:
            author_line += f" ({handle})"
        md_lines.append(author_line)
    
    if timestamp:
        md_lines.append(f"**Date:** {timestamp}")
    
    md_lines.append(f"**Source:** [{url}]({url})")
    
    # Stats
    stats = data.get('stats', {})
    if stats:
        stats_parts = []
        for key, value in stats.items():
            label = key.replace('data-testid="', '').replace('"', '').replace('-', ' ').title()
            stats_parts.append(f"{value} {label}")
        if stats_parts:
            md_lines.append(f"**Stats:** {' | '.join(stats_parts)}")
    
    md_lines.append("\n---\n")
    
    # Content
    content_items = data.get('content', [])
    current_list_type = None
    
    for item in content_items:
        item_type = item.get('type')
        
        if item_type == 'text':
            tag = item.get('tag', 'p')
            text = item.get('content', '').strip()
            
            if not text:
                continue
            
            # End list if we're starting a new block
            if current_list_type and tag not in ['li']:
                current_list_type = None
                md_lines.append('')
            
            if tag == 'h1':
                md_lines.append(f"\n# {text}\n")
            elif tag == 'h2':
                md_lines.append(f"\n## {text}\n")
            elif tag == 'h3':
                md_lines.append(f"\n### {text}\n")
            elif tag == 'h4':
                md_lines.append(f"\n#### {text}\n")
            elif tag == 'li':
                md_lines.append(f"- {text}")
                current_list_type = 'ul'
            else:
                md_lines.append(f"\n{text}\n")
        
        elif item_type == 'image':
            src = item.get('src', '')
            alt = item.get('alt', 'Image')
            if src:
                md_lines.append(f"\n![{alt}]({src})\n")
    
    return '\n'.join(md_lines)


def main():
    """Main function to process X.com URL and create markdown file."""
    if len(sys.argv) < 2:
        print("Usage: python x_to_markdown.py <x.com_url>")
        print("\nExample:")
        print("  python x_to_markdown.py https://x.com/bozhou_ai/status/2011738838767423983")
        sys.exit(1)
    
    url = sys.argv[1]
    
    # Validate URL
    if 'x.com' not in url and 'twitter.com' not in url:
        print("Error: URL must be from x.com or twitter.com")
        sys.exit(1)
    
    print(f"\n{'='*60}")
    print("X.com to Markdown Converter")
    print(f"{'='*60}\n")
    
    # Extract content
    data = extract_x_content(url)
    
    if not data:
        print("\nError: Failed to extract content from URL")
        sys.exit(1)
    
    # Convert to markdown
    markdown_content = content_to_markdown(data, url)
    
    # Generate filename
    title = data.get('title', 'x_article')
    filename = sanitize_filename(title) + '.md'
    
    # Determine output directory
    output_dir = Path.home() / 'tmp'
    if not output_dir.exists() or not output_dir.is_dir():
        print(f"\nError: Output directory not found: {output_dir}")
        print("Please create $HOME/tmp and try again.")
        sys.exit(1)

    # Save to file
    output_path = output_dir / filename
    output_path.write_text(markdown_content, encoding='utf-8')
    
    print(f"\n{'='*60}")
    print(f"✓ Successfully created: {output_path}")
    print(f"  File size: {output_path.stat().st_size} bytes")
    print(f"  Content items: {len(data.get('content', []))}")
    print(f"{'='*60}\n")


if __name__ == '__main__':
    main()
