#!/usr/bin/env node
import express, { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORTS = [9000, 9001, 9002, 9003];
const POLL_INTERVAL = 3000;
const HTTP_TIMEOUT = 2000; // 2 seconds max for discovery
const CDP_CONTEXT_WAIT = 200; // Wait for contexts (was 1000ms!)

// Authentication
const AUTH_TOKEN = process.env.AUTH_TOKEN || Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
console.log('\n🔒 SECURITY: Authentication Enabled');
console.log(`🔑 Access Token: ${AUTH_TOKEN}\n`);

// Types
interface CDPInfo {
    port: number;
    url: string;
}

interface CDPTarget {
    url?: string;
    title?: string;
    webSocketDebuggerUrl?: string;
}

interface CDPContext {
    id: number;
    origin?: string;
    name?: string;
}

interface CDPConnection {
    ws: WebSocket;
    call: (method: string, params: Record<string, unknown>) => Promise<CDPResult>;
    contexts: CDPContext[];
}

interface CDPResult {
    result?: {
        value?: unknown;
    };
    error?: {
        message: string;
    };
}

interface Snapshot {
    html: string;
    css: string;
    backgroundColor: string;
    color: string;
    fontFamily: string;
    error?: string;
    // Theme fields
    themeClass?: string;
    themeAttr?: string;
    colorScheme?: string;
    bodyBg?: string;
    bodyColor?: string;
}

interface InjectResult {
    ok: boolean;
    method?: string;
    reason?: string;
}

// Shared state
let cdpConnection: CDPConnection | null = null;
let lastSnapshot: Snapshot | null = null;
let lastSnapshotHash: string | null = null;
let wssRef: WebSocketServer | null = null;

// Helper: HTTP GET JSON with timeout
function getJson<T>(url: string, timeout = HTTP_TIMEOUT): Promise<T> {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data) as T); } catch (e) { reject(e); }
            });
        });

        req.on('error', reject);
        req.setTimeout(timeout, () => {
            req.destroy();
            reject(new Error(`Timeout after ${timeout}ms`));
        });
    });
}

// Find Antigravity CDP endpoint - parallel with race
async function discoverCDP(): Promise<CDPInfo> {
    // Try all ports in parallel, return first success
    const attempts = PORTS.map(async (port): Promise<CDPInfo | null> => {
        try {
            const list = await getJson<CDPTarget[]>(`http://127.0.0.1:${port}/json/list`);
            const found = list.find(t => t.url?.includes('workbench.html') || (t.title && t.title.includes('workbench')));
            if (found?.webSocketDebuggerUrl) {
                return { port, url: found.webSocketDebuggerUrl };
            }
        } catch { }
        return null;
    });

    const results = await Promise.all(attempts);
    const found = results.find(r => r !== null);

    if (found) return found;
    throw new Error('CDP not found. Is Antigravity started with --remote-debugging-port=9000?');
}

// Connect to CDP
async function connectCDP(url: string): Promise<CDPConnection> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const call = (method: string, params: Record<string, unknown>): Promise<CDPResult> => new Promise((resolve, reject) => {
        const id = idCounter++;
        const handler = (msg: Buffer | string) => {
            const data = JSON.parse(msg.toString()) as { id?: number; error?: { message: string }; result?: { result?: { value?: unknown } } };
            if (data.id === id) {
                ws.off('message', handler);
                if (data.error) reject(data.error);
                // CDP Runtime.evaluate returns { result: { result: { value: ... } } }
                else resolve({ result: data.result?.result });
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });

    const contexts: CDPContext[] = [];
    ws.on('message', (msg: Buffer | string) => {
        try {
            const data = JSON.parse(msg.toString()) as { method?: string; params?: { context: CDPContext } };
            if (data.method === 'Runtime.executionContextCreated' && data.params) {
                contexts.push(data.params.context);
            }
        } catch { }
    });

    await call("Runtime.enable", {});

    // Wait briefly for contexts (reduced from 1000ms!)
    await new Promise(r => setTimeout(r, CDP_CONTEXT_WAIT));

    return { ws, call, contexts };
}

// Convert vscode-file:// URLs to base64 data URIs
function convertVsCodeIcons(html: string): string {
    // Match vscode-file URLs like: vscode-file://vscode-app/Applications/Antigravity.app/.../file.svg
    const vsCodeUrlRegex = /vscode-file:\/\/vscode-app(\/[^"'\s]+\.(?:svg|png|jpg|gif))/gi;

    return html.replace(vsCodeUrlRegex, (match, filePath) => {
        try {
            // Convert URL path to local filesystem path
            const localPath = decodeURIComponent(filePath);

            if (!existsSync(localPath)) {
                return match; // Keep original if file doesn't exist
            }

            const content = readFileSync(localPath);
            const extension = localPath.split('.').pop()?.toLowerCase() || 'svg';
            const mimeType = extension === 'svg' ? 'image/svg+xml' : `image/${extension}`;
            const base64 = content.toString('base64');

            return `data:${mimeType};base64,${base64}`;
        } catch {
            return match; // Keep original on error
        }
    });
}

// Capture chat snapshot
async function captureSnapshot(cdp: CDPConnection): Promise<Snapshot | null> {
    const CAPTURE_SCRIPT = `(() => {
        const cascade = document.getElementById('cascade');
        if (!cascade) return { error: 'cascade not found' };
        
        const cascadeStyles = window.getComputedStyle(cascade);
        const clone = cascade.cloneNode(true);
        
        const inputContainer = clone.querySelector('[contenteditable="true"]')?.closest('div[id^="cascade"] > div');
        if (inputContainer) inputContainer.remove();
        
        // Extract terminal text from xterm buffer (WebGL canvas can't be captured)
        // Find all terminal containers and replace canvas with text content
        const terminalContainers = clone.querySelectorAll('.terminal.xterm');
        const originalTerminals = cascade.querySelectorAll('.terminal.xterm');
        
        originalTerminals.forEach((originalTerminal, i) => {
            try {
                const clonedTerminal = terminalContainers[i];
                if (!clonedTerminal) return;
                
                // Find xterm instance via wrapper.xterm property
                const wrapper = originalTerminal.closest('.terminal-wrapper');
                const term = wrapper?.xterm;
                if (term && term.buffer && term.buffer.active) {
                    const buffer = term.buffer.active;
                    const allLines = [];
                    // Get all valid lines first
                    for (let row = 0; row < buffer.length; row++) {
                        const line = buffer.getLine(row);
                        if (line) {
                            allLines.push(line.translateToString(true));
                        }
                    }

                    // Smart Tail:
                    // 1. Trim empty lines from the END
                    while (allLines.length > 0 && allLines[allLines.length - 1].trim() === '') {
                        allLines.pop();
                    }
                    
                    // Filter out garbage lines that might contain just control characters or weird spacing
                    // We also show last 60 lines max
                    let linesToShow = allLines;
                    if (linesToShow.length > 60) {
                        linesToShow = linesToShow.slice(-60);
                    }
                    
                    // 2. Trim empty lines AND lone prompts from the START of the slice
                    // This fixes the "$ $ %" artifacts reported by the user
                    const promptOnlyRegex = /^[$%>#]\s*$/;
                    while (linesToShow.length > 0 && (linesToShow[0].trim() === '' || promptOnlyRegex.test(linesToShow[0].trim()))) {
                        linesToShow.shift();
                    }

                    // Create a pre element with terminal text
                    const pre = document.createElement('pre');
                    pre.textContent = linesToShow.join(String.fromCharCode(10));
                    // Reset everything on the pre
                    pre.style.cssText = 'display:block; margin:0; padding:8px 12px; font-family:monospace; font-size:12px; line-height:1.4; background:#181818; color:#d4d4d4; overflow-x:auto; white-space:pre-wrap; word-break:break-all; border:none; width:100%; box-sizing:border-box;';
                    
                    // AGGRESSIVE REPLACEMENT:
                    // Find the wrapper in the CLONED DOM and replace its ENTIRE content with our pre.
                    // This kills all xterm layout issues, scrollbars, viewports, etc.
                    const clonedWrapper = clonedTerminal.closest('.terminal-wrapper') || clonedTerminal.parentNode;
                    
                    if (clonedWrapper) {
                        // Clear everything
                        clonedWrapper.innerHTML = '';
                        clonedWrapper.appendChild(pre);
                        
                        // Reset wrapper styles to just fit content
                        // @ts-ignore
                        clonedWrapper.style.height = 'auto';
                        // @ts-ignore
                        clonedWrapper.style.minHeight = '0';
                        // @ts-ignore
                        clonedWrapper.style.display = 'block';
                        // @ts-ignore
                        clonedWrapper.style.padding = '0';
                        // @ts-ignore
                        clonedWrapper.className = 'terminal-output-captured'; // Remove conflicting classes
                    }
                    
                    // Also clean up the parent component-shared-terminal if it exists
                    const termContainer = clonedWrapper.parentNode;
                    if (termContainer && termContainer.className.includes('component-shared-terminal')) {
                         // @ts-ignore
                         termContainer.style.height = 'auto';
                         // @ts-ignore
                         termContainer.style.minHeight = '0';
                         // @ts-ignore
                         termContainer.style.display = 'block';
                    }
                }
            } catch (e) { }
        });
        
        // Also try to remove any remaining canvases (they'll be empty anyway)
        clone.querySelectorAll('canvas').forEach(c => c.remove());
        
        const html = clone.outerHTML;
        
        let allCSS = '';
        for (const sheet of document.styleSheets) {
            try {
                for (const rule of sheet.cssRules) {
                    allCSS += rule.cssText + String.fromCharCode(10);
                }
            } catch (e) { }
        }
        
        const rootStyles = window.getComputedStyle(document.documentElement);
        const bodyStyles = window.getComputedStyle(document.body);
        
        const htmlEl = document.documentElement;
        const themeClass = htmlEl.className;
        const themeAttr = htmlEl.getAttribute('data-theme') || '';
        const colorScheme = rootStyles.colorScheme || 'dark';
        
        return {
            html: html,
            css: allCSS,
            backgroundColor: cascadeStyles.backgroundColor,
            color: cascadeStyles.color,
            fontFamily: cascadeStyles.fontFamily,
            themeClass: themeClass,
            themeAttr: themeAttr,
            colorScheme: colorScheme,
            bodyBg: bodyStyles.backgroundColor,
            bodyColor: bodyStyles.color
        };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: CAPTURE_SCRIPT,
                returnByValue: true,
                contextId: ctx.id
            });

            if (result.result?.value) {
                const snapshot = result.result.value as Snapshot;
                if (snapshot.error) continue;

                // Convert vscode-file:// icons to base64 in both HTML and CSS
                snapshot.html = convertVsCodeIcons(snapshot.html);
                snapshot.css = convertVsCodeIcons(snapshot.css);
                return snapshot;
            }
        } catch { }
    }

    return null;
}

// Inject message into Antigravity (RCE FIXED)
async function injectMessage(cdp: CDPConnection, text: string): Promise<InjectResult> {
    // SAFE: Use JSON.stringify to properly escape the string for JS injection
    const safeText = JSON.stringify(text); // e.g. "Hello \"world\""
    
    const EXPRESSION = `(async () => {
        // Find visible editor (Antigravity supports message queuing even during generation)
        const editors = [...document.querySelectorAll('#cascade [data-lexical-editor="true"][contenteditable="true"][role="textbox"]')]
            .filter(el => el.offsetParent !== null);
        const editor = editors.at(-1);
        if (!editor) return { ok:false, reason:"editor_not_found" };

        editor.focus();
        document.execCommand?.("selectAll", false, null);
        document.execCommand?.("delete", false, null);

        let inserted = false;
        // Use safeText directly - it already contains quotes
        try { inserted = !!document.execCommand?.("insertText", false, ${safeText}); } catch {}
        if (!inserted) {
            editor.textContent = ${safeText};
            editor.dispatchEvent(new InputEvent("beforeinput", { bubbles:true, inputType:"insertText", data:${safeText} }));
            editor.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data:${safeText} }));
        }

        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        const submit = document.querySelector("svg.lucide-arrow-right")?.closest("button");
        if (submit && !submit.disabled) {
            submit.click();
            return { ok:true, method:"click_submit" };
        }

        editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter", code:"Enter" }));
        editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles:true, key:"Enter", code:"Enter" }));
        
        return { ok:true, method:"enter_keypress" };
    })()`;

    let lastResult: InjectResult = { ok: false, reason: "no_context" };



    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: EXPRESSION,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });

            const injResult = result.result?.value as InjectResult | undefined;


            if (injResult) {
                // Return immediately if successful
                if (injResult.ok) {
                    return injResult;
                }
                // Keep track of last non-success result
                lastResult = injResult;
            }
        } catch { }
    }

    return lastResult;
}

// Simple hash function
function hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

// Broadcast snapshot to all WS clients
function broadcastSnapshot(snapshot: Snapshot): void {
    if (!wssRef) return;

    const message = JSON.stringify({
        type: 'snapshot',
        data: snapshot,
        timestamp: new Date().toISOString()
    });

    wssRef.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Update snapshot and broadcast if changed
async function updateSnapshot(): Promise<boolean> {
    if (!cdpConnection) return false;

    try {
        const snapshot = await captureSnapshot(cdpConnection);
        if (snapshot && !snapshot.error) {
            const hash = hashString(snapshot.html);

            if (hash !== lastSnapshotHash) {
                lastSnapshot = snapshot;
                lastSnapshotHash = hash;
                broadcastSnapshot(snapshot);
                return true;
            }
        }
    } catch (err) {
        console.error('Snapshot error:', (err as Error).message);
    }
    return false;
}

// Initialize CDP connection
async function initCDP(): Promise<void> {
    console.log('🔍 Discovering CDP endpoint...');
    const startTime = Date.now();

    const cdpInfo = await discoverCDP();
    console.log(`✅ Found on port ${cdpInfo.port} (${Date.now() - startTime}ms)`);

    console.log('🔌 Connecting...');
    cdpConnection = await connectCDP(cdpInfo.url);
    console.log(`✅ Connected! ${cdpConnection.contexts.length} contexts (${Date.now() - startTime}ms total)`);

    // Capture first snapshot immediately
    console.log('📸 Capturing initial snapshot...');
    await updateSnapshot();
}

// Background polling
function startPolling(): void {
    setInterval(updateSnapshot, POLL_INTERVAL);
}

// Create Express app
async function createServer(): Promise<{ server: http.Server; wss: WebSocketServer }> {
    const app = express();
    const server = http.createServer(app);
    const wss = new WebSocketServer({ server });
    wssRef = wss;

    app.use(express.json());
    app.use(express.static(join(__dirname, '..', 'public')));

    // Auth Middleware
    app.use((req, res, next) => {
        if (req.path === '/' || req.path === '/index.html' || req.path.match(/\.(js|css|ico|png)$/)) {
            return next();
        }

        const authHeader = req.headers.authorization;
        if (authHeader === `Bearer ${AUTH_TOKEN}`) {
            return next();
        }
        
        // Also check query param for easy testing/some clients
        if (req.query.token === AUTH_TOKEN) {
            return next();
        }

        res.status(401).json({ error: 'Unauthorized' });
    });

    // Security Headers (CSP)
    app.use((_req, res, next) => {
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' data:; img-src 'self' data: blob:; connect-src 'self' ws: wss:;");
        next();
    });

    // Get current snapshot (fallback for initial load)
    app.get('/snapshot', (_req: Request, res: Response) => {
        if (!lastSnapshot) {
            return res.status(503).json({ error: 'No snapshot available yet' });
        }
        res.json(lastSnapshot);
    });

    // Send message
    app.post('/send', async (req: Request, res: Response) => {
        const { message } = req.body as { message?: string };

        if (!message) {
            return res.status(400).json({ error: 'Message required' });
        }

        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        const result = await injectMessage(cdpConnection, message);

        if (result.ok) {
            res.json({ success: true, method: result.method });
        } else {
            res.status(500).json({ success: false, reason: result.reason });
        }
    });

    // WebSocket - send current snapshot on connect
    wss.on('connection', (ws, req) => {
        // Parse token from URL query params
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const token = url.searchParams.get('token');

        if (token !== AUTH_TOKEN) {
            ws.close(1008, 'Unauthorized');
            return;
        }

        console.log('📱 Client connected (Authenticated)');

        // Send current snapshot immediately on connect
        if (lastSnapshot) {
            ws.send(JSON.stringify({
                type: 'snapshot',
                data: lastSnapshot,
                timestamp: new Date().toISOString()
            }));
        }

        ws.on('close', () => {
            console.log('📱 Client disconnected');
        });
    });

    return { server, wss };
}

// Main
async function main(): Promise<void> {
    try {
        const startTime = Date.now();

        await initCDP();
        const { server } = await createServer();
        startPolling();

        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => {
            console.log(`\n🚀 Ready in ${Date.now() - startTime}ms`);
            console.log(`📱 http://0.0.0.0:${PORT}`);
        });
    } catch (err) {
        console.error('❌ Fatal:', (err as Error).message);
        process.exit(1);
    }
}

main();
