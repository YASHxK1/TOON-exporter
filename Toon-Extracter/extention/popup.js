/**
 * Popup Script v2 – Universal TOON Exporter
 *
 * Works on ALL websites. Shows selection-based actions universally,
 * plus full chat export on ChatGPT/Claude.
 */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  // DOM refs
  const siteIndicator = $('#siteIndicator');
  const statusDot = $('#statusDot');
  const statusText = $('#statusText');

  const btnConvertSelection = $('#btnConvertSelection');
  const btnExtractPage = $('#btnExtractPage');
  const btnExportFull = $('#btnExportFull');
  const extractPageTitle = $('#extractPageTitle');
  const extractPageDesc = $('#extractPageDesc');
  const fullExportDesc = $('#fullExportDesc');

  const formatOptions = $('#formatOptions');
  const formatTags = $('#formatTags');

  const progressContainer = $('#progressContainer');
  const progressLabel = $('#progressLabel');
  const progressBar = $('#progressBar');

  const outputSection = $('#outputSection');
  const outputBadge = $('#outputBadge');
  const messageCount = $('#messageCount');
  const previewArea = $('#previewArea');
  const btnCopy = $('#btnCopy');
  const btnDownload = $('#btnDownload');

  const chunkNav = $('#chunkNav');
  const chunkInfo = $('#chunkInfo');
  const btnPrevChunk = $('#btnPrevChunk');
  const btnNextChunk = $('#btnNextChunk');

  const sourceInfo = $('#sourceInfo');
  const sourceValue = $('#sourceValue');

  const historyToggle = $('#historyToggle');
  const historyPanel = $('#historyPanel');
  const historyList = $('#historyList');
  const btnClearHistory = $('#btnClearHistory');
  const actionCards = $('#actionCards');
  const tipBar = $('#tipBar');

  const toast = $('#toast');
  const toastIcon = $('#toastIcon');
  const toastMessage = $('#toastMessage');

  // State
  let currentToonChunks = [];
  let currentChunkIndex = 0;
  let currentTabId = null;
  let currentSite = null;
  let currentFormat = 'auto';
  let lastRawText = '';
  let showingHistory = false;

  // ─── Initialize ─────────────────────────────────────

  async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab?.id;
    const url = tab?.url || '';
    const hostname = new URL(url).hostname || '';

    // Detect site type
    if (url.includes('chat.openai.com') || url.includes('chatgpt.com')) {
      currentSite = 'chatgpt';
      siteIndicator.textContent = `ChatGPT · ${hostname}`;
      setStatus('ready', 'Connected to ChatGPT');
      btnExportFull.classList.remove('hidden');
      fullExportDesc.textContent = 'Auto-scroll & extract full ChatGPT conversation';
      extractPageTitle.textContent = 'Extract Page Content';
    } else if (url.includes('claude.ai')) {
      currentSite = 'claude';
      siteIndicator.textContent = `Claude · ${hostname}`;
      setStatus('ready', 'Connected to Claude');
      btnExportFull.classList.remove('hidden');
      fullExportDesc.textContent = 'Auto-scroll & extract full Claude conversation';
      extractPageTitle.textContent = 'Extract Page Content';
    } else if (url.startsWith('chrome://') || url.startsWith('about:') || url.startsWith('edge://')) {
      currentSite = 'system';
      siteIndicator.textContent = 'System page';
      setStatus('error', 'Cannot run on system pages');
      btnConvertSelection.disabled = true;
      btnExtractPage.disabled = true;
    } else {
      currentSite = 'generic';
      siteIndicator.textContent = hostname || 'Unknown page';
      setStatus('ready', `Ready on ${hostname}`);
      extractPageTitle.textContent = 'Extract Page Content';
      extractPageDesc.textContent = `Extract article/main content from this page`;
    }

    // Check for pending context menu selection
    await checkPendingSelection();

    // Bind events
    btnConvertSelection.addEventListener('click', handleConvertSelection);
    btnExtractPage.addEventListener('click', handleExtractPage);
    btnExportFull.addEventListener('click', handleExportFull);
    btnCopy.addEventListener('click', handleCopy);
    btnDownload.addEventListener('click', handleDownload);
    btnPrevChunk.addEventListener('click', () => navigateChunk(-1));
    btnNextChunk.addEventListener('click', () => navigateChunk(1));
    historyToggle.addEventListener('click', toggleHistory);
    btnClearHistory.addEventListener('click', handleClearHistory);

    // Format tag clicks
    formatTags.querySelectorAll('.format-tag').forEach(tag => {
      tag.addEventListener('click', () => {
        formatTags.querySelectorAll('.format-tag').forEach(t => t.classList.remove('active'));
        tag.classList.add('active');
        currentFormat = tag.dataset.format;
        if (lastRawText) reconvert(lastRawText);
      });
    });
  }

  // ─── Check Pending Selection (from context menu) ───

  async function checkPendingSelection() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getPendingSelection' });
      if (response?.pending) {
        const pending = response.pending;
        // Only use if recent (within last 30 seconds)
        if (Date.now() - pending.timestamp < 30000) {
          processSelection(pending.text, {
            title: pending.title,
            url: pending.url,
            hostname: new URL(pending.url || '').hostname || ''
          });
        }
      }
    } catch (e) {
      // Ignore
    }
  }

  // ─── Status ─────────────────────────────────────────

  function setStatus(type, text) {
    statusDot.className = 'status-dot';
    if (type === 'error') statusDot.classList.add('error');
    if (type === 'working') statusDot.classList.add('working');
    statusText.textContent = text;
  }

  function showToast(message, type = 'success') {
    toastMessage.textContent = message;
    toastIcon.textContent = type === 'success' ? '✓' : '✕';
    toast.className = `toast show ${type}`;
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.classList.add('hidden'), 300);
    }, 2200);
  }

  // ─── Convert Selection ──────────────────────────────

  async function handleConvertSelection() {
    if (!currentTabId || currentSite === 'system') return;

    setButtons(true);
    setStatus('working', 'Capturing selection...');

    try {
      const response = await sendToContentScript({ action: 'extractSelection' });

      if (response.error) {
        setStatus('error', response.error);
        showToast(response.error, 'error');
        return;
      }

      const text = response.text || response.plainText || '';
      const context = response.context || {};

      processSelection(text, context);

    } catch (err) {
      setStatus('error', 'Capture failed');
      showToast(err.message, 'error');
    } finally {
      setButtons(false);
    }
  }

  function processSelection(text, context = {}) {
    lastRawText = text;

    // Detect structure
    const detected = ToonConverter.detectStructure(text);
    updateFormatIndicator(detected.type);

    // Convert
    const toon = currentFormat === 'auto'
      ? ToonConverter.selectionToToon(text)
      : convertWithFormat(text, currentFormat);

    currentToonChunks = [toon];
    currentChunkIndex = 0;

    // Show output
    displayOutput('selection', context);

    // Save
    saveToHistory('selection', toon, 0, context);

    setStatus('ready', 'Selection converted');
    showToast('Converted to TOON');
  }

  function convertWithFormat(text, format) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    switch (format) {
      case 'block':
        return ToonConverter.contentBlockToToon(text);
      case 'list':
        return ToonConverter.listToToon(lines);
      case 'kv': {
        const data = lines.map(l => {
          const match = l.match(/^(.+?)[:=]\s*(.+)/);
          return match ? { key: match[1].trim(), value: match[2].trim() } : { key: l, value: '' };
        });
        return ToonConverter.keyValueToToon(data);
      }
      default:
        return ToonConverter.selectionToToon(text);
    }
  }

  function reconvert(text) {
    const toon = currentFormat === 'auto'
      ? ToonConverter.selectionToToon(text)
      : convertWithFormat(text, currentFormat);
    currentToonChunks = [toon];
    currentChunkIndex = 0;
    previewArea.textContent = toon;
  }

  function updateFormatIndicator(type) {
    formatOptions.classList.remove('hidden');

    // Highlight detected format
    const label = formatOptions.querySelector('.format-label');
    const typeNames = {
      'key-value': 'Key-Value',
      'list': 'List',
      'paragraphs': 'Paragraphs',
      'chat': 'Chat',
      'raw': 'Raw text'
    };
    label.textContent = `Detected: ${typeNames[type] || type}`;
  }

  // ─── Extract Page Content ───────────────────────────

  async function handleExtractPage() {
    if (!currentTabId || currentSite === 'system') return;

    setButtons(true);
    setStatus('working', 'Extracting page content...');
    progressContainer.classList.remove('hidden');
    progressBar.classList.add('indeterminate');
    progressLabel.textContent = 'Analyzing page structure...';

    try {
      const response = await sendToContentScript({ action: 'extractFull' });

      progressBar.classList.remove('indeterminate');

      if (response.error) {
        setStatus('error', response.error);
        progressContainer.classList.add('hidden');
        showToast(response.error, 'error');
        return;
      }

      const context = response.context || {};

      if (response.mode === 'article' && response.text) {
        // Generic site — article extraction
        const toon = ToonConverter.selectionToToon(response.text);
        currentToonChunks = [toon];
        currentChunkIndex = 0;

        progressBar.style.width = '100%';
        progressLabel.textContent = 'Done!';
        setTimeout(() => progressContainer.classList.add('hidden'), 500);

        displayOutput('page', context);
        saveToHistory('page', toon, 0, context);

        setStatus('ready', 'Page content extracted');
        showToast('Page content extracted to TOON');
      } else {
        // Should not happen — full chat handled by btnExportFull
        progressContainer.classList.add('hidden');
        setStatus('error', 'Unexpected response');
      }

    } catch (err) {
      setStatus('error', 'Extraction failed');
      progressContainer.classList.add('hidden');
      showToast(err.message, 'error');
    } finally {
      setButtons(false);
    }
  }

  // ─── Export Full Chat (ChatGPT / Claude) ────────────

  async function handleExportFull() {
    if (!currentTabId || (currentSite !== 'chatgpt' && currentSite !== 'claude')) return;

    setButtons(true);
    setStatus('working', 'Scrolling and extracting...');
    progressContainer.classList.remove('hidden');
    progressBar.classList.add('indeterminate');
    progressLabel.textContent = 'Auto-scrolling to load all messages...';

    try {
      const response = await sendToContentScript({ action: 'extractFull' });
      progressBar.classList.remove('indeterminate');

      if (response.error) {
        setStatus('error', response.error);
        progressContainer.classList.add('hidden');
        showToast(response.error, 'error');
        return;
      }

      if (!response.messages || response.messages.length === 0) {
        setStatus('error', 'No messages found');
        progressContainer.classList.add('hidden');
        showToast('No messages found', 'error');
        return;
      }

      progressLabel.textContent = `Processing ${response.messages.length} messages...`;
      progressBar.style.width = '80%';

      const messages = response.messages;
      if (ToonConverter.needsChunking(messages)) {
        currentToonChunks = ToonConverter.chatToToonChunked(messages);
      } else {
        currentToonChunks = [ToonConverter.chatToToon(messages)];
      }
      currentChunkIndex = 0;

      progressBar.style.width = '100%';
      progressLabel.textContent = 'Done!';
      setTimeout(() => progressContainer.classList.add('hidden'), 500);

      const context = response.context || {};
      displayOutput('full', context, messages.length);

      const fullToon = currentToonChunks.join('\n\n---\n\n');
      saveToHistory('full', fullToon, messages.length, context);

      setStatus('ready', `Exported ${messages.length} messages`);
      showToast(`Exported ${messages.length} messages to TOON`);

    } catch (err) {
      setStatus('error', 'Export failed');
      progressContainer.classList.add('hidden');
      showToast(err.message, 'error');
    } finally {
      setButtons(false);
    }
  }

  // ─── Display Output ─────────────────────────────────

  function displayOutput(mode, context = {}, count = 0) {
    if (showingHistory) {
      historyPanel.classList.add('hidden');
      actionCards.classList.remove('hidden');
      tipBar.classList.remove('hidden');
      showingHistory = false;
      historyToggle.classList.remove('active');
    }

    outputSection.classList.remove('hidden');

    // Badge
    const badges = { full: 'CHAT', selection: 'SEL', page: 'PAGE' };
    outputBadge.textContent = badges[mode] || 'TOON';

    // Count
    if (count > 0) {
      messageCount.textContent = `(${count} message${count !== 1 ? 's' : ''})`;
    } else {
      messageCount.textContent = '';
    }

    // Source
    if (context.hostname || context.title) {
      sourceInfo.classList.remove('hidden');
      sourceValue.textContent = context.title || context.hostname || '';
    } else {
      sourceInfo.classList.add('hidden');
    }

    // Chunks
    if (currentToonChunks.length > 1) {
      chunkNav.classList.remove('hidden');
      updateChunkNav();
    } else {
      chunkNav.classList.add('hidden');
    }

    previewArea.textContent = currentToonChunks[currentChunkIndex];
  }

  // ─── Chunk Navigation ──────────────────────────────

  function navigateChunk(dir) {
    const idx = currentChunkIndex + dir;
    if (idx < 0 || idx >= currentToonChunks.length) return;
    currentChunkIndex = idx;
    previewArea.textContent = currentToonChunks[idx];
    updateChunkNav();
  }

  function updateChunkNav() {
    chunkInfo.textContent = `Chunk ${currentChunkIndex + 1}/${currentToonChunks.length}`;
    btnPrevChunk.disabled = currentChunkIndex === 0;
    btnNextChunk.disabled = currentChunkIndex === currentToonChunks.length - 1;
  }

  // ─── Copy & Download ───────────────────────────────

  async function handleCopy() {
    const text = currentToonChunks.length > 1
      ? currentToonChunks.join('\n\n---\n\n')
      : currentToonChunks[0];
    try {
      await navigator.clipboard.writeText(text);
      btnCopy.classList.add('btn-success');
      showToast('Copied to clipboard!');
      setTimeout(() => btnCopy.classList.remove('btn-success'), 1500);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Copied to clipboard!');
    }
  }

  function handleDownload() {
    const text = currentToonChunks.length > 1
      ? currentToonChunks.join('\n\n---\n\n')
      : currentToonChunks[0];
    const blob = new Blob([text], { type: 'text/toon;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const a = document.createElement('a');
    a.href = url;
    a.download = `export-${ts}.toon`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Downloaded export-${ts}.toon`);
  }

  // ─── History ────────────────────────────────────────

  function toggleHistory() {
    showingHistory = !showingHistory;
    historyToggle.classList.toggle('active', showingHistory);

    if (showingHistory) {
      historyPanel.classList.remove('hidden');
      actionCards.classList.add('hidden');
      tipBar.classList.add('hidden');
      outputSection.classList.add('hidden');
      formatOptions.classList.add('hidden');
      loadHistory();
    } else {
      historyPanel.classList.add('hidden');
      actionCards.classList.remove('hidden');
      tipBar.classList.remove('hidden');
    }
  }

  async function loadHistory() {
    try {
      const result = await chrome.storage.local.get('toon_export_history');
      const history = result.toon_export_history || [];

      if (history.length === 0) {
        historyList.innerHTML = `<div class="history-empty"><span class="empty-icon">📭</span><p>No exports yet</p></div>`;
        return;
      }

      historyList.innerHTML = history.map(item => {
        const time = formatTime(item.timestamp);
        const modeClass = item.mode || 'selection';
        const preview = (item.preview || item.toonOutput || '').substring(0, 60).replace(/</g, '&lt;');
        const source = item.source || '';

        return `
          <div class="history-item" data-id="${item.id}">
            <span class="history-mode ${modeClass}">${item.mode || 'sel'}</span>
            <div class="history-info">
              <div class="history-preview">${preview}…</div>
              <div class="history-meta">${time}${item.messageCount ? ` · ${item.messageCount} msgs` : ''}</div>
              ${source ? `<div class="history-source">${source.replace(/</g, '&lt;')}</div>` : ''}
            </div>
            <div class="history-actions">
              <button class="icon-btn history-copy-btn" title="Copy" data-id="${item.id}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              </button>
              <button class="icon-btn history-delete-btn" title="Delete" data-id="${item.id}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>
        `;
      }).join('');

      // Bind events
      historyList.querySelectorAll('.history-item').forEach(el => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('.history-actions')) return;
          handleHistoryView(el.dataset.id);
        });
      });
      historyList.querySelectorAll('.history-copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); handleHistoryCopy(btn.dataset.id); });
      });
      historyList.querySelectorAll('.history-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); handleHistoryDelete(btn.dataset.id); });
      });
    } catch (err) {
      console.error('[TOON Popup] History error:', err);
    }
  }

  async function handleHistoryView(id) {
    const result = await chrome.storage.local.get('toon_export_history');
    const item = (result.toon_export_history || []).find(h => h.id === id);
    if (!item) return;

    currentToonChunks = [item.toonOutput];
    currentChunkIndex = 0;
    showingHistory = false;
    historyToggle.classList.remove('active');
    historyPanel.classList.add('hidden');
    actionCards.classList.remove('hidden');
    tipBar.classList.remove('hidden');

    displayOutput(item.mode, { hostname: item.source }, item.messageCount || 0);
  }

  async function handleHistoryCopy(id) {
    const result = await chrome.storage.local.get('toon_export_history');
    const item = (result.toon_export_history || []).find(h => h.id === id);
    if (!item) return;
    try {
      await navigator.clipboard.writeText(item.toonOutput);
      showToast('Copied!');
    } catch { showToast('Copy failed', 'error'); }
  }

  async function handleHistoryDelete(id) {
    const result = await chrome.storage.local.get('toon_export_history');
    const filtered = (result.toon_export_history || []).filter(h => h.id !== id);
    await chrome.storage.local.set({ toon_export_history: filtered });
    loadHistory();
    showToast('Deleted');
  }

  async function handleClearHistory() {
    if (!confirm('Clear all export history?')) return;
    await chrome.storage.local.set({ toon_export_history: [] });
    loadHistory();
    showToast('History cleared');
  }

  async function saveToHistory(mode, toonOutput, messageCount, context = {}) {
    try {
      const record = {
        id: `toon_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        timestamp: Date.now(),
        mode,
        toonOutput,
        messageCount,
        preview: toonOutput.substring(0, 200),
        source: context.hostname || context.title || ''
      };
      const result = await chrome.storage.local.get('toon_export_history');
      const history = result.toon_export_history || [];
      history.unshift(record);
      await chrome.storage.local.set({ toon_export_history: history.slice(0, 50) });
    } catch (err) {
      console.error('[TOON] Save error:', err);
    }
  }

  // ─── Helpers ────────────────────────────────────────

  function setButtons(disabled) {
    btnConvertSelection.disabled = disabled;
    btnExtractPage.disabled = disabled;
    btnExportFull.disabled = disabled;
  }

  function sendToContentScript(message) {
    return new Promise((resolve, reject) => {
      if (!currentTabId) return reject(new Error('No active tab'));

      chrome.tabs.sendMessage(currentTabId, message, (response) => {
        if (chrome.runtime.lastError) {
          chrome.scripting.executeScript({
            target: { tabId: currentTabId },
            files: ['content.js']
          }).then(() => {
            setTimeout(() => {
              chrome.tabs.sendMessage(currentTabId, message, (retry) => {
                if (chrome.runtime.lastError) {
                  reject(new Error('Could not connect. Please refresh the page.'));
                } else {
                  resolve(retry);
                }
              });
            }, 300);
          }).catch(() => reject(new Error('Cannot access this page.')));
        } else {
          resolve(response);
        }
      });
    });
  }

  function formatTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
