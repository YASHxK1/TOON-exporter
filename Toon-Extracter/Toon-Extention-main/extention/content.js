/**
 * Content Script v2 – Universal TOON Exporter
 * 
 * Works on ALL websites for selection-based conversion.
 * Enhanced extraction for ChatGPT & Claude (full chat export).
 */

(() => {
  'use strict';

  // ─── Site Detection ─────────────────────────────────

  function detectSite() {
    const host = window.location.hostname;
    if (host.includes('chat.openai.com') || host.includes('chatgpt.com')) return 'chatgpt';
    if (host.includes('claude.ai')) return 'claude';
    return 'generic';
  }

  // ─── Universal Selection ────────────────────────────

  /**
   * Get selected text with rich content awareness.
   * Extracts text preserving markdown-like formatting.
   */
  function getSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return { text: '', html: '', hasSelection: false };
    }

    // Get plain text
    const text = selection.toString().trim();

    // Get HTML for richer extraction
    let html = '';
    try {
      const range = selection.getRangeAt(0);
      const fragment = range.cloneContents();
      const div = document.createElement('div');
      div.appendChild(fragment);
      html = div.innerHTML;
    } catch (e) {
      html = '';
    }

    return { text, html, hasSelection: text.length > 0 };
  }

  /**
   * Extract rich content from HTML selection.
   * Converts HTML to structured text preserving formatting.
   */
  function extractRichContent(html, plainText) {
    if (!html || html.trim().length === 0) return plainText;

    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
    const root = doc.body.firstChild;

    if (!root) return plainText;

    return domToMarkdown(root);
  }

  // ─── DOM to Markdown ───────────────────────────────

  function domToMarkdown(node) {
    let result = '';

    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        result += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();

        switch (tag) {
          case 'pre': {
            const codeEl = child.querySelector('code');
            const lang = codeEl?.className?.match(/language-(\w+)/)?.[1] || '';
            const code = (codeEl || child).textContent;
            result += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
            break;
          }
          case 'code':
            if (!child.closest('pre')) {
              result += `\`${child.textContent}\``;
            } else {
              result += child.textContent;
            }
            break;
          case 'strong': case 'b':
            result += `**${domToMarkdown(child)}**`;
            break;
          case 'em': case 'i':
            result += `*${domToMarkdown(child)}*`;
            break;
          case 'a': {
            const href = child.getAttribute('href') || '';
            const linkText = domToMarkdown(child);
            result += href ? `[${linkText}](${href})` : linkText;
            break;
          }
          case 'br':
            result += '\n';
            break;
          case 'p':
            result += `\n${domToMarkdown(child)}\n`;
            break;
          case 'h1':
            result += `\n# ${domToMarkdown(child)}\n`;
            break;
          case 'h2':
            result += `\n## ${domToMarkdown(child)}\n`;
            break;
          case 'h3':
            result += `\n### ${domToMarkdown(child)}\n`;
            break;
          case 'h4':
            result += `\n#### ${domToMarkdown(child)}\n`;
            break;
          case 'h5':
            result += `\n##### ${domToMarkdown(child)}\n`;
            break;
          case 'h6':
            result += `\n###### ${domToMarkdown(child)}\n`;
            break;
          case 'ul': case 'ol': {
            const items = child.querySelectorAll(':scope > li');
            items.forEach((li, i) => {
              const prefix = tag === 'ol' ? `${i + 1}. ` : '- ';
              result += `\n${prefix}${domToMarkdown(li).trim()}`;
            });
            result += '\n';
            break;
          }
          case 'li':
            result += domToMarkdown(child);
            break;
          case 'blockquote': {
            const bqLines = domToMarkdown(child).trim().split('\n');
            result += '\n' + bqLines.map(l => `> ${l}`).join('\n') + '\n';
            break;
          }
          case 'hr':
            result += '\n---\n';
            break;
          case 'table':
            result += tableToMarkdown(child);
            break;
          case 'img': {
            const alt = child.getAttribute('alt') || 'image';
            const src = child.getAttribute('src') || '';
            result += `![${alt}](${src})`;
            break;
          }
          default:
            result += domToMarkdown(child);
        }
      }
    }

    return result;
  }

  function tableToMarkdown(table) {
    let md = '\n';
    const rows = table.querySelectorAll('tr');
    rows.forEach((row, i) => {
      const cells = row.querySelectorAll('th, td');
      const values = Array.from(cells).map(c => c.textContent.trim());
      md += `| ${values.join(' | ')} |\n`;
      if (i === 0) {
        md += `| ${values.map(() => '---').join(' | ')} |\n`;
      }
    });
    return md;
  }

  // ─── Page Context Info ──────────────────────────────

  function getPageContext() {
    return {
      title: document.title || '',
      url: window.location.href,
      hostname: window.location.hostname,
      site: detectSite()
    };
  }

  // ─── ChatGPT Full Extraction ────────────────────────

  const ChatGPTExtractor = {
    getScrollContainer() {
      return (
        document.querySelector('main .overflow-y-auto') ||
        document.querySelector('[class*="react-scroll-to-bottom"]') ||
        document.querySelector('main div[class*="overflow"]') ||
        document.querySelector('div[role="presentation"] .overflow-y-auto') ||
        document.querySelector('main') ||
        document.documentElement
      );
    },

    extractMessages() {
      const messages = [];

      // Strategy 1: data attributes
      const containers = document.querySelectorAll(
        '[data-message-author-role], article, [data-testid*="conversation-turn"]'
      );
      if (containers.length > 0) {
        for (const c of containers) {
          const msg = this.parseContainer(c);
          if (msg) messages.push(msg);
        }
      }

      // Strategy 2: class-based
      if (messages.length === 0) {
        const groups = document.querySelectorAll(
          '.group\\/conversation-turn, [class*="ConversationItem"], [class*="message"]'
        );
        for (const g of groups) {
          const msg = this.parseGroup(g);
          if (msg) messages.push(msg);
        }
      }

      // Strategy 3: markdown blocks alternating
      if (messages.length === 0) {
        const blocks = document.querySelectorAll('.markdown, .prose, [class*="markdown"]');
        let isUser = true;
        for (const b of blocks) {
          const content = this.cleanEl(b);
          if (content.trim()) {
            messages.push({ role: isUser ? 'user' : 'assistant', content });
            isUser = !isUser;
          }
        }
      }

      return messages;
    },

    parseContainer(el) {
      const role = el.getAttribute('data-message-author-role');
      if (role) {
        const contentEl = el.querySelector('.markdown, .prose, [class*="markdown"], .whitespace-pre-wrap, [data-message-content]');
        const content = this.cleanEl(contentEl || el);
        if (content.trim()) {
          return { role: role === 'user' ? 'user' : 'assistant', content };
        }
      }
      if (el.tagName === 'ARTICLE') {
        const isUser = !!el.querySelector('[data-message-author-role="user"]');
        const contentEl = el.querySelector('.markdown, .prose, .whitespace-pre-wrap');
        if (contentEl) {
          return { role: isUser ? 'user' : 'assistant', content: this.cleanEl(contentEl) };
        }
      }
      return null;
    },

    parseGroup(el) {
      const content = this.cleanEl(el);
      if (!content.trim()) return null;
      const isUser = el.classList.contains('user') ||
                     !!el.querySelector('[data-message-author-role="user"]');
      return { role: isUser ? 'user' : 'assistant', content };
    },

    cleanEl(el) {
      if (!el) return '';
      const clone = el.cloneNode(true);
      // Remove UI artifacts
      const removeSelectors = [
        'button', 'svg', '[role="button"]', '.sr-only', 'nav', 'header', 'footer',
        '[class*="copy"]', '[class*="action"]', '[class*="toolbar"]',
        '[class*="Avatar"]', '[class*="avatar"]', '[class*="btn"]',
        '[class*="feedback"]', '[class*="thumb"]'
      ];
      for (const sel of removeSelectors) {
        clone.querySelectorAll(sel).forEach(n => {
          if (!n.closest('pre') && !n.closest('code')) n.remove();
        });
      }
      return domToMarkdown(clone);
    }
  };

  // ─── Claude Full Extraction ─────────────────────────

  const ClaudeExtractor = {
    getScrollContainer() {
      return (
        document.querySelector('[class*="conversation-content"]') ||
        document.querySelector('[class*="ThreadContent"]') ||
        document.querySelector('[class*="chat-content"]') ||
        document.querySelector('main') ||
        document.querySelector('[role="main"]') ||
        document.documentElement
      );
    },

    extractMessages() {
      const messages = [];

      const containers = document.querySelectorAll(
        '[data-is-streaming], [class*="Message"], [class*="message-row"], [class*="human-message"], [class*="ai-message"]'
      );
      if (containers.length > 0) {
        for (const c of containers) {
          const msg = this.parseMessage(c);
          if (msg) messages.push(msg);
        }
      }

      if (messages.length === 0) {
        const blocks = document.querySelectorAll(
          '[class*="font-claude"], [class*="UserMessage"], [class*="AssistantMessage"], .prose'
        );
        for (const b of blocks) {
          const classList = Array.from(b.classList || []).join(' ').toLowerCase();
          const role = (classList.includes('user') || classList.includes('human')) ? 'user' : 'assistant';
          const content = ChatGPTExtractor.cleanEl(b);
          if (content.trim()) messages.push({ role, content });
        }
      }

      return messages;
    },

    parseMessage(el) {
      const classList = Array.from(el.classList || []).join(' ').toLowerCase();
      let role = 'assistant';
      if (classList.includes('human') || classList.includes('user') ||
          el.querySelector('[class*="human"], [class*="user"]') ||
          el.closest('[class*="human"], [class*="user"]')) {
        role = 'user';
      }
      const content = ChatGPTExtractor.cleanEl(el);
      if (!content.trim()) return null;
      return { role, content };
    }
  };

  // ─── Auto-Scroll ───────────────────────────────────

  async function autoScrollToLoadAll(container) {
    return new Promise((resolve) => {
      let lastHeight = container.scrollHeight;
      let unchangedCount = 0;
      let attempts = 0;
      const maxAttempts = 100;

      const interval = setInterval(() => {
        container.scrollTop = 0;
        attempts++;

        setTimeout(() => {
          const newHeight = container.scrollHeight;
          if (newHeight === lastHeight) unchangedCount++;
          else { unchangedCount = 0; lastHeight = newHeight; }

          if (unchangedCount >= 3 || attempts >= maxAttempts) {
            clearInterval(interval);
            container.scrollTop = container.scrollHeight;
            resolve();
          }
        }, 300);
      }, 500);
    });
  }

  // ─── Message Listener ──────────────────────────────

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const site = detectSite();

    switch (request.action) {
      case 'ping':
        sendResponse({ status: 'ok', site, url: window.location.href });
        return true;

      case 'getPageContext':
        sendResponse(getPageContext());
        return true;

      case 'extractSelection': {
        const sel = getSelection();
        if (!sel.hasSelection) {
          sendResponse({ error: 'No text selected. Highlight some text on the page first.' });
        } else {
          // Extract rich content if HTML is available
          const richText = sel.html ? extractRichContent(sel.html, sel.text) : sel.text;
          sendResponse({
            text: richText || sel.text,
            plainText: sel.text,
            hasHtml: !!sel.html,
            context: getPageContext()
          });
        }
        return true;
      }

      case 'extractFull': {
        if (site === 'chatgpt' || site === 'claude') {
          handleFullChatExtraction(site)
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ error: err.message }));
        } else {
          // On generic sites, extract main article content
          const content = extractArticleContent();
          sendResponse({
            text: content,
            context: getPageContext(),
            mode: 'article'
          });
        }
        return true;
      }
    }
  });

  /**
   * Handle full chat extraction with auto-scroll.
   */
  async function handleFullChatExtraction(site) {
    const extractor = site === 'chatgpt' ? ChatGPTExtractor : ClaudeExtractor;

    try {
      const container = extractor.getScrollContainer();
      await autoScrollToLoadAll(container);
      await new Promise(r => setTimeout(r, 500));

      const messages = extractor.extractMessages();

      if (messages.length === 0) {
        return { error: 'No messages found. The page structure may have changed.' };
      }

      const cleaned = messages.map(m => ({
        role: m.role,
        content: m.content.replace(/\n{3,}/g, '\n\n').trim()
      })).filter(m => m.content.length > 0);

      return { messages: cleaned, site, context: getPageContext() };
    } catch (err) {
      return { error: `Extraction failed: ${err.message}` };
    }
  }

  /**
   * Extract main article/content from a generic webpage.
   */
  function extractArticleContent() {
    // Try semantic elements first
    const candidates = [
      document.querySelector('article'),
      document.querySelector('[role="main"]'),
      document.querySelector('main'),
      document.querySelector('.post-content'),
      document.querySelector('.article-content'),
      document.querySelector('.entry-content'),
      document.querySelector('.content'),
      document.querySelector('#content'),
    ];

    const mainEl = candidates.find(el => el !== null);

    if (mainEl) {
      const clone = mainEl.cloneNode(true);
      // Remove nav, ads, sidebars
      clone.querySelectorAll('nav, aside, footer, header, [class*="sidebar"], [class*="ad"], [class*="comment"], script, style, iframe').forEach(n => n.remove());
      return domToMarkdown(clone);
    }

    // Fallback: get body text
    return document.body.innerText.substring(0, 50000);
  }

  console.log(`[TOON Exporter v2] Loaded on ${detectSite()} — ${window.location.hostname}`);
})();
