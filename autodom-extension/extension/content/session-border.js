/**
 * AutoDOM — Active Session Border Overlay
 *
 * Injects a neon blue transparent border around the viewport
 * when the tab is part of an active MCP session or recording.
 * This visually distinguishes controlled/recorded tabs.
 */

(function () {
    const OVERLAY_ID = '__bmcp_session_border';

    function showBorder() {
        if (document.getElementById(OVERLAY_ID)) return;

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.style.cssText = `
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483647;
      border: 2px solid rgba(59, 130, 246, 0.6);
      box-shadow: inset 0 0 12px rgba(99, 102, 241, 0.15),
                  inset 0 0 4px rgba(59, 130, 246, 0.25);
      border-radius: 0;
      transition: opacity 0.3s ease;
    `;

        // Add a small indicator badge in the top-right corner
        const badge = document.createElement('div');
        badge.style.cssText = `
      position: fixed;
      top: 6px;
      right: 6px;
      pointer-events: none;
      z-index: 2147483647;
      background: rgba(99, 102, 241, 0.85);
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
      font-size: 10px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 4px;
      letter-spacing: 0.5px;
      backdrop-filter: blur(8px);
      box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
      animation: bmcp-badge-pulse 3s ease-in-out infinite;
    `;
        badge.textContent = '⚡ MCP ACTIVE';
        badge.id = OVERLAY_ID + '_badge';

        // Add pulse animation
        const style = document.createElement('style');
        style.id = OVERLAY_ID + '_style';
        style.textContent = `
      @keyframes bmcp-badge-pulse {
        0%, 100% { opacity: 0.9; }
        50% { opacity: 0.6; }
      }
      @keyframes bmcp-border-glow {
        0%, 100% { border-color: rgba(59, 130, 246, 0.6); }
        50% { border-color: rgba(99, 102, 241, 0.8); }
      }
      #${OVERLAY_ID} {
        animation: bmcp-border-glow 4s ease-in-out infinite;
      }
    `;

        document.documentElement.appendChild(style);
        document.documentElement.appendChild(overlay);
        document.documentElement.appendChild(badge);
    }

    function hideBorder() {
        const overlay = document.getElementById(OVERLAY_ID);
        const badge = document.getElementById(OVERLAY_ID + '_badge');
        const style = document.getElementById(OVERLAY_ID + '_style');
        if (overlay) overlay.remove();
        if (badge) badge.remove();
        if (style) style.remove();
    }

    // Listen for messages from the service worker
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'SHOW_SESSION_BORDER') {
            showBorder();
        }
        if (message.type === 'HIDE_SESSION_BORDER') {
            hideBorder();
        }
    });

    // Expose for direct injection
    window.__bmcp_showBorder = showBorder;
    window.__bmcp_hideBorder = hideBorder;
})();
