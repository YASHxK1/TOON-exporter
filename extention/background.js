/**
 * Background Service Worker v2
 *
 * Handles:
 *   - Context menu (right-click "Convert to TOON")
 *   - Storage operations
 *   - Extension lifecycle
 */

// ─── Context Menu Setup ──────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  // Create right-click context menu
  chrome.contextMenus.create({
    id: 'toon-convert-selection',
    title: '⚡ Convert to TOON',
    contexts: ['selection']
  });

  if (details.reason === 'install') {
    console.log('[TOON Exporter v2] Extension installed');
    chrome.storage.local.set({ toon_export_history: [] });
  }
});

// ─── Context Menu Click Handler ──────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'toon-convert-selection' && info.selectionText) {
    try {
      // Store the selection for the popup to consume
      await chrome.storage.local.set({
        toon_pending_selection: {
          text: info.selectionText,
          timestamp: Date.now(),
          url: tab?.url || '',
          title: tab?.title || ''
        }
      });

      // Open the popup (by programmatically triggering badge)
      // Since we can't open popup programmatically in MV3,
      // we'll inject a notification on the page
      if (tab?.id) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (text) => {
            // Create floating toast notification
            const existing = document.getElementById('toon-toast-overlay');
            if (existing) existing.remove();

            const toast = document.createElement('div');
            toast.id = 'toon-toast-overlay';
            toast.innerHTML = `
              <div style="
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 2147483647;
                background: #14141c;
                border: 1px solid rgba(254, 243, 192, 0.3);
                border-radius: 14px;
                padding: 16px 20px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 20px rgba(254, 243, 192, 0.15);
                font-family: -apple-system, system-ui, sans-serif;
                color: #e8e6f0;
                max-width: 360px;
                animation: toonSlideIn 0.3s ease-out;
                backdrop-filter: blur(12px);
              ">
                <style>
                  @keyframes toonSlideIn {
                    from { opacity: 0; transform: translateY(-12px); }
                    to { opacity: 1; transform: translateY(0); }
                  }
                  @keyframes toonFadeOut {
                    from { opacity: 1; transform: translateY(0); }
                    to { opacity: 0; transform: translateY(-12px); }
                  }
                </style>
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
                  <span style="font-size: 16px;">⚡</span>
                  <span style="font-weight: 700; font-size: 13px;">TOON Exporter</span>
                </div>
                <div style="font-size: 11px; color: #9896a8; margin-bottom: 10px;">
                  Selection saved! Click the extension icon to view & export.
                </div>
                <div style="
                  background: #111119;
                  border-radius: 8px;
                  padding: 10px;
                  font-family: 'JetBrains Mono', 'Fira Code', monospace;
                  font-size: 10px;
                  color: #fef3c0;
                  white-space: pre-wrap;
                  max-height: 80px;
                  overflow: hidden;
                  line-height: 1.4;
                ">${text.substring(0, 200).replace(/</g, '&lt;').replace(/>/g, '&gt;')}${text.length > 200 ? '…' : ''}</div>
              </div>
            `;
            document.body.appendChild(toast);

            // Auto-remove after 4 seconds
            setTimeout(() => {
              const el = document.getElementById('toon-toast-overlay');
              if (el) {
                el.firstElementChild.style.animation = 'toonFadeOut 0.3s ease-in forwards';
                setTimeout(() => el.remove(), 300);
              }
            }, 4000);
          },
          args: [info.selectionText]
        });
      }
    } catch (err) {
      console.error('[TOON Background] Context menu error:', err);
    }
  }
});

// ─── Message Handler ─────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'getHistory':
      chrome.storage.local.get('toon_export_history', (result) => {
        sendResponse({ history: result.toon_export_history || [] });
      });
      return true;

    case 'saveToHistory':
      chrome.storage.local.get('toon_export_history', (result) => {
        const history = result.toon_export_history || [];
        history.unshift(request.record);
        chrome.storage.local.set({ toon_export_history: history.slice(0, 50) }, () => {
          sendResponse({ success: true });
        });
      });
      return true;

    case 'clearHistory':
      chrome.storage.local.set({ toon_export_history: [] }, () => {
        sendResponse({ success: true });
      });
      return true;

    case 'deleteFromHistory':
      chrome.storage.local.get('toon_export_history', (result) => {
        const history = result.toon_export_history || [];
        chrome.storage.local.set({
          toon_export_history: history.filter(h => h.id !== request.id)
        }, () => {
          sendResponse({ success: true });
        });
      });
      return true;

    case 'getPendingSelection':
      chrome.storage.local.get('toon_pending_selection', (result) => {
        const pending = result.toon_pending_selection;
        // Clear it after reading
        chrome.storage.local.remove('toon_pending_selection');
        sendResponse({ pending: pending || null });
      });
      return true;
  }
});
