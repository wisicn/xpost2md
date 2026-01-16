# X.com to Markdown Converter

A script that extracts **full content** from X.com (Twitter) articles and converts them to markdown files. No AI summarization - preserves all original content.

Available in both **Node.js** (recommended) and **Python** versions.

## Features

✅ **Full content extraction** - No summarization, captures everything  
✅ **Automatic title detection** - Uses article title for filename  
✅ **Preserves structure** - Maintains headings, lists, and paragraphs  
✅ **Image extraction** - Includes all images from the article  
✅ **Metadata capture** - Author, timestamp, stats (likes, retweets, etc.)  
✅ **Browser automation** - Handles dynamic content loading  

## Installation

### Option 1: Node.js (Recommended)

**Requirements:** Node.js 16+ and npm

```bash
# Install dependencies
npm install
```

That's it! Puppeteer will automatically download the required browser.

### Option 2: Python

**Requirements:** Python 3.7-3.13 (Note: Python 3.14 has compatibility issues)

```bash
# Create virtual environment (recommended)
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install playwright

# Install browser
playwright install chromium
```

## Usage

### Node.js Version

```bash
node x_to_markdown.js <x.com_url>
```

**Example:**
```bash
node x_to_markdown.js https://x.com/bozhou_ai/status/2011738838767423983
```

### Python Version

```bash
python x_to_markdown.py <x.com_url>
```

**Example:**
```bash
python x_to_markdown.py https://x.com/bozhou_ai/status/2011738838767423983
```

Both versions will create a markdown file named after the article title (e.g., `Obsidian零基础教程从入门到精通.md`)

## Output Format

The generated markdown file includes:

- **Title** (H1 heading)
- **Metadata** (Author, Date, Source URL, Stats)
- **Full Content** (All text, headings, lists, images)

Example output structure:

```markdown
# Article Title

**Author:** Name (@handle)
**Date:** 2026-01-16
**Source:** [URL](URL)
**Stats:** 33 Replies | 105 Reposts | 471 Likes

---

## Section 1

Content here...

![Image description](image_url)

## Section 2

More content...
```

## How It Works

1. **Browser Automation**: Uses Playwright to load the X.com page
2. **Content Loading**: Scrolls through the page to load all dynamic content
3. **Extraction**: Uses JavaScript to extract text, headings, images, and metadata
4. **Conversion**: Converts extracted content to properly formatted markdown
5. **File Creation**: Saves as `<title>.md` in the current directory

## Requirements

- Python 3.7+
- Playwright
- Internet connection

## Troubleshooting

### "playwright: command not found"

Make sure you've installed Playwright browsers:
```bash
playwright install chromium
```

### Timeout errors

The page might be loading slowly. The script waits up to 30 seconds. If you have a slow connection, you can modify the timeout in the script.

### Missing content

Some X.com pages require login. The script works best with public articles and threads.

## License

MIT License - Feel free to use and modify as needed.
