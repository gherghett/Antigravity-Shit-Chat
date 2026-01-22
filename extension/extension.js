import * as vscode from 'vscode';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';
import QRCode from 'qrcode';
import { authenticator } from '@otplib/preset-default';
import { startServer, stopServer, getTotpSecret, setAuthEnabled, isAuthEnabled, setCdpPorts, getCdpPorts, getDiscoveryStatus } from './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let tunnelProcess = null;
let statusBarItem = null;
let currentTunnelUrl = '';
let settingsPanel = null;
let serverRunning = false;
let currentPort = 9420;

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export async function activate(context) {
    console.log('Shit-Chat Extension is now active!');

    // Status Bar Item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'shitchat.quickMenu';
    context.subscriptions.push(statusBarItem);

    // Register Commands
    context.subscriptions.push(vscode.commands.registerCommand('shitchat.start', startShitChat));
    context.subscriptions.push(vscode.commands.registerCommand('shitchat.stop', stopShitChatCommand));
    context.subscriptions.push(vscode.commands.registerCommand('shitchat.settings', () => openSettings(context)));
    context.subscriptions.push(vscode.commands.registerCommand('shitchat.setup2fa', () => setup2fa(context)));
    context.subscriptions.push(vscode.commands.registerCommand('shitchat.openMobile', openMobileUI));
    context.subscriptions.push(vscode.commands.registerCommand('shitchat.quickMenu', showQuickMenu));

    // Auto-start if it was running before (optional persistence)
    const shouldAutoStart = context.globalState.get('shitchat.autoStart', false);
    if (shouldAutoStart) {
        startShitChat();
    }

    // Try to auto-detect the remote debugging port
    detectAndSetCdpPort();

    // Show status bar immediately
    updateStatusBar(false);
}

function detectAndSetCdpPort() {
    // Check process arguments for --remote-debugging-port
    const args = process.execArgv.concat(process.argv);
    for (const arg of args) {
        const match = arg.match(/--remote-debugging-port[=:]?(\d+)/);
        if (match) {
            const port = parseInt(match[1]);
            if (port > 0 && port < 65536) {
                console.log(`🔍 Auto-detected CDP port: ${port}`);
                setCdpPorts([port]);
                return port;
            }
        }
    }

    // Fallback: check common ports
    console.log('🔍 CDP port not detected, using default range: 9000-9003');
    return null;
}

async function checkCdpPort() {
    const ports = getCdpPorts();
    for (const port of ports) {
        try {
            const result = await new Promise((resolve) => {
                const req = http.get(`http://localhost:${port}/json`, (res) => {
                    resolve(true);
                });
                req.on('error', () => resolve(false));
                req.setTimeout(1000, () => {
                    req.destroy();
                    resolve(false);
                });
                req.end();
            });
            if (result) {
                console.log(`✅ CDP found on port ${port}`);
                return true;
            }
        } catch (e) { }
    }

    vscode.window.showWarningMessage(
        `📡 Antigravity CDP not detected on port(s) ${ports.join(', ')}. ` +
        `Start Antigravity with: --remote-debugging-port=${ports[0]}`
    );
    return false;
}

function openSettings(context) {
    if (settingsPanel) {
        settingsPanel.reveal(vscode.ViewColumn.One);
        return;
    }

    const webviewPath = path.join(__dirname, 'webview-ui', 'dist');

    settingsPanel = vscode.window.createWebviewPanel(
        'shitchatSettings',
        'Shit-Chat Control Panel',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(webviewPath)]
        }
    );

    // Build the webview HTML with proper resource URIs
    const scriptUri = settingsPanel.webview.asWebviewUri(
        vscode.Uri.file(path.join(webviewPath, 'assets', 'index.js'))
    );
    const styleUri = settingsPanel.webview.asWebviewUri(
        vscode.Uri.file(path.join(webviewPath, 'assets', 'index.css'))
    );

    // Generate nonce for CSP
    const nonce = getNonce();

    settingsPanel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${settingsPanel.webview.cspSource} 'unsafe-inline'; script-src ${settingsPanel.webview.cspSource}; img-src ${settingsPanel.webview.cspSource} https: data:;">
    <link rel="stylesheet" href="${styleUri}">
    <title>Shit-Chat Control Panel</title>
    <style>
        body { font-family: var(--vscode-font-family, sans-serif); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
        .loading { text-align: center; padding: 40px; }
        .loading h2 { margin-bottom: 10px; }
    </style>
</head>
<body>
    <div id="root">
        <div class="loading">
            <h2>💩 Loading Shit-Chat...</h2>
            <p>If this doesn't load, check Developer Tools (Help → Toggle Developer Tools)</p>
        </div>
    </div>
    <script type="module" src="${scriptUri}"></script>
</body>
</html>`;

    settingsPanel.onDidDispose(() => {
        settingsPanel = null;
    }, null, context.subscriptions);

    settingsPanel.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {
            case 'requestStatus':
                broadcastStatus();
                break;
            case 'toggleServer':
                if (msg.port) currentPort = msg.port;
                if (msg.active) await startServerInProcess();
                else stopServerInProcess();
                break;
            case 'toggleTunnel':
                if (msg.active) {
                    // Check if 2FA is disabled - show warning
                    if (!isAuthEnabled()) {
                        const choice = await vscode.window.showWarningMessage(
                            '⚠️ SECURITY WARNING: You are about to expose your Shit-Chat server to the public internet WITHOUT authentication!\n\n' +
                            'Anyone with the URL will be able to:\n' +
                            '• View your Antigravity chat sessions\n' +
                            '• Send messages on your behalf\n' +
                            '• Start new conversations\n\n' +
                            'This is extremely dangerous unless you know what you are doing.',
                            { modal: true },
                            'Enable 2FA First',
                            'Continue Anyway (DANGEROUS)'
                        );

                        if (choice === 'Enable 2FA First') {
                            setAuthEnabled(true);
                            broadcastStatus();
                            await startTunnel();
                        } else if (choice === 'Continue Anyway (DANGEROUS)') {
                            await startTunnel();
                        } else {
                            // User cancelled - reset toggle in UI
                            broadcastStatus();
                        }
                    } else {
                        await startTunnel();
                    }
                } else {
                    stopTunnel();
                }
                break;
            case 'toggle2FA':
                setAuthEnabled(msg.active);
                broadcastStatus();
                break;
            case 'setPort':
                currentPort = msg.port;
                vscode.window.showInformationMessage(`⚙️ Port set to ${currentPort}. Restart server to apply.`);
                break;
            case 'request2FA':
                const secret = getTotpSecret();
                const otpauth = authenticator.keyuri('user', 'ShitChat', secret);
                const qr = await QRCode.toDataURL(otpauth);
                settingsPanel.webview.postMessage({ type: '2faData', data: { secret, qr } });
                break;
            case 'openLocal':
                vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${currentPort}`));
                break;
            case 'openTunnel':
                if (currentTunnelUrl) {
                    vscode.env.openExternal(vscode.Uri.parse(currentTunnelUrl));
                }
                break;
            case 'copy':
                vscode.env.clipboard.writeText(msg.text);
                vscode.window.showInformationMessage('📋 Copied to clipboard');
                break;
            case 'setCdpPorts':
                if (msg.ports && msg.ports.length > 0) {
                    setCdpPorts(msg.ports);
                    vscode.window.showInformationMessage(`🔍 CDP ports set to: ${msg.ports.join(', ')}`);
                }
                broadcastStatus();
                break;
        }
    });
}

function broadcastStatus() {
    const discovery = getDiscoveryStatus();
    if (settingsPanel) {
        settingsPanel.webview.postMessage({
            type: 'status',
            data: {
                serverRunning: serverRunning,
                tunnelRunning: !!tunnelProcess,
                tunnelUrl: currentTunnelUrl,
                port: currentPort,
                authEnabled: isAuthEnabled(),
                cdpPorts: getCdpPorts(),
                cdpConnected: discovery.connected,
                cdpCascadesFound: discovery.cascadesFound,
                cdpLastScan: discovery.lastScan
            }
        });
    }
    updateStatusBar(serverRunning || !!tunnelProcess);
}

async function startServerInProcess() {
    try {
        await startServer(currentPort);
        serverRunning = true;
        broadcastStatus();
    } catch (e) {
        vscode.window.showErrorMessage(`❌ Server error: ${e.message}`);
    }
}

function stopServerInProcess() {
    stopServer();
    serverRunning = false;
    broadcastStatus();
}

async function startShitChat() {
    await startServerInProcess();
    await startTunnel();
}

async function startTunnel() {
    if (tunnelProcess) return;

    const projectRoot = path.join(__dirname, '..');
    tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${currentPort}`], {
        cwd: projectRoot
    });

    tunnelProcess.stdout.on('data', (data) => handleTunnelOutput(data.toString()));
    tunnelProcess.stderr.on('data', (data) => handleTunnelOutput(data.toString()));

    tunnelProcess.on('exit', () => {
        tunnelProcess = null;
        currentTunnelUrl = '';
        broadcastStatus();
    });

    broadcastStatus();
}

function stopTunnel() {
    if (tunnelProcess) {
        tunnelProcess.kill();
        tunnelProcess = null;
        currentTunnelUrl = '';
    }
    broadcastStatus();
}

function handleTunnelOutput(output) {
    const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
        currentTunnelUrl = match[0];
        broadcastStatus();
    }
}

function stopShitChatCommand() {
    stopServerInProcess();
    stopTunnel();
    vscode.window.showInformationMessage('🛑 Shit-Chat stopped.');
}

function updateStatusBar(active) {
    if (tunnelProcess && currentTunnelUrl) {
        statusBarItem.text = `$(broadcast) Shit-Chat`;
        statusBarItem.tooltip = `Connected: ${currentTunnelUrl}`;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (serverRunning) {
        statusBarItem.text = `$(server) Shit-Chat`;
        statusBarItem.tooltip = `Server running on port ${currentPort}`;
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = `$(circle-outline) Shit-Chat`;
        statusBarItem.tooltip = 'Click to start';
        statusBarItem.backgroundColor = undefined;
    }
    statusBarItem.show();
}

function openMobileUI() {
    if (currentTunnelUrl) {
        vscode.env.openExternal(vscode.Uri.parse(currentTunnelUrl));
    } else {
        vscode.window.showErrorMessage('❌ Tunnel not active.');
    }
}

async function setup2fa(context) {
    openSettings(context); // Just open settings now, it has the setup there
}

async function showQuickMenu() {
    const items = [];

    if (serverRunning) {
        items.push({ label: '$(stop) Stop Server', action: 'stop' });
    } else {
        items.push({ label: '$(play) Start Server', action: 'start' });
    }

    if (serverRunning) {
        if (tunnelProcess) {
            items.push({ label: '$(globe) Stop Tunnel', action: 'stopTunnel' });
            if (currentTunnelUrl) {
                items.push({ label: '$(link-external) Open Mobile UI', description: currentTunnelUrl, action: 'openMobile' });
                items.push({ label: '$(clippy) Copy Tunnel URL', description: currentTunnelUrl, action: 'copyUrl' });
            }
        } else {
            items.push({ label: '$(globe) Start Tunnel', action: 'startTunnel' });
        }
        items.push({ label: '$(browser) Open Local UI', description: `http://localhost:${currentPort}`, action: 'openLocal' });
    }

    items.push({ label: '$(settings-gear) Open Control Panel', action: 'settings' });

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: '💩 Shit-Chat Actions'
    });

    if (!selected) return;

    switch (selected.action) {
        case 'start':
            await startShitChat();
            break;
        case 'stop':
            await stopShitChatCommand();
            break;
        case 'startTunnel':
            await startTunnel();
            break;
        case 'stopTunnel':
            stopTunnel();
            break;
        case 'openMobile':
            openMobileUI();
            break;
        case 'openLocal':
            vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${currentPort}`));
            break;
        case 'copyUrl':
            vscode.env.clipboard.writeText(currentTunnelUrl);
            vscode.window.showInformationMessage('📋 Tunnel URL copied!');
            break;
        case 'settings':
            vscode.commands.executeCommand('shitchat.settings');
            break;
    }
}

export async function deactivate() {
    stopServer();
    if (tunnelProcess) tunnelProcess.kill();
}
