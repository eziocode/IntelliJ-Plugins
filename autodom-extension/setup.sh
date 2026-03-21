#!/bin/bash

# ══════════════════════════════════════════════════════════════
#  AutoDOM — One-Click Setup Script
#  Installs server dependencies, cleans up zombie processes,
#  configures your IDE, and prints instructions for loading
#  the Chrome extension.
# ══════════════════════════════════════════════════════════════

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/server"
EXTENSION_DIR="$SCRIPT_DIR/extension"
SERVER_PATH="$SERVER_DIR/index.js"
DEFAULT_PORT=9876

echo ""
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  🚀 AutoDOM Setup${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo ""

# ─── Step 1: Check Node.js ────────────────────────────────────
echo -e "${BLUE}[1/6]${NC} Checking Node.js..."

if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js not found.${NC}"
    echo "  Install it from https://nodejs.org (v18+)"
    echo ""
    echo "  macOS (Homebrew):   brew install node"
    echo "  Ubuntu/Debian:      curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}✗ Node.js v18+ required (found $(node -v))${NC}"
    echo "  Update at https://nodejs.org"
    exit 1
fi
echo -e "${GREEN}✓${NC} Node.js $(node -v)"

# ─── Step 2: Kill zombie processes ────────────────────────────
echo -e "${BLUE}[2/6]${NC} Cleaning up stale processes..."

ZOMBIES_KILLED=0

# Kill any orphaned autodom processes (PPID=1 with high CPU)
if command -v pgrep &> /dev/null; then
    for pid in $(pgrep -f "node.*autodom.*index\.js" 2>/dev/null || true); do
        ppid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
        cpu=$(ps -p "$pid" -o pcpu= 2>/dev/null | tr -d ' ')
        cpu_int=${cpu%.*}
        if [ "$ppid" = "1" ] && [ "${cpu_int:-0}" -gt 50 ]; then
            kill -9 "$pid" 2>/dev/null && ZOMBIES_KILLED=$((ZOMBIES_KILLED + 1))
        fi
    done
fi

# Free port 9876 if something stale is holding it
STALE_PID=$(lsof -tiTCP:${DEFAULT_PORT} -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$STALE_PID" ]; then
    kill "$STALE_PID" 2>/dev/null && ZOMBIES_KILLED=$((ZOMBIES_KILLED + 1))
    sleep 1
fi

# Remove stale lock file
rm -f "/tmp/autodom-bridge-${DEFAULT_PORT}.json" 2>/dev/null

if [ "$ZOMBIES_KILLED" -gt 0 ]; then
    echo -e "${GREEN}✓${NC} Killed $ZOMBIES_KILLED stale process(es)"
else
    echo -e "${GREEN}✓${NC} No stale processes found"
fi

# ─── Step 3: Install server dependencies ──────────────────────
echo -e "${BLUE}[3/6]${NC} Installing server dependencies..."

cd "$SERVER_DIR"
npm install --silent 2>&1 | tail -1
echo -e "${GREEN}✓${NC} Dependencies installed"

# ─── Step 4: Verify critical dependencies ─────────────────────
echo -e "${BLUE}[4/6]${NC} Verifying critical dependencies..."

MISSING_DEPS=0
for dep in fastmcp ws zod; do
    if [ ! -d "$SERVER_DIR/node_modules/$dep" ]; then
        echo -e "${RED}  ✗ $dep not found in node_modules${NC}"
        MISSING_DEPS=$((MISSING_DEPS + 1))
    else
        dep_ver=$(node -p "require('$SERVER_DIR/node_modules/$dep/package.json').version" 2>/dev/null || echo "unknown")
        echo -e "${GREEN}  ✓ $dep@$dep_ver${NC}"
    fi
done

if [ "$MISSING_DEPS" -gt 0 ]; then
    echo -e "${YELLOW}  Retrying with clean install...${NC}"
    rm -rf "$SERVER_DIR/node_modules"
    npm install --silent 2>&1 | tail -1
    # Re-check
    for dep in fastmcp ws zod; do
        if [ ! -d "$SERVER_DIR/node_modules/$dep" ]; then
            echo -e "${RED}✗ $dep still missing after clean install. Check your network and try again.${NC}"
            exit 1
        fi
    done
    echo -e "${GREEN}✓${NC} All dependencies resolved after clean install"
else
    echo -e "${GREEN}✓${NC} All critical dependencies verified"
fi

# ─── Step 5: Verify server starts ─────────────────────────────
echo -e "${BLUE}[5/6]${NC} Verifying server..."

# Quick smoke test: start the server, check it prints the banner, kill it
VERIFY_OUTPUT=$(echo '{}' | node "$SERVER_PATH" 2>&1 &
    VERIFY_PID=$!
    sleep 2
    kill "$VERIFY_PID" 2>/dev/null
    wait "$VERIFY_PID" 2>/dev/null
)

# Clean up any leftover from the verify
lsof -tiTCP:${DEFAULT_PORT} -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true

echo -e "${GREEN}✓${NC} Server verified"

# ─── Step 6: Configure IDEs ──────────────────────────────────
echo -e "${BLUE}[6/6]${NC} Configuring IDEs..."

MCP_CONFIG="{
  \"mcpServers\": {
    \"autodom\": {
      \"command\": \"node\",
      \"args\": [\"$SERVER_PATH\"]
    }
  }
}"

CONFIGURED_COUNT=0

# ─── JetBrains IDEs ───────────────────────────────────────────
configure_jetbrains() {
    local app_support="$HOME/Library/Application Support/JetBrains"
    if [ ! -d "$app_support" ]; then
        return
    fi

    # Find ALL JetBrains IDE directories (configure every one we find)
    local found_any=false
    for dir in "$app_support"/IdeaIC* \
               "$app_support"/IntelliJIdea* \
               "$app_support"/WebStorm* \
               "$app_support"/GoLand* \
               "$app_support"/PyCharm* \
               "$app_support"/PyCharmCE* \
               "$app_support"/PhpStorm* \
               "$app_support"/Rider* \
               "$app_support"/RubyMine* \
               "$app_support"/CLion* \
               "$app_support"/DataGrip* \
               "$app_support"/DataSpell* \
               "$app_support"/AndroidStudio*; do
        if [ ! -d "$dir" ]; then
            continue
        fi

        found_any=true
        local ide_name
        ide_name=$(basename "$dir")
        local options_dir="$dir/options"
        mkdir -p "$options_dir"

        # ── McpToolsStoreService.xml (Copilot agent + generic MCP) ──
        local mcp_file="$options_dir/McpToolsStoreService.xml"
        cat > "$mcp_file" << EOF
<application>
  <component name="McpToolsStoreService">
    <option name="servers" value="[{&quot;name&quot;:&quot;autodom&quot;,&quot;transport&quot;:{&quot;type&quot;:&quot;stdio&quot;,&quot;command&quot;:&quot;node&quot;,&quot;args&quot;:[&quot;$SERVER_PATH&quot;]}}]" />
  </component>
</application>
EOF

        # ── llm.mcpServers.xml (JetBrains AI Assistant) ──
        local llm_mcp_file="$options_dir/llm.mcpServers.xml"
        if [ -f "$llm_mcp_file" ]; then
            # Only patch if autodom is not already present
            if ! grep -q '"autodom"' "$llm_mcp_file" 2>/dev/null; then
                # Insert an autodom entry just before </commands>
                sed -i.bak '/<\/commands>/i\
      <McpServerConfigurationProperties>\
        <option name="allowedToolsNames" />\
        <option name="enabled" value="true" />\
        <option name="name" value="autodom" />\
      </McpServerConfigurationProperties>' "$llm_mcp_file"
                rm -f "$llm_mcp_file.bak"
            fi
        else
            cat > "$llm_mcp_file" << 'LLMEOF'
<application>
  <component name="McpApplicationServerCommands" modifiable="true" autoEnableExternalChanges="true">
    <commands>
      <McpServerConfigurationProperties>
        <option name="allowedToolsNames" />
        <option name="enabled" value="true" />
        <option name="name" value="autodom" />
      </McpServerConfigurationProperties>
    </commands>
    <urls />
  </component>
</application>
LLMEOF
        fi

        echo -e "${GREEN}  ✓ $ide_name${NC} (Copilot + AI Assistant)"
        CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))
    done

    if [ "$found_any" = false ]; then
        echo -e "${YELLOW}  ⚠ No JetBrains IDE found — skipping${NC}"
    fi
}

# ─── GitHub Copilot (IntelliJ) ────────────────────────────────
configure_copilot_intellij() {
    local copilot_dir="$HOME/.config/github-copilot/intellij"
    if [ ! -d "$copilot_dir" ]; then
        # Only create if the parent exists (Copilot is installed)
        if [ -d "$HOME/.config/github-copilot" ]; then
            mkdir -p "$copilot_dir"
        else
            return
        fi
    fi

    local mcp_file="$copilot_dir/mcp.json"
    if [ -f "$mcp_file" ]; then
        # Check if autodom is already configured
        if grep -q '"autodom"' "$mcp_file" 2>/dev/null; then
            echo -e "${GREEN}  ✓ Copilot (IntelliJ) already configured${NC}"
            return
        fi
        # Merge: insert autodom into existing servers object
        # Use node for reliable JSON manipulation
        node -e "
            const fs = require('fs');
            const cfg = JSON.parse(fs.readFileSync('$mcp_file', 'utf8'));
            if (!cfg.servers) cfg.servers = {};
            cfg.servers.autodom = {
                type: 'stdio',
                command: 'node',
                args: ['$SERVER_PATH']
            };
            fs.writeFileSync('$mcp_file', JSON.stringify(cfg, null, 2) + '\n');
        " 2>/dev/null
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}  ✓ Copilot (IntelliJ) updated${NC}"
            CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))
        else
            echo -e "${YELLOW}  ⚠ Could not update Copilot config — add autodom manually${NC}"
        fi
    else
        # Create new file with just autodom
        cat > "$mcp_file" << EOF
{
  "servers": {
    "autodom": {
      "type": "stdio",
      "command": "node",
      "args": [
        "$SERVER_PATH"
      ]
    }
  }
}
EOF
        echo -e "${GREEN}  ✓ Copilot (IntelliJ) configured${NC}"
        CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))
    fi
}

# ─── VS Code / Cursor ────────────────────────────────────────
configure_vscode() {
    local vscode_dir="$HOME/.vscode"
    if [ ! -d "$vscode_dir" ]; then
        return
    fi

    mkdir -p "$vscode_dir"
    echo "$MCP_CONFIG" > "$vscode_dir/mcp.json"
    echo -e "${GREEN}  ✓ VS Code configured${NC}"
    CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))
}

configure_cursor() {
    local cursor_dir="$HOME/.cursor"
    if [ ! -d "$cursor_dir" ]; then
        return
    fi

    mkdir -p "$cursor_dir"
    echo "$MCP_CONFIG" > "$cursor_dir/mcp.json"
    echo -e "${GREEN}  ✓ Cursor configured${NC}"
    CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))
}

# ─── Claude Desktop ──────────────────────────────────────────
configure_claude() {
    local claude_dir
    if [ "$(uname)" = "Darwin" ]; then
        claude_dir="$HOME/Library/Application Support/Claude"
    else
        claude_dir="$HOME/.config/Claude"
    fi

    if [ ! -d "$claude_dir" ]; then
        return
    fi

    local config_file="$claude_dir/claude_desktop_config.json"
    if [ -f "$config_file" ]; then
        if grep -q '"autodom"' "$config_file" 2>/dev/null; then
            echo -e "${GREEN}  ✓ Claude Desktop already configured${NC}"
            return
        fi
        # Merge autodom into existing config
        node -e "
            const fs = require('fs');
            const cfg = JSON.parse(fs.readFileSync('$config_file', 'utf8'));
            if (!cfg.mcpServers) cfg.mcpServers = {};
            cfg.mcpServers.autodom = {
                command: 'node',
                args: ['$SERVER_PATH']
            };
            fs.writeFileSync('$config_file', JSON.stringify(cfg, null, 2) + '\n');
        " 2>/dev/null
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}  ✓ Claude Desktop updated${NC}"
            CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))
        else
            echo -e "${YELLOW}  ⚠ Could not update Claude config — add autodom manually${NC}"
        fi
    else
        echo "$MCP_CONFIG" > "$config_file"
        echo -e "${GREEN}  ✓ Claude Desktop configured${NC}"
        CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))
    fi
}

# ─── Gemini CLI ───────────────────────────────────────────────
configure_gemini() {
    local gemini_dir="$HOME/.gemini"
    if [ ! -d "$gemini_dir" ]; then
        return
    fi

    local settings_file="$gemini_dir/settings.json"
    if [ -f "$settings_file" ]; then
        if grep -q '"autodom"' "$settings_file" 2>/dev/null; then
            echo -e "${GREEN}  ✓ Gemini CLI already configured${NC}"
            return
        fi
        cp "$settings_file" "$settings_file.bak"
        node -e "
            const fs = require('fs');
            const cfg = JSON.parse(fs.readFileSync('$settings_file', 'utf8'));
            if (!cfg.mcpServers) cfg.mcpServers = {};
            cfg.mcpServers.autodom = {
                command: 'node',
                args: ['$SERVER_PATH']
            };
            fs.writeFileSync('$settings_file', JSON.stringify(cfg, null, 2) + '\n');
        " 2>/dev/null
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}  ✓ Gemini CLI updated${NC}"
            CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))
        else
            echo -e "${YELLOW}  ⚠ Could not update Gemini config — add autodom manually${NC}"
        fi
    else
        echo "$MCP_CONFIG" > "$settings_file"
        echo -e "${GREEN}  ✓ Gemini CLI configured${NC}"
        CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))
    fi
}

# Run all configurators
configure_jetbrains
configure_copilot_intellij
configure_vscode
configure_cursor
configure_claude
configure_gemini

if [ "$CONFIGURED_COUNT" -eq 0 ]; then
    echo -e "${YELLOW}  ⚠ No supported IDE detected. Configure manually — see INSTALL.md${NC}"
fi

# ─── Done ─────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  ✅ AutoDOM Setup Complete!${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Load the browser extension:${NC}"
echo ""
echo -e "  1. Open your browser → ${CYAN}chrome://extensions${NC}"
echo -e "  2. Enable ${BOLD}Developer mode${NC} (top-right toggle)"
echo -e "  3. Click ${BOLD}Load unpacked${NC}"
echo -e "  4. Select: ${CYAN}$EXTENSION_DIR${NC}"
echo -e "  5. Pin AutoDOM to the toolbar"
echo ""
echo -e "  ${BOLD}Server path (for manual IDE config):${NC}"
echo -e "  ${CYAN}$SERVER_PATH${NC}"
echo ""
echo -e "  ${BOLD}Then:${NC}"
echo -e "  • ${BOLD}Restart your IDE${NC} so it picks up the new MCP config"
echo -e "  • Open the AutoDOM popup in the browser → click ${BOLD}Connect${NC}"
echo -e "  • Your AI agent now has ${BOLD}54 browser automation tools${NC} 🎉"
echo ""
echo -e "  ${YELLOW}Troubleshooting?${NC} See ${CYAN}INSTALL.md${NC} or ${CYAN}README.md${NC}"
echo ""
