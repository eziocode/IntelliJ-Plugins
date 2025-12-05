#!/bin/bash

# Git Assume Unchanged Plugin - Installation Script
# This script installs the plugin into IntelliJ IDEA

set -e

PLUGIN_ZIP="gitAssume-1.0-SNAPSHOT.zip"
PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_PATH="$PLUGIN_DIR/$PLUGIN_ZIP"

echo "=========================================="
echo "Git Assume Unchanged Plugin Installer"
echo "=========================================="
echo ""

# Check if plugin file exists
if [ ! -f "$PLUGIN_PATH" ]; then
    echo "❌ Error: Plugin file not found: $PLUGIN_ZIP"
    echo "Please ensure $PLUGIN_ZIP is in the same directory as this script."
    exit 1
fi

echo "✅ Found plugin: $PLUGIN_ZIP"
echo ""

# Detect IntelliJ IDEA installation
INTELLIJ_PLUGINS_DIR=""

if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    INTELLIJ_PLUGINS_DIR="$HOME/Library/Application Support/JetBrains"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    INTELLIJ_PLUGINS_DIR="$HOME/.local/share/JetBrains"
elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
    # Windows (Git Bash or Cygwin)
    INTELLIJ_PLUGINS_DIR="$APPDATA/JetBrains"
else
    echo "❌ Unsupported operating system: $OSTYPE"
    exit 1
fi

echo "📁 IntelliJ plugins directory: $INTELLIJ_PLUGINS_DIR"
echo ""

# Find the latest IntelliJ IDEA installation
LATEST_IDEA=""
if [ -d "$INTELLIJ_PLUGINS_DIR" ]; then
    LATEST_IDEA=$(ls -d "$INTELLIJ_PLUGINS_DIR"/IntelliJIdea* 2>/dev/null | sort -V | tail -n 1)
fi

if [ -z "$LATEST_IDEA" ]; then
    echo "⚠️  Could not auto-detect IntelliJ IDEA installation."
    echo ""
    echo "Please install the plugin manually:"
    echo "1. Open IntelliJ IDEA"
    echo "2. Go to Settings/Preferences → Plugins"
    echo "3. Click the gear icon ⚙️ → Install Plugin from Disk..."
    echo "4. Select: $PLUGIN_PATH"
    echo "5. Restart IntelliJ IDEA"
    exit 0
fi

PLUGIN_INSTALL_DIR="$LATEST_IDEA/plugins"
echo "📦 Installing to: $PLUGIN_INSTALL_DIR"
echo ""

# Create plugins directory if it doesn't exist
mkdir -p "$PLUGIN_INSTALL_DIR"

# Extract plugin
PLUGIN_NAME="git-assume-unchanged"
PLUGIN_EXTRACT_DIR="$PLUGIN_INSTALL_DIR/$PLUGIN_NAME"

echo "🔧 Extracting plugin..."
rm -rf "$PLUGIN_EXTRACT_DIR"
mkdir -p "$PLUGIN_EXTRACT_DIR"
unzip -q "$PLUGIN_PATH" -d "$PLUGIN_EXTRACT_DIR"

echo "✅ Plugin installed successfully!"
echo ""
echo "=========================================="
echo "Next Steps:"
echo "=========================================="
echo "1. Restart IntelliJ IDEA"
echo "2. The plugin will be available in:"
echo "   Right-click file(s) → Git → Git Assume"
echo ""
echo "Features:"
echo "  • Assume Unchanged - Ignore file changes"
echo "  • No Assume Unchanged - Resume tracking"
echo "  • Works with single or multiple files"
echo "=========================================="
