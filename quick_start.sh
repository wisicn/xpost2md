#!/bin/bash

# Quick Start Guide for X.com to Markdown Converter

echo "======================================"
echo "X.com to Markdown Converter"
echo "Quick Start Guide"
echo "======================================"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed!"
    echo "Please install Node.js from: https://nodejs.org/"
    exit 1
fi

echo "✓ Node.js is installed: $(node --version)"
echo ""

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    echo ""
fi

echo "✓ Dependencies are ready"
echo ""
echo "======================================"
echo "Usage:"
echo "======================================"
echo ""
echo "  node x_to_markdown.js <x.com_url>"
echo ""
echo "Example:"
echo "  node x_to_markdown.js https://x.com/bozhou_ai/status/2011738838767423983"
echo ""
echo "======================================"
echo ""

# If URL is provided, run the script
if [ ! -z "$1" ]; then
    echo "Converting: $1"
    echo ""
    node x_to_markdown.js "$1"
fi
