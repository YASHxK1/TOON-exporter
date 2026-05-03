/**
 * Storage Manager Module
 * Handles persistent export history using chrome.storage.local.
 *
 * Each export record:
 *   { id, timestamp, mode, toonOutput, messageCount, preview }
 */

const StorageManager = (() => {
  'use strict';

  const STORAGE_KEY = 'toon_export_history';
  const MAX_HISTORY_ITEMS = 50;
  const MAX_PREVIEW_LENGTH = 200;

  /**
   * Get all export history items, sorted by most recent first.
   */
  async function getHistory() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const history = result[STORAGE_KEY] || [];
      return history.sort((a, b) => b.timestamp - a.timestamp);
    } catch (err) {
      console.error('[TOON Storage] Error getting history:', err);
      return [];
    }
  }

  /**
   * Save a new export to history.
   * @param {string} mode - 'full' or 'selection'
   * @param {string} toonOutput - The TOON formatted output
   * @param {number} messageCount - Number of messages exported
   */
  async function saveExport(mode, toonOutput, messageCount = 0) {
    try {
      const history = await getHistory();

      const record = {
        id: generateId(),
        timestamp: Date.now(),
        mode: mode,
        toonOutput: toonOutput,
        messageCount: messageCount,
        preview: toonOutput.substring(0, MAX_PREVIEW_LENGTH)
      };

      history.unshift(record);

      // Trim to max history size
      const trimmed = history.slice(0, MAX_HISTORY_ITEMS);

      await chrome.storage.local.set({ [STORAGE_KEY]: trimmed });
      return record;
    } catch (err) {
      console.error('[TOON Storage] Error saving export:', err);
      throw err;
    }
  }

  /**
   * Get a single export by ID.
   */
  async function getExport(id) {
    const history = await getHistory();
    return history.find(item => item.id === id) || null;
  }

  /**
   * Delete an export by ID.
   */
  async function deleteExport(id) {
    try {
      const history = await getHistory();
      const filtered = history.filter(item => item.id !== id);
      await chrome.storage.local.set({ [STORAGE_KEY]: filtered });
    } catch (err) {
      console.error('[TOON Storage] Error deleting export:', err);
      throw err;
    }
  }

  /**
   * Clear all export history.
   */
  async function clearHistory() {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: [] });
    } catch (err) {
      console.error('[TOON Storage] Error clearing history:', err);
      throw err;
    }
  }

  /**
   * Generate a unique ID for an export record.
   */
  function generateId() {
    return `toon_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Format a timestamp for display.
   */
  function formatTimestamp(ts) {
    const date = new Date(ts);
    const now = new Date();
    const diff = now - date;

    // Less than 1 minute
    if (diff < 60000) return 'Just now';
    // Less than 1 hour
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    // Less than 24 hours
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    // Less than 7 days
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
    });
  }

  return {
    getHistory,
    saveExport,
    getExport,
    deleteExport,
    clearHistory,
    formatTimestamp
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = StorageManager;
}
