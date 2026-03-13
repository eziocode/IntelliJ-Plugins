/**
 * AutoDOM — Popup Controller
 * Manages the popup UI — Status tab + Config tab.
 * Auto-connects to the MCP server, no manual start needed.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const DOM = {
  actionBtn: $("#actionBtn"),
  actionBtnText: $("#actionBtnText"),
  portInput: $("#portInput"),
  statusCard: $("#statusCard"),
  statusLabel: $("#statusLabel"),
  statusDetail: $("#statusDetail"),
  tabTitle: $("#tabTitle"),
  tabUrl: $("#tabUrl"),
  logContainer: $("#logContainer"),
  logClear: $("#logClear"),
  connectBtn: $("#connectBtn"),
  autoConnectToggle: $("#autoConnectToggle"),
  aiChatBtn: $("#aiChatBtn"),
  providerSelect: $("#providerSelect"),
  providerApiKey: $("#providerApiKey"),
  providerModel: $("#providerModel"),
  saveProviderBtn: $("#saveProviderBtn"),
  providerStatus: $("#providerStatus"),
};

let isRunning = false;
let isConnected = false;
let providerSettings = {
  source: "ide",
  apiKey: "",
  model: "",
};

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(
        response ?? {
          success: false,
          error: "No response from extension background worker.",
        },
      );
    });
  });
}

// ─── Init ────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Load saved port, server path, auto-connect preference, and provider settings
  const stored = await chrome.storage.local.get([
    "mcpPort",
    "serverPath",
    "autoConnect",
    "aiProviderSource",
    "aiProviderApiKey",
    "aiProviderModel",
  ]);
  const port = stored.mcpPort || 9876;
  const serverPath = stored.serverPath || null;
  const autoConnect = stored.autoConnect !== false; // Default true

  providerSettings = {
    source: stored.aiProviderSource || "ide",
    apiKey: stored.aiProviderApiKey || "",
    model: stored.aiProviderModel || "",
  };

  DOM.portInput.value = port;
  DOM.autoConnectToggle.checked = autoConnect;
  if (DOM.providerSelect) DOM.providerSelect.value = providerSettings.source;
  if (DOM.providerApiKey) DOM.providerApiKey.value = providerSettings.apiKey;
  if (DOM.providerModel) DOM.providerModel.value = providerSettings.model;
  updateProviderUI();

  // Get active tab info
  refreshTabInfo();

  // Request current status
  const response = await sendRuntimeMessage({ type: "GET_STATUS" });
  if (response && !response.error) {
    isRunning = !!response.running;
    isConnected = !!response.connected;
    updateUI();
    if (response.connected) {
      addLog("Connected to MCP bridge server", "success");
    } else if (response.running) {
      addLog("MCP is starting. Auto-retry is active.", "info");
    } else {
      addLog("Auto-connecting... waiting for MCP server", "info");
    }
  } else if (response?.error) {
    addLog(`Background worker unavailable: ${response.error}`, "error");
  }

  // Init tabs
  initTabs();

  // Generate config snippets with auto-detected path
  generateConfigs(port, serverPath);

  // Update config when port changes
  DOM.portInput.addEventListener("change", async () => {
    const s = await chrome.storage.local.get(["serverPath"]);
    generateConfigs(
      parseInt(DOM.portInput.value, 10) || 9876,
      s.serverPath || null,
    );
  });

  // Update auto-connect preference
  DOM.autoConnectToggle.addEventListener("change", async (e) => {
    const autoConnect = e.target.checked;
    await chrome.storage.local.set({ autoConnect });
    // Tell service worker about the change
    const response = await sendRuntimeMessage({
      type: "SET_AUTO_CONNECT",
      value: autoConnect,
    });
    if (response?.error) {
      addLog(`Failed to update auto-connect: ${response.error}`, "error");
    }
  });

  // Listen for path/provider updates
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.serverPath) {
      generateConfigs(
        parseInt(DOM.portInput.value, 10) || 9876,
        changes.serverPath.newValue,
      );
    }

    if (
      changes.aiProviderSource ||
      changes.aiProviderApiKey ||
      changes.aiProviderModel
    ) {
      providerSettings = {
        source: changes.aiProviderSource
          ? changes.aiProviderSource.newValue
          : providerSettings.source,
        apiKey: changes.aiProviderApiKey
          ? changes.aiProviderApiKey.newValue
          : providerSettings.apiKey,
        model: changes.aiProviderModel
          ? changes.aiProviderModel.newValue
          : providerSettings.model,
      };

      if (DOM.providerSelect)
        DOM.providerSelect.value = providerSettings.source;
      if (DOM.providerApiKey)
        DOM.providerApiKey.value = providerSettings.apiKey || "";
      if (DOM.providerModel)
        DOM.providerModel.value = providerSettings.model || "";
      updateProviderUI();
    }
  });

  if (DOM.providerSelect) {
    DOM.providerSelect.addEventListener("change", () => {
      providerSettings.source = DOM.providerSelect.value || "ide";
      updateProviderUI();
    });
  }

  if (DOM.saveProviderBtn) {
    DOM.saveProviderBtn.addEventListener("click", saveProviderSettings);
  }
});

// ─── Tab Switching ───────────────────────────────────────────
function initTabs() {
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      // Deactivate all tabs
      $$(".tab").forEach((t) => t.classList.remove("active"));
      $$(".tab-content").forEach((tc) => tc.classList.remove("active"));
      // Activate clicked tab
      tab.classList.add("active");
      const target = tab.dataset.tab;
      $(`#tab-${target}`).classList.add("active");
    });
  });

  // Copy buttons
  $$(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const targetId = btn.dataset.copy;
      const el = $(`#${targetId}`);
      if (el) {
        const textDetail = el.textContent.trim();
        let success = false;

        try {
          // Try modern API first
          await navigator.clipboard.writeText(textDetail);
          success = true;
        } catch (err) {
          // Fallback to legacy execCommand (reliable in extension popups)
          try {
            const textArea = document.createElement("textarea");
            textArea.value = textDetail;
            // Avoid scrolling to bottom
            textArea.style.top = "0";
            textArea.style.left = "0";
            textArea.style.position = "fixed";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            success = document.execCommand("copy");
            document.body.removeChild(textArea);
          } catch (fallbackErr) {
            console.error("Clipboard copy failed:", fallbackErr);
          }
        }

        if (success) {
          btn.classList.add("copied");
          setTimeout(() => btn.classList.remove("copied"), 1500);
        } else {
          addLog("Failed to copy text", "error");
        }
      }
    });
  });
}

// ─── Config Generation ───────────────────────────────────────
function generateConfigs(port, detectedPath) {
  const isDetected = !!detectedPath;
  const serverPath = detectedPath || "autodom-extension/server/index.js";

  const portArg = port !== 9876 ? `\n        "--port", "${port}"` : "";

  $("#configPort").textContent = port;

  $("#serverPath").textContent = isDetected
    ? serverPath
    : `${serverPath}  (connect to auto-detect full path)`;
  $("#serverPath").style.color = isDetected ? "#22c55e" : "#f59e0b";

  // VS Code / Cursor
  $("#vscodeConfig").textContent = `{
  "mcpServers": {
    "autodom": {
      "command": "node",
      "args": ["${serverPath}"${portArg ? `,${portArg}` : ""}]
    }
  }
}`;

  // IntelliJ / JetBrains
  $("#intellijConfig").textContent = `{
  "mcpServers": {
    "autodom": {
      "command": "node",
      "args": ["${serverPath}"${portArg ? `,${portArg}` : ""}]
    }
  }
}`;

  // Gemini CLI
  $("#geminiConfig").textContent = `{
  "mcpServers": {
    "autodom": {
      "command": "node",
      "args": ["${serverPath}"${portArg ? `,${portArg}` : ""}]
    }
  }
}`;

  // Claude Desktop
  $("#claudeConfig").textContent = `{
  "mcpServers": {
    "autodom": {
      "command": "node",
      "args": ["${serverPath}"${portArg ? `,${portArg}` : ""}]
    }
  }
}`;
}

// ─── Event Listeners ─────────────────────────────────────────
DOM.actionBtn.addEventListener("click", () => {
  // Switch to Config tab
  $$(".tab").forEach((t) => t.classList.remove("active"));
  $$(".tab-content").forEach((tc) => tc.classList.remove("active"));

  $('[data-tab="config"]').classList.add("active");
  $("#tab-config").classList.add("active");
});

// ─── AI Chat Button ──────────────────────────────────────────
// Opens the AI chat panel on the active tab. Only works when MCP is connected.
DOM.aiChatBtn.addEventListener("click", async () => {
  // Always send the toggle request — the service worker and content script
  // will handle connection state. Slash commands work even without MCP bridge.
  // This avoids blocking on stale popup-local isConnected state.
  const response = await sendRuntimeMessage({ type: "TOGGLE_CHAT_PANEL" });
  if (response && response.success) {
    if (response.mcpActive) {
      addLog("AI Chat panel toggled on active tab", "success");
    } else {
      addLog(
        "AI Chat opened (MCP offline — slash commands still work)",
        "info",
      );
    }
    // Close the popup so user can interact with the chat panel
    window.close();
  } else {
    addLog(response?.error || "Failed to toggle AI Chat", "error");
  }
});

async function saveProviderSettings() {
  providerSettings = {
    source: DOM.providerSelect?.value || "ide",
    apiKey: DOM.providerApiKey?.value?.trim() || "",
    model: DOM.providerModel?.value?.trim() || "",
  };

  await chrome.storage.local.set({
    aiProviderSource: providerSettings.source,
    aiProviderApiKey: providerSettings.apiKey,
    aiProviderModel: providerSettings.model,
  });

  const response = await sendRuntimeMessage({
    type: "SET_AI_PROVIDER",
    provider: {
      source: providerSettings.source,
      apiKey: providerSettings.apiKey,
      model: providerSettings.model,
    },
  });

  updateProviderUI();

  if (response?.success) {
    addLog(
      `AI provider saved: ${formatProviderLabel(providerSettings.source)}`,
      "success",
    );
  } else {
    addLog(response?.error || "Failed to save AI provider settings", "error");
  }
}

DOM.connectBtn.addEventListener("click", async () => {
  const port = parseInt(DOM.portInput.value, 10);
  if (isNaN(port) || port < 1024 || port > 65535) {
    addLog("Invalid port. Must be 1024–65535.", "error");
    return;
  }

  await chrome.storage.local.set({ mcpPort: port });
  const stored = await chrome.storage.local.get(["serverPath"]);
  generateConfigs(port, stored.serverPath || null);

  if (!isRunning) {
    addLog(`Connecting to ws://127.0.0.1:${port}...`, "info");
    isRunning = true;
    isConnected = false;
    updateUI();

    const response = await sendRuntimeMessage({ type: "START_MCP", port });
    if (!response || !response.success) {
      isRunning = false;
      isConnected = false;
      updateUI();
      addLog(response?.error || "Could not start MCP.", "error");
      return;
    }
    if (response.connected) {
      isConnected = true;
      updateUI();
      addLog("MCP connection established!", "success");
    } else {
      addLog("MCP start requested. Auto-retry active.", "info");
    }
  } else {
    addLog("Stopping MCP...", "info");
    isRunning = false;
    isConnected = false;
    updateUI();

    const response = await sendRuntimeMessage({ type: "STOP_MCP" });
    if (response?.error) {
      addLog(`Failed to stop MCP: ${response.error}`, "error");
    } else {
      addLog("MCP stopped.", "warn");
    }
  }
});

DOM.logClear.addEventListener("click", () => {
  if (!DOM.logContainer) return;
  DOM.logContainer.innerHTML = "";
  addLog("Log cleared.", "info");
});

// Listen for status updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATUS_UPDATE") {
    isRunning = !!message.running;
    isConnected = !!message.connected;
    updateUI();
    if (message.log) {
      addLog(message.log, message.logLevel || "info");
    }
  }
  if (message.type === "TOOL_CALLED") {
    addLog(`Tool: ${message.tool}`, "success");
  }
  if (message.type === "AI_PROVIDER_STATUS") {
    if (message.provider) {
      providerSettings = {
        source: message.provider.source || providerSettings.source || "ide",
        apiKey: message.provider.apiKey || providerSettings.apiKey || "",
        model: message.provider.model || providerSettings.model || "",
      };
      if (DOM.providerSelect)
        DOM.providerSelect.value = providerSettings.source;
      if (DOM.providerModel)
        DOM.providerModel.value = providerSettings.model || "";
    }
    updateProviderUI(message.statusText);
  }
});

// ─── UI Helpers ──────────────────────────────────────────────
function updateUI() {
  if (isRunning) {
    DOM.connectBtn.style.color = "#ef4444";
    $("#connectBtnText").textContent = "Stop MCP";
    DOM.statusCard.className = isConnected
      ? "status-card connected"
      : "status-card";
    DOM.statusLabel.textContent = isConnected ? "Connected" : "Connecting";
    DOM.statusDetail.textContent = isConnected
      ? `Bridge server on ws://127.0.0.1:${DOM.portInput.value}`
      : `Trying ws://127.0.0.1:${DOM.portInput.value} with auto-retry`;
    DOM.portInput.disabled = true;
  } else {
    DOM.connectBtn.style.color = "";
    $("#connectBtnText").textContent = "Connect";
    DOM.statusCard.className = "status-card";
    DOM.statusLabel.textContent = "Waiting";
    DOM.statusDetail.textContent =
      "Auto-connecting — start the MCP server from your IDE";
    DOM.portInput.disabled = false;
  }

  updateProviderUI();
}

function formatProviderLabel(source) {
  switch (source) {
    case "openai":
      return "GPT";
    case "anthropic":
      return "Claude";
    default:
      return "IDE Agent";
  }
}

function updateProviderUI(statusOverride) {
  if (!DOM.providerStatus) return;

  const source = providerSettings.source || "ide";
  const label = formatProviderLabel(source);

  if (DOM.providerApiKey) {
    DOM.providerApiKey.disabled = source === "ide";
    DOM.providerApiKey.placeholder =
      source === "openai"
        ? "OpenAI API key"
        : source === "anthropic"
          ? "Anthropic API key"
          : "Not required for IDE Agent mode";
  }

  if (DOM.providerModel) {
    DOM.providerModel.disabled = source === "ide";
    if (!DOM.providerModel.value && source === "openai") {
      DOM.providerModel.value = "gpt-4.1";
    }
    if (!DOM.providerModel.value && source === "anthropic") {
      DOM.providerModel.value = "claude-3-7-sonnet-latest";
    }
  }

  if (statusOverride) {
    DOM.providerStatus.textContent = statusOverride;
    return;
  }

  if (source === "ide") {
    DOM.providerStatus.textContent = isConnected
      ? "Using IDE Agent over MCP"
      : "IDE Agent selected — connect MCP to enable full AI";
    return;
  }

  const hasApiKey = !!(providerSettings.apiKey || "").trim();
  const model = (providerSettings.model || "").trim();
  DOM.providerStatus.textContent = hasApiKey
    ? `${label} ready${model ? ` · ${model}` : ""}`
    : `${label} selected — add API key to enable direct AI`;
}

const tabSelect = $("#tabSelect");
const refreshTabsBtn = $("#refreshTabsBtn");

async function refreshTabInfo() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const activeTab = tabs.find((t) => t.active);

    // Update URL display
    if (activeTab) {
      DOM.tabUrl.textContent = activeTab.url || "—";
    } else {
      DOM.tabUrl.textContent = "—";
    }

    // Populate dropdown
    tabSelect.innerHTML = "";
    tabs.forEach((tab) => {
      const option = document.createElement("option");
      option.value = tab.id;
      option.textContent = `${tab.title || "(Untitled)"}`;
      if (tab.active) {
        option.selected = true;
      }
      tabSelect.appendChild(option);
    });
  } catch (e) {
    DOM.tabUrl.textContent = "—";
    tabSelect.innerHTML = '<option value="">Error loading tabs</option>';
  }
}

// Listen for dropdown changes to switch the active tab
tabSelect.addEventListener("change", async (e) => {
  const tabId = parseInt(e.target.value, 10);
  if (!isNaN(tabId)) {
    try {
      await chrome.tabs.update(tabId, { active: true });
      addLog(`Switched focus to tab ${tabId}`, "info");
      refreshTabInfo();
    } catch (err) {
      addLog(`Failed to switch tab: ${err.message}`, "error");
    }
  }
});

// Refresh button reloads the tab list
refreshTabsBtn.addEventListener("click", () => {
  refreshTabInfo();
  addLog("Refreshed tab list", "info");
});

function addLog(text, level = "info") {
  if (!DOM.logContainer) {
    console.warn("[AutoDOM] Log container not found:", text);
    return;
  }
  const entry = document.createElement("div");
  entry.className = `log-entry log-${level}`;
  const now = new Date();
  const time = now.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  entry.innerHTML = `<span class="log-time">${time}</span>${escapeHtml(text)}`;
  DOM.logContainer.appendChild(entry);
  DOM.logContainer.scrollTop = DOM.logContainer.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
