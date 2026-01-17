#!/usr/bin/env node
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORTS = [9000, 9001, 9002, 9003];
const DISCOVERY_INTERVAL = 10000;
const POLL_INTERVAL = 3000;

// Application State
let cascades = new Map(); // Map<cascadeId, { id, cdp: { ws, contexts, rootContextId }, metadata, snapshot, snapshotHash }>
let wss = null;

// --- Helpers ---

// Simple hash function
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

// HTTP GET JSON
function getJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve([]); } // return empty on parse error
            });
        });
        req.on('error', () => resolve([])); // return empty on network error
        req.setTimeout(2000, () => {
            req.destroy();
            resolve([]);
        });
    });
}

// --- CDP Logic ---

async function connectCDP(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        const handler = (msg) => {
            const data = JSON.parse(msg);
            if (data.id === id) {
                ws.off('message', handler);
                if (data.error) reject(data.error);
                else resolve(data.result);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });

    const contexts = [];
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            } else if (data.method === 'Runtime.executionContextDestroyed') {
                const idx = contexts.findIndex(c => c.id === data.params.executionContextId);
                if (idx !== -1) contexts.splice(idx, 1);
            }
        } catch (e) { }
    });

    await call("Runtime.enable", {});
    await new Promise(r => setTimeout(r, 500)); // give time for contexts to load

    return { ws, call, contexts, rootContextId: null };
}

async function extractMetadata(cdp) {
    const SCRIPT = `(() => {
        const normalizeText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const isGoodTitle = (value) => {
            const text = normalizeText(value);
            if (text.length < 3 || text.length > 80) return false;
            const bad = [
                /^new chat/i,
                /^new conversation/i,
                /^past chats?/i,
                /^view all/i,
                /^plan/i,
                /^local$/i,
                /^run everything/i,
                /^success$/i
            ];
            return !bad.some((re) => re.test(text));
        };
        const getExplicitCursorTitle = () => {
            const auxBar = document.getElementById('workbench.parts.auxiliarybar') || document.getElementById('workbench.parts.sidebar');
            const root = auxBar || document;
            const activeTab = root.querySelector(
                '.composite-bar .action-item.checked,' +
                '.composite-bar .action-item[aria-selected="true"],' +
                '.composite-bar .action-item[aria-current="true"],' +
                '[role="tab"].checked,' +
                '[role="tab"][aria-selected="true"],' +
                '[role="tab"][aria-current="true"]'
            );
            const label = activeTab?.querySelector('.action-label') || activeTab;
            const text = normalizeText(label?.textContent || '');
            return isGoodTitle(text) ? text : null;
        };
        const getExplicitAntigravityTitle = () => {
            const el = document.querySelector('.text-ide-sidebar-title-color');
            const text = normalizeText(el?.textContent || '');
            return isGoodTitle(text) ? text : null;
        };
        const pickFirstMessage = (root) => {
            if (!root) return null;
            const human =
                root.querySelector('[data-message-role="human"]') ||
                root.querySelector('.composer-human-message') ||
                root.querySelector('[class*="user-message"]') ||
                root.querySelector('[class*="human-message"]');
            if (human) {
                const node = human.querySelector('span[data-lexical-text], p, div') || human;
                const text = normalizeText(node.textContent || node.innerText || '');
                if (isGoodTitle(text)) return text;
            }
            const node = root.querySelector('span[data-lexical-text], .prose p, p, [class*="message"] p, [class*="message"] div');
            if (node) {
                const text = normalizeText(node.textContent || node.innerText || '');
                if (isGoodTitle(text)) return text;
            }
            return null;
        };
        const cascade = document.getElementById('cascade');
        if (cascade) {
            let chatTitle = null;
            const possibleTitleSelectors = ['h1', 'h2', 'header', '[class*="title"]'];
            for (const sel of possibleTitleSelectors) {
                const el = document.querySelector(sel);
                if (el && el.textContent.length > 2 && el.textContent.length < 50) {
                    chatTitle = el.textContent.trim();
                    break;
                }
            }
            const explicitTitle = getExplicitAntigravityTitle();
            const inferred = pickFirstMessage(cascade);

            return {
                found: true,
                app: 'antigravity',
                rootElementId: 'cascade',
                rootSelector: '#cascade',
                chatTitle: explicitTitle || inferred || chatTitle || 'Agent',
                isActive: document.hasFocus()
            };
        }

        const cursorPanel = document.querySelector('[id^="workbench.panel.aichat"]');
        if (cursorPanel) {
            const titleEl = cursorPanel.querySelector('.pane-header .title') || cursorPanel.querySelector('[aria-label*="Chat"]');
            const titleText = titleEl?.textContent?.trim();
            const historyActive = cursorPanel.querySelector('.composer-below-chat-history-item[aria-current="true"], .composer-below-chat-history-item.active, .composer-below-chat-history-item.selected');
            const historyTitle = historyActive?.textContent?.trim();
            const messagesRoot = cursorPanel.querySelector('.composer-messages-container') || cursorPanel;
            const inferredMessage = pickFirstMessage(messagesRoot);
            const explicitTitle = getExplicitCursorTitle();
            const inferredTitle = (explicitTitle || historyTitle || inferredMessage || titleText || '').split('\\n')[0].trim();
            return {
                found: true,
                app: 'cursor',
                rootElementId: cursorPanel.id || null,
                rootSelector: '[id^="workbench.panel.aichat"]',
                chatTitle: inferredTitle && inferredTitle.length > 1 ? inferredTitle : 'Cursor Chat',
                isActive: document.hasFocus()
            };
        }

        return { found: false };
    })()`;

    // Try finding context first if not known
    if (cdp.rootContextId) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: SCRIPT, returnByValue: true, contextId: cdp.rootContextId });
            if (res.result?.value?.found) return { ...res.result.value, contextId: cdp.rootContextId };
        } catch (e) { cdp.rootContextId = null; } // reset if stale
    }

    // Search all contexts
    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", { expression: SCRIPT, returnByValue: true, contextId: ctx.id });
            if (result.result?.value?.found) {
                return { ...result.result.value, contextId: ctx.id };
            }
        } catch (e) { }
    }
    return null;
}

async function captureCSS(cdp, options = {}) {
    const { scopeSelector = '#cascade', scopeAll = false } = options;
    const SCRIPT = `(() => {
        // Gather CSS and namespace it to prevent leaks
        const scope = ${JSON.stringify(scopeSelector)};
        const scopeAll = ${JSON.stringify(scopeAll)};
        const cssParts = [];

        const scopeSelectorText = (selector) => {
            let trimmed = selector.trim();
            if (!trimmed) return trimmed;
            if (trimmed.startsWith(scope)) return trimmed;
            if (trimmed.startsWith('@')) return trimmed;
            const replaced = trimmed
                .replace(/(^|[\\s>+~,(])(:root)(?=[\\s>+~.#:[,{]|$)/gi, '$1' + scope)
                .replace(/(^|[\\s>+~,(])(html|body)(?=[\\s>+~.#:[,{]|$)/gi, '$1' + scope);
            if (replaced !== trimmed) return replaced;
            return scope + ' ' + trimmed;
        };

        const processRule = (rule) => {
            try {
                if (rule.type === CSSRule.STYLE_RULE) {
                    if (!scopeAll) {
                        let text = rule.cssText;
                        text = text.replace(/(^|[\\s,}])body(?=[\\s,{])/gi, '$1' + scope);
                        text = text.replace(/(^|[\\s,}])html(?=[\\s,{])/gi, '$1' + scope);
                        text = text.replace(/(^|[\\s,}])(:root)(?=[\\s,{])/gi, '$1' + scope);
                        return text;
                    }
                    const selectors = rule.selectorText.split(',').map(scopeSelectorText).join(', ');
                    return selectors + ' { ' + rule.style.cssText + ' }';
                }
                if (rule.type === CSSRule.MEDIA_RULE) {
                    const inner = Array.from(rule.cssRules).map(processRule).filter(Boolean).join('\\n');
                    return inner ? '@media ' + rule.conditionText + ' { ' + inner + ' }' : '';
                }
                if (rule.type === CSSRule.SUPPORTS_RULE) {
                    const inner = Array.from(rule.cssRules).map(processRule).filter(Boolean).join('\\n');
                    return inner ? '@supports ' + rule.conditionText + ' { ' + inner + ' }' : '';
                }
                if (rule.type === CSSRule.FONT_FACE_RULE || rule.type === CSSRule.KEYFRAMES_RULE) {
                    return rule.cssText;
                }
                return rule.cssText || '';
            } catch (e) { return ''; }
        };

        for (const sheet of document.styleSheets) {
            try {
                for (const rule of sheet.cssRules) {
                    const text = processRule(rule);
                    if (text) cssParts.push(text);
                }
            } catch (e) { }
        }

        return { css: cssParts.join('\\n') };
    })()`;

    const contextId = cdp.rootContextId;
    if (!contextId) return null;

    try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: SCRIPT,
                returnByValue: true,
                contextId: contextId
            });
        return result.result?.value?.css || '';
    } catch (e) { return ''; }
}

async function captureHTML(cdp, metadata = {}) {
    const { app = 'antigravity', rootElementId = 'cascade', rootSelector = '#cascade' } = metadata;
    const SCRIPT = `(() => {
        const app = ${JSON.stringify(app)};
        const rootElementId = ${JSON.stringify(rootElementId)};
        const rootSelector = ${JSON.stringify(rootSelector)};
        const root = (rootElementId && document.getElementById(rootElementId)) || (rootSelector && document.querySelector(rootSelector));
        if (!root) return { error: 'root not found' };

        const themeRoot = document.querySelector('.monaco-workbench') || document.body || document.documentElement;
        const themeStyles = window.getComputedStyle(themeRoot);
        const bodyStyles = window.getComputedStyle(document.body);
        const normalizeText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const isGoodTitle = (value) => {
            const text = normalizeText(value);
            if (text.length < 3 || text.length > 80) return false;
            const bad = [
                /^new chat/i,
                /^new conversation/i,
                /^past chats?/i,
                /^view all/i,
                /^plan/i,
                /^local$/i,
                /^run everything/i,
                /^success$/i
            ];
            return !bad.some((re) => re.test(text));
        };
        const getExplicitCursorTitle = () => {
            const auxBar = document.getElementById('workbench.parts.auxiliarybar') || document.getElementById('workbench.parts.sidebar');
            const root = auxBar || document;
            const activeTab = root.querySelector(
                '.composite-bar .action-item.checked,' +
                '.composite-bar .action-item[aria-selected="true"],' +
                '.composite-bar .action-item[aria-current="true"],' +
                '[role="tab"].checked,' +
                '[role="tab"][aria-selected="true"],' +
                '[role="tab"][aria-current="true"]'
            );
            const label = activeTab?.querySelector('.action-label') || activeTab;
            const text = normalizeText(label?.textContent || '');
            return isGoodTitle(text) ? text : null;
        };
        const getExplicitAntigravityTitle = () => {
            const el = document.querySelector('.text-ide-sidebar-title-color');
            const text = normalizeText(el?.textContent || '');
            return isGoodTitle(text) ? text : null;
        };
        const pickFirstMessage = (root) => {
            if (!root) return null;
            const human =
                root.querySelector('[data-message-role="human"]') ||
                root.querySelector('.composer-human-message') ||
                root.querySelector('[class*="user-message"]') ||
                root.querySelector('[class*="human-message"]');
            if (human) {
                const node = human.querySelector('span[data-lexical-text], p, div') || human;
                const text = normalizeText(node.textContent || node.innerText || '');
                if (isGoodTitle(text)) return text;
            }
            const node = root.querySelector('span[data-lexical-text], .prose p, p, [class*="message"] p, [class*="message"] div');
            if (node) {
                const text = normalizeText(node.textContent || node.innerText || '');
                if (isGoodTitle(text)) return text;
            }
            return null;
        };

        if (app === 'cursor') {
            const messagesRoot = root.querySelector('.composer-messages-container') || root.querySelector('.conversations') || root;
            const clone = messagesRoot.cloneNode(true);
            clone.querySelectorAll('.composer-input-blur-wrapper, .composer-bar-input-buttons, .composer-find-widget-container').forEach(el => el.remove());

            const cssVars = {};
            for (let i = 0; i < themeStyles.length; i += 1) {
                const name = themeStyles[i];
                if (name && name.startsWith('--')) {
                    cssVars[name] = themeStyles.getPropertyValue(name);
                }
            }

            const msgStyleTarget = messagesRoot.querySelector('.composer-human-message, .composer-ai-message, .composer-rendered-message') || messagesRoot;
            const msgStyles = window.getComputedStyle(msgStyleTarget);

            const wrapper = document.createElement('div');
            wrapper.id = 'cascade';
            wrapper.className = 'cursor-chat';
            const rootClasses = [document.documentElement.className, document.body.className].filter(Boolean).join(' ');
            if (rootClasses) wrapper.className += ' ' + rootClasses;
            wrapper.style.fontFamily = msgStyles.fontFamily || themeStyles.fontFamily || '-apple-system, system-ui, sans-serif';
            wrapper.style.fontSize = msgStyles.fontSize || themeStyles.fontSize || '13px';
            wrapper.style.lineHeight = msgStyles.lineHeight || themeStyles.lineHeight || '1.5';
            wrapper.style.color = msgStyles.color || bodyStyles.color || '#e5e7eb';
            wrapper.style.background = 'transparent';
            wrapper.style.padding = '12px';
            for (const [name, value] of Object.entries(cssVars)) {
                wrapper.style.setProperty(name, value);
            }
            const inner = document.createElement('div');
            if (rootClasses) inner.className = rootClasses;
            inner.appendChild(clone);
            wrapper.appendChild(inner);
            const explicitTitle = getExplicitCursorTitle();
            const inferredTitle = explicitTitle || pickFirstMessage(messagesRoot);

            return {
                html: wrapper.outerHTML,
                bodyBg: themeStyles.backgroundColor || bodyStyles.backgroundColor,
                bodyColor: msgStyles.color || bodyStyles.color,
                title: inferredTitle
            };
        }

        const clone = root.cloneNode(true);
        // Remove input box to keep snapshot clean
        const input = clone.querySelector('[contenteditable="true"]')?.closest('div[id^="cascade"] > div');
        if (input) input.remove();

        let html = clone.outerHTML;
        if (root.id !== 'cascade') {
            const wrapper = document.createElement('div');
            wrapper.id = 'cascade';
            wrapper.appendChild(clone);
            html = wrapper.outerHTML;
        }
        const explicitTitle = getExplicitAntigravityTitle();
        const inferredTitle = explicitTitle || pickFirstMessage(root);

        return {
            html,
            bodyBg: bodyStyles.backgroundColor,
            bodyColor: bodyStyles.color,
            title: inferredTitle
        };
    })()`;

    const contextId = cdp.rootContextId;
    if (!contextId) return null;

    try {
        const result = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: contextId
        });
        if (result.result?.value && !result.result.value.error) {
            return result.result.value;
        }
    } catch (e) { }
    return null;
}

// --- Main App Logic ---

async function discover() {
    // 1. Find all targets
    const allTargets = [];
    await Promise.all(PORTS.map(async (port) => {
        const list = await getJson(`http://127.0.0.1:${port}/json/list`);
        const workbenches = list.filter(t => t.url?.includes('workbench.html') || t.title?.includes('workbench'));
        workbenches.forEach(t => allTargets.push({ ...t, port }));
    }));

    const newCascades = new Map();

    // 2. Connect/Refresh
    for (const target of allTargets) {
        const id = hashString(target.webSocketDebuggerUrl);

        // Reuse existing
        if (cascades.has(id)) {
            const existing = cascades.get(id);
            if (existing.cdp.ws.readyState === WebSocket.OPEN) {
                // Refresh metadata
                const meta = await extractMetadata(existing.cdp);
                if (meta) {
                    const { found, contextId, ...rest } = meta;
                    existing.metadata = { ...existing.metadata, ...rest };
                    if (meta.contextId) existing.cdp.rootContextId = meta.contextId; // Update optimization
                    newCascades.set(id, existing);
                    continue;
                }
            }
        }

        // New connection
        try {
            console.log(`🔌 Connecting to ${target.title}`);
            const cdp = await connectCDP(target.webSocketDebuggerUrl);
            const meta = await extractMetadata(cdp);

            if (meta) {
                if (meta.contextId) cdp.rootContextId = meta.contextId;
                const cascade = {
                    id,
                    cdp,
                    metadata: {
                        windowTitle: target.title,
                        chatTitle: meta.chatTitle,
                        isActive: meta.isActive,
                        app: meta.app,
                        rootElementId: meta.rootElementId,
                        rootSelector: meta.rootSelector
                    },
                    snapshot: null,
                    css: await captureCSS(cdp, { scopeSelector: '#cascade', scopeAll: meta.app === 'cursor' }), //only on init bc its huge
                    snapshotHash: null
                };
                newCascades.set(id, cascade);
                console.log(`✨ Added cascade: ${meta.chatTitle}`);
            } else {
                cdp.ws.close();
            }
        } catch (e) {
            // console.error(`Failed to connect to ${target.title}: ${e.message}`);
        }
    }

    // 3. Cleanup old
    for (const [id, c] of cascades.entries()) {
        if (!newCascades.has(id)) {
            console.log(`👋 Removing cascade: ${c.metadata.chatTitle}`);
            try { c.cdp.ws.close(); } catch (e) { }
        }
    }

    const changed = cascades.size !== newCascades.size; // Simple check, could be more granular
    cascades = newCascades;

    if (changed) broadcastCascadeList();
}

async function updateSnapshots() {
    // Parallel updates
    await Promise.all(Array.from(cascades.values()).map(async (c) => {
        try {
            const snap = await captureHTML(c.cdp, c.metadata); // Only capture HTML
            if (snap) {
                const hash = hashString(snap.html);
                if (hash !== c.snapshotHash) {
                    c.snapshot = snap;
                    c.snapshotHash = hash;
                    if (snap.title && snap.title !== c.metadata.chatTitle) {
                        c.metadata.chatTitle = snap.title;
                        broadcastCascadeList();
                    }
                    broadcast({ type: 'snapshot_update', cascadeId: c.id });
                    // console.log(`📸 Updated ${c.metadata.chatTitle}`);
                }
            }
        } catch (e) { }
    }));
}

function broadcast(msg) {
    if (!wss) return;
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(msg));
    });
}

function broadcastCascadeList() {
    const list = Array.from(cascades.values()).map(c => ({
        id: c.id,
        title: c.metadata.chatTitle,
        window: c.metadata.windowTitle,
        active: c.metadata.isActive
    }));
    broadcast({ type: 'cascade_list', cascades: list });
}

// --- Server Setup ---

async function main() {
    const app = express();
    const server = http.createServer(app);
    wss = new WebSocketServer({ server });

    app.use(express.json());
    app.use(express.static(join(__dirname, 'public')));

    // API Routes
    app.get('/cascades', (req, res) => {
        res.json(Array.from(cascades.values()).map(c => ({
            id: c.id,
            title: c.metadata.chatTitle,
            active: c.metadata.isActive
        })));
    });

    app.get('/snapshot/:id', (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c || !c.snapshot) return res.status(404).json({ error: 'Not found' });
        res.json(c.snapshot);
    });

    app.get('/styles/:id', (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Not found' });
        res.json({ css: c.css || '' });
    });

    // Alias for simple single-view clients (returns first active or first available)
    app.get('/snapshot', (req, res) => {
        const active = Array.from(cascades.values()).find(c => c.metadata.isActive) || cascades.values().next().value;
        if (!active || !active.snapshot) return res.status(503).json({ error: 'No snapshot' });
        res.json(active.snapshot);
    });

    app.post('/send/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        // Re-using the injection logic logic would be long, 
        // but let's assume valid injection for brevity in this single-file request:
        // We'll trust the previous logic worked, just pointing it to c.cdp

        // ... (Injection logic here would be same as before, simplified for brevity of this file edit)
        // For now, let's just log it to prove flow works
        console.log(`Message to ${c.metadata.chatTitle}: ${req.body.message}`);
        // TODO: Port the full injection script back in if needed, 
        // but user asked for "update" which implies features, I'll assume I should include it.
        // See helper below.

        const result = await injectMessage(c.cdp, req.body.message);
        if (result.ok) res.json({ success: true });
        else res.status(500).json(result);
    });


    wss.on('connection', (ws) => {
        broadcastCascadeList(); // Send list on connect
    });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });

    // Start Loops
    discover();
    setInterval(discover, DISCOVERY_INTERVAL);
    setInterval(updateSnapshots, POLL_INTERVAL);
}

// Injection Helper (Moved down to keep main clear)
async function injectMessage(cdp, text) {
    const SCRIPT = `(async () => {
        const value = ${JSON.stringify(text)};
        const cursorPanel = document.querySelector('[id^="workbench.panel.aichat"]');
        const cursorEditor = cursorPanel?.querySelector('.aislash-editor-input') || cursorPanel?.querySelector('[contenteditable="true"][role="textbox"]');
        if (cursorPanel && !cursorEditor) return { ok: false, reason: "cursor editor not found" };
        // Try cursor editor, then contenteditable, then textarea
        const editor = cursorEditor || document.querySelector('#cascade [contenteditable="true"]') || document.querySelector('textarea');
        if (!editor) return { ok: false, reason: "no editor found" };
        
        editor.focus();
        
        if (editor.tagName === 'TEXTAREA') {
            const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
            nativeTextAreaValueSetter.call(editor, value);
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            document.execCommand("selectAll", false, null);
            const ok = document.execCommand("insertText", false, value);
            if (!ok) {
                editor.textContent = value;
                editor.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        
        await new Promise(r => setTimeout(r, 100));
        
        // Try multiple button selectors
        const btn = cursorPanel?.querySelector('.send-with-mode button, .send-with-mode [role="button"], .send-with-mode .anysphere-icon-button') ||
                   document.querySelector('button[class*="arrow"]') || 
                   document.querySelector('button[aria-label*="Send"]') ||
                   document.querySelector('button[type="submit"]') ||
                   document.querySelector('[role="button"][aria-label*="Send"]');

        if (btn) {
            btn.click();
        } else {
             // Fallback to Enter key
             const eventInit = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
             editor.dispatchEvent(new KeyboardEvent("keydown", eventInit));
             editor.dispatchEvent(new KeyboardEvent("keyup", eventInit));
        }
        return { ok: true };
    })()`;

    try {
        const res = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: cdp.rootContextId
        });
        return res.result?.value || { ok: false };
    } catch (e) { return { ok: false, reason: e.message }; }
}

main();
