/**
 * TOON Converter Module v2
 * Converts various content types to TOON (Token-Oriented Object Notation) format.
 *
 * Supports:
 *   - Chat messages: conversations[N]{role,content}:
 *   - Generic content: content[N]{type,text}:
 *   - Key-value data: data[N]{key,value}:
 *   - List items: items[N]{item}:
 *   - Structured selections with auto-detection
 */

const ToonConverter = (() => {
  'use strict';

  const DEFAULT_CHUNK_SIZE = 50;
  const DEFAULT_MAX_CHARS_PER_CHUNK = 32000;

  // ─── Value Escaping (CSV-like rules) ────────────────

  /**
   * Escape a value for TOON tabular format.
   * - If value contains comma, newline, or double-quote → wrap in double quotes
   * - Double quotes inside are escaped by doubling them
   */
  function escapeValue(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str === '') return '""';
    if (str.includes(',') || str.includes('\n') || str.includes('\r') || str.includes('"')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  // ─── Chat Conversations ─────────────────────────────

  /**
   * Convert chat messages [{role, content}] to TOON format.
   */
  function chatToToon(messages) {
    if (!messages || messages.length === 0) {
      return 'conversations[0]{role,content}:';
    }
    const lines = [`conversations[${messages.length}]{role,content}:`];
    for (const msg of messages) {
      lines.push(`  ${escapeValue(msg.role || 'user')},${escapeValue(msg.content || '')}`);
    }
    return lines.join('\n');
  }

  /**
   * Chunk chat messages into multiple valid TOON documents.
   */
  function chatToToonChunked(messages, options = {}) {
    const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
    const maxChars = options.maxCharsPerChunk || DEFAULT_MAX_CHARS_PER_CHUNK;

    if (!messages || messages.length === 0) return [chatToToon([])];

    const prelimChunks = [];
    for (let i = 0; i < messages.length; i += chunkSize) {
      prelimChunks.push(messages.slice(i, i + chunkSize));
    }

    const finalChunks = [];
    for (const chunk of prelimChunks) {
      const toon = chatToToon(chunk);
      if (toon.length <= maxChars) {
        finalChunks.push(toon);
      } else {
        const subChunks = splitBySize(chunk, maxChars, chatToToon);
        for (const sub of subChunks) finalChunks.push(chatToToon(sub));
      }
    }
    return finalChunks;
  }

  // ─── Generic Content (Selection-based) ──────────────

  /**
   * Convert a text selection into TOON format.
   * Auto-detects structure: paragraphs, lists, key-value pairs, or raw block.
   */
  function selectionToToon(text, options = {}) {
    if (!text || text.trim().length === 0) {
      return 'content[0]{type,text}:';
    }

    const normalized = normalizeWhitespace(text);
    const structure = detectStructure(normalized);

    switch (structure.type) {
      case 'key-value':
        return keyValueToToon(structure.data);
      case 'list':
        return listToToon(structure.data);
      case 'paragraphs':
        return paragraphsToToon(structure.data);
      case 'chat':
        return chatToToon(structure.data);
      default:
        return contentBlockToToon(normalized);
    }
  }

  /**
   * Force-convert text as a single content block (no auto-detection).
   */
  function contentBlockToToon(text) {
    const normalized = normalizeWhitespace(text);
    return `content[1]{type,text}:\n  block,${escapeValue(normalized)}`;
  }

  /**
   * Convert a structured content object directly to TOON.
   * Accepts: { title, paragraphs[], metadata{} }
   */
  function structuredToToon(data) {
    if (!data) return 'content[0]{type,text}:';

    const lines = [];

    // Top-level metadata
    if (data.title) {
      lines.push(`title: ${escapeValue(data.title)}`);
    }
    if (data.source) {
      lines.push(`source: ${escapeValue(data.source)}`);
    }

    // Paragraphs as tabular content
    if (data.paragraphs && data.paragraphs.length > 0) {
      lines.push(`content[${data.paragraphs.length}]{type,text}:`);
      for (const p of data.paragraphs) {
        const type = p.type || 'paragraph';
        lines.push(`  ${escapeValue(type)},${escapeValue(p.text || '')}`);
      }
    }

    // Key-value metadata
    if (data.metadata && Object.keys(data.metadata).length > 0) {
      const entries = Object.entries(data.metadata);
      lines.push(`metadata[${entries.length}]{key,value}:`);
      for (const [key, value] of entries) {
        lines.push(`  ${escapeValue(key)},${escapeValue(String(value))}`);
      }
    }

    return lines.join('\n') || 'content[0]{type,text}:';
  }

  // ─── Structure Detection ────────────────────────────

  /**
   * Auto-detect the structure of selected text.
   * Returns { type, data } where type is one of:
   *   'key-value', 'list', 'paragraphs', 'chat', 'raw'
   */
  function detectStructure(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    if (lines.length === 0) return { type: 'raw', data: text };

    // Check for chat-like pattern (Name: message or Role: message)
    const chatPattern = /^(user|assistant|human|ai|system|me|you|bot)\s*[:：]\s*/i;
    const chatLines = lines.filter(l => chatPattern.test(l));
    if (chatLines.length >= 2 && chatLines.length / lines.length > 0.5) {
      const messages = [];
      for (const line of lines) {
        const match = line.match(/^(user|assistant|human|ai|system|me|you|bot)\s*[:：]\s*(.*)/i);
        if (match) {
          const rawRole = match[1].toLowerCase();
          const role = (rawRole === 'human' || rawRole === 'me' || rawRole === 'user')
            ? 'user'
            : 'assistant';
          messages.push({ role, content: match[2] });
        } else if (messages.length > 0) {
          // Continuation of previous message
          messages[messages.length - 1].content += '\n' + line;
        }
      }
      if (messages.length >= 2) return { type: 'chat', data: messages };
    }

    // Check for key-value pattern (key: value or key = value)
    const kvPattern = /^[^:=]{1,50}\s*[:=]\s*.+/;
    const kvLines = lines.filter(l => kvPattern.test(l) && !l.startsWith('http'));
    if (kvLines.length >= 2 && kvLines.length / lines.length > 0.6) {
      const data = [];
      for (const line of lines) {
        const match = line.match(/^([^:=]{1,50})\s*[:=]\s*(.+)/);
        if (match) {
          data.push({ key: match[1].trim(), value: match[2].trim() });
        }
      }
      if (data.length >= 2) return { type: 'key-value', data };
    }

    // Check for list pattern (- item, * item, • item, 1. item)
    const listPattern = /^[-*•]\s+|^\d+[.)]\s+/;
    const listLines = lines.filter(l => listPattern.test(l));
    if (listLines.length >= 2 && listLines.length / lines.length > 0.5) {
      const data = lines
        .filter(l => listPattern.test(l))
        .map(l => l.replace(listPattern, '').trim());
      return { type: 'list', data };
    }

    // Default to paragraphs if multiple lines, raw if single
    if (lines.length >= 2) {
      // Re-split by double-newline for proper paragraphs
      const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
      if (paragraphs.length >= 2) {
        return {
          type: 'paragraphs',
          data: paragraphs.map(p => ({ type: 'paragraph', text: p }))
        };
      }
    }

    return { type: 'raw', data: text };
  }

  // ─── Format Converters ──────────────────────────────

  function keyValueToToon(data) {
    if (!data || data.length === 0) return 'data[0]{key,value}:';
    const lines = [`data[${data.length}]{key,value}:`];
    for (const item of data) {
      lines.push(`  ${escapeValue(item.key)},${escapeValue(item.value)}`);
    }
    return lines.join('\n');
  }

  function listToToon(data) {
    if (!data || data.length === 0) return 'items[0]{item}:';
    const lines = [`items[${data.length}]{item}:`];
    for (const item of data) {
      lines.push(`  ${escapeValue(item)}`);
    }
    return lines.join('\n');
  }

  function paragraphsToToon(data) {
    if (!data || data.length === 0) return 'content[0]{type,text}:';
    const lines = [`content[${data.length}]{type,text}:`];
    for (const p of data) {
      lines.push(`  ${escapeValue(p.type || 'paragraph')},${escapeValue(p.text || '')}`);
    }
    return lines.join('\n');
  }

  // ─── Chunking Helpers ──────────────────────────────

  function splitBySize(items, maxChars, converter) {
    const result = [];
    let current = [];
    for (const item of items) {
      current.push(item);
      if (converter(current).length > maxChars && current.length > 1) {
        current.pop();
        result.push(current);
        current = [item];
      }
    }
    if (current.length > 0) result.push(current);
    return result;
  }

  function needsChunking(messages, options = {}) {
    const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
    const maxChars = options.maxCharsPerChunk || DEFAULT_MAX_CHARS_PER_CHUNK;
    if (messages.length > chunkSize) return true;
    const totalChars = messages.reduce((sum, m) => sum + (m.content || '').length, 0);
    return totalChars > maxChars;
  }

  // ─── Whitespace Normalization ──────────────────────

  function normalizeWhitespace(text) {
    return text
      .replace(/\t/g, '  ')
      .replace(/[ ]{3,}/g, '  ')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  // ─── Public API ────────────────────────────────────

  return {
    // Chat-specific
    chatToToon,
    chatToToonChunked,
    needsChunking,

    // Universal (any website)
    selectionToToon,
    contentBlockToToon,
    structuredToToon,
    detectStructure,

    // Format converters
    keyValueToToon,
    listToToon,
    paragraphsToToon,

    // Utilities
    escapeValue,
    normalizeWhitespace,

    // Legacy aliases
    toToon: chatToToon,
    toToonChunked: chatToToonChunked,

    DEFAULT_CHUNK_SIZE,
    DEFAULT_MAX_CHARS_PER_CHUNK
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ToonConverter;
}
