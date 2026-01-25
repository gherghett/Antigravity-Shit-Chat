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
        const cascade = document.getElementById('cascade');
        if (!cascade) return { found: false };
        
        let chatTitle = null;
        const possibleTitleSelectors = ['h1', 'h2', 'header', '[class*="title"]'];
        for (const sel of possibleTitleSelectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.length > 2 && el.textContent.length < 50) {
                chatTitle = el.textContent.trim();
                break;
            }
        }
        
        return {
            found: true,
            chatTitle: chatTitle || 'Agent',
            isActive: document.hasFocus()
        };
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

async function captureCSS(cdp) {
    const SCRIPT = `(() => {
        // Gather CSS and namespace it basic way to prevent leaks
        let css = '';
        for (const sheet of document.styleSheets) {
            try { 
                for (const rule of sheet.cssRules) {
                    let text = rule.cssText;
                    // Naive scoping: replace body/html with #cascade locator
                    // This prevents the monitored app's global backgrounds from overriding our monitor's body
                    text = text.replace(/(^|[\\s,}])body(?=[\\s,{])/gi, '$1#cascade');
                    text = text.replace(/(^|[\\s,}])html(?=[\\s,{])/gi, '$1#cascade');
                    css += text + '\\n'; 
                }
            } catch (e) { }
        }
        return { css };
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

async function captureHTML(cdp) {
    const SCRIPT = `(() => {
        const cascade = document.getElementById('cascade');
        if (!cascade) return { error: 'cascade not found' };
        
        // Build a path for each button (without modifying original DOM)
        function getPath(el, root) {
            const path = [];
            while (el && el !== root) {
                const parent = el.parentElement;
                if (!parent) break;
                const idx = Array.from(parent.children).indexOf(el);
                path.unshift(idx);
                el = parent;
            }
            return path;
        }
        
        const buttons = cascade.querySelectorAll('button');
        const buttonMap = {};
        
        const clone = cascade.cloneNode(true);
        const cloneButtons = clone.querySelectorAll('button');
        
        // Tag buttons in CLONE only, store paths + text for originals
        buttons.forEach((btn, i) => {
            const id = 'btn-' + i;
            const path = getPath(btn, cascade);
            // Store path and text for verification during click
            buttonMap[id] = { 
                path: path, 
                text: btn.textContent.trim().slice(0, 50) // First 50 chars for matching
            };
            if (cloneButtons[i]) {
                cloneButtons[i].setAttribute('data-relay-id', id);
            }
        });
        
        // Remove input box to keep snapshot clean
        const input = clone.querySelector('[contenteditable="true"]')?.closest('div[id^="cascade"] > div');
        if (input) input.remove();
        
        const bodyStyles = window.getComputedStyle(document.body);

        return {
            html: clone.outerHTML,
            buttonMap: buttonMap,
            bodyBg: bodyStyles.backgroundColor,
            bodyColor: bodyStyles.color
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
                    existing.metadata = { ...existing.metadata, ...meta };
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
                        isActive: meta.isActive
                    },
                    snapshot: null,
                    css: await captureCSS(cdp), //only on init bc its huge
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
            const snap = await captureHTML(c.cdp); // Only capture HTML
            if (snap) {
                const hash = hashString(snap.html);
                if (hash !== c.snapshotHash) {
                    c.snapshot = snap;
                    c.snapshotHash = hash;
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

    app.post('/click/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({ error: 'Cascade not found' });

        const { relayId } = req.body;
        const buttonInfo = c.snapshot?.buttonMap?.[relayId];

        if (!buttonInfo) {
            console.log(`Click in ${c.metadata.chatTitle}: relayId=${relayId} - not found in buttonMap`);
            return res.status(404).json({ error: 'Button not found in snapshot', relayId });
        }

        console.log(`Click in ${c.metadata.chatTitle}: relayId=${relayId}, text="${buttonInfo.text}"`);

        const result = await injectClick(c.cdp, buttonInfo.path, buttonInfo.text);
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
        // Try contenteditable first, then textarea
        const editor = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
        if (!editor) return { ok: false, reason: "no editor found" };
        
        editor.focus();
        
        if (editor.tagName === 'TEXTAREA') {
            const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
            nativeTextAreaValueSetter.call(editor, "${text.replace(/"/g, '\\"')}");
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            document.execCommand("selectAll", false, null);
            document.execCommand("insertText", false, "${text.replace(/"/g, '\\"')}");
        }
        
        await new Promise(r => setTimeout(r, 100));
        
        // Try multiple button selectors
        const btn = document.querySelector('button[class*="arrow"]') || 
                   document.querySelector('button[aria-label*="Send"]') ||
                   document.querySelector('button[type="submit"]');

        if (btn) {
            btn.click();
        } else {
             // Fallback to Enter key
             editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter" }));
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

// Click relay helper - uses DOM path for precise identification + text verification
async function injectClick(cdp, path, expectedText) {
    const pathJson = JSON.stringify(path);
    const escapedExpectedText = (expectedText || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const SCRIPT = `(() => {
        const path = ${pathJson};
        const expectedText = '${escapedExpectedText}';
        
        let el = document.getElementById('cascade');
        if (!el) return { ok: false, reason: 'cascade not found' };
        
        // Navigate the path
        for (const idx of path) {
            if (!el.children || !el.children[idx]) {
                return { ok: false, reason: 'path invalid', path: path, failedAt: idx };
            }
            el = el.children[idx];
        }
        
        if (el.tagName !== 'BUTTON') {
            return { ok: false, reason: 'element is not a button', tag: el.tagName };
        }
        
        // Verify text content matches (first 50 chars)
        const actualText = el.textContent.trim().slice(0, 50);
        if (actualText !== expectedText) {
            return { 
                ok: false, 
                reason: 'text mismatch - DOM may have changed', 
                expected: expectedText, 
                actual: actualText 
            };
        }
        
        el.click();
        return { ok: true, clicked: el.tagName, text: actualText };
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
