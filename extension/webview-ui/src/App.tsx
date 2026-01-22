import { useState, useEffect } from 'react';

interface Status {
    serverRunning: boolean;
    tunnelRunning: boolean;
    tunnelUrl: string;
    port: number;
    authEnabled: boolean;
    cdpPorts: number[];
    cdpConnected: boolean;
    cdpCascadesFound: number;
    cdpLastScan: number | null;
}

interface TwoFAData {
    secret: string;
    qr: string;
}

declare function acquireVsCodeApi(): {
    postMessage: (msg: unknown) => void;
};

const vscode = acquireVsCodeApi();

function App() {
    const [status, setStatus] = useState<Status>({
        serverRunning: false,
        tunnelRunning: false,
        tunnelUrl: '',
        port: 9420,
        authEnabled: true,
        cdpPorts: [9000, 9001, 9002, 9003],
        cdpConnected: false,
        cdpCascadesFound: 0,
        cdpLastScan: null
    });
    const [port, setPort] = useState('9420');
    const [cdpPortsInput, setCdpPortsInput] = useState('9000');
    const [twoFAData, setTwoFAData] = useState<TwoFAData | null>(null);
    const [show2FA, setShow2FA] = useState(false);
    const [serverLoading, setServerLoading] = useState(false);
    const [tunnelLoading, setTunnelLoading] = useState(false);
    const [authLoading, setAuthLoading] = useState(false);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const message = event.data;
            switch (message.type) {
                case 'status':
                    setStatus(message.data);
                    setPort(String(message.data.port || 9420));
                    if (message.data.cdpPorts?.length === 1) {
                        setCdpPortsInput(String(message.data.cdpPorts[0]));
                    }
                    setServerLoading(false);
                    setTunnelLoading(false);
                    setAuthLoading(false);
                    break;
                case '2faData':
                    setTwoFAData(message.data);
                    setShow2FA(true);
                    break;
            }
        };

        window.addEventListener('message', handleMessage);
        vscode.postMessage({ type: 'requestStatus' });

        return () => window.removeEventListener('message', handleMessage);
    }, []);

    const toggleServer = () => {
        setServerLoading(true);
        vscode.postMessage({ type: 'toggleServer', active: !status.serverRunning, port: parseInt(port) });
    };

    const toggleTunnel = () => {
        setTunnelLoading(true);
        vscode.postMessage({ type: 'toggleTunnel', active: !status.tunnelRunning });
    };

    const toggle2FA = () => {
        setAuthLoading(true);
        vscode.postMessage({ type: 'toggle2FA', active: !status.authEnabled });
    };

    const applyPort = () => {
        const p = parseInt(port);
        if (p >= 1024 && p <= 65535) {
            vscode.postMessage({ type: 'setPort', port: p });
        }
    };

    const applyCdpPort = () => {
        const p = parseInt(cdpPortsInput);
        if (p >= 1024 && p <= 65535) {
            vscode.postMessage({ type: 'setCdpPorts', ports: [p] });
        }
    };

    const copyText = (text: string) => {
        vscode.postMessage({ type: 'copy', text });
    };

    const request2FA = () => {
        vscode.postMessage({ type: 'request2FA' });
    };

    const formatTimeSince = (timestamp: number | null) => {
        if (!timestamp) return 'Never';
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        if (seconds < 5) return 'Just now';
        if (seconds < 60) return `${seconds}s ago`;
        return `${Math.floor(seconds / 60)}m ago`;
    };

    return (
        <div className="container">
            <h1>💩 Shit-Chat Control Panel</h1>

            {/* CDP Connection */}
            <div className="card">
                <h2>🔌 Antigravity Connection</h2>
                <p className="note">Connect via Chrome DevTools Protocol. Start Antigravity with <code>--remote-debugging-port=PORT</code></p>
                <div className="status-row">
                    <span className={`dot ${status.cdpConnected ? 'active' : ''}`}></span>
                    <span>{status.cdpConnected ? `Connected (${status.cdpCascadesFound} windows)` : 'Not connected'}</span>
                    <span className="timestamp">{status.serverRunning ? formatTimeSince(status.cdpLastScan) : '—'}</span>
                </div>
                {!status.cdpConnected && status.serverRunning && (
                    <div className="hint warning">
                        ⚠️ No Antigravity found on port {status.cdpPorts.join(', ')}
                    </div>
                )}
                <div className="input-row">
                    <label>CDP Port:</label>
                    <input type="number" value={cdpPortsInput} onChange={e => setCdpPortsInput(e.target.value)} />
                    <button onClick={applyCdpPort}>Set</button>
                </div>
            </div>

            {/* Server */}
            <div className="card">
                <h2>🖥️ Local Server</h2>
                <p className="note">Captures chat snapshots and serves the mobile UI.</p>
                <div className="status-row">
                    <span className={`dot ${status.serverRunning ? 'active' : ''} ${serverLoading ? 'pulsing' : ''}`}></span>
                    <span>{serverLoading ? (status.serverRunning ? 'Stopping...' : 'Starting...') : (status.serverRunning ? 'Running' : 'Stopped')}</span>
                    <button onClick={toggleServer} disabled={serverLoading}>
                        {status.serverRunning ? 'Stop' : 'Start'}
                    </button>
                </div>
                {status.serverRunning && (
                    <div className="url-box">
                        <a href={`http://localhost:${status.port}`} target="_blank">http://localhost:{status.port}</a>
                        <button onClick={() => copyText(`http://localhost:${status.port}`)}>📋</button>
                    </div>
                )}
                <div className="input-row">
                    <label>Port:</label>
                    <input type="number" value={port} onChange={e => setPort(e.target.value)} disabled={status.serverRunning} />
                    <button onClick={applyPort} disabled={status.serverRunning}>Apply</button>
                </div>
            </div>

            {/* Tunnel */}
            <div className="card">
                <h2>🌐 Cloudflare Tunnel</h2>
                <p className="note">Expose your server to the internet securely.</p>
                <div className="status-row">
                    <span className={`dot ${status.tunnelRunning ? 'active' : ''} ${tunnelLoading ? 'pulsing' : ''}`}></span>
                    <span>{tunnelLoading ? (status.tunnelRunning ? 'Disconnecting...' : 'Connecting...') : (status.tunnelRunning ? 'Connected' : 'Disconnected')}</span>
                    <button onClick={toggleTunnel} disabled={tunnelLoading || !status.serverRunning}>
                        {status.tunnelRunning ? 'Stop' : 'Start'}
                    </button>
                </div>
                {!status.serverRunning && <div className="hint">⚠️ Start server first</div>}
                {status.tunnelRunning && status.tunnelUrl && (
                    <div className="url-box success">
                        <a href={status.tunnelUrl} target="_blank">{status.tunnelUrl}</a>
                        <button onClick={() => copyText(status.tunnelUrl)}>📋</button>
                    </div>
                )}
            </div>

            {/* 2FA */}
            <div className="card">
                <h2>🔐 2FA Security</h2>
                <p className="note">Require TOTP code to access mobile UI.</p>
                <div className="status-row">
                    <span className={`dot ${status.authEnabled ? 'active' : ''} ${authLoading ? 'pulsing' : ''}`}></span>
                    <span>{authLoading ? 'Updating...' : (status.authEnabled ? 'Enabled' : 'Disabled')}</span>
                    <button onClick={toggle2FA} disabled={authLoading}>
                        {status.authEnabled ? 'Disable' : 'Enable'}
                    </button>
                </div>
                {!status.authEnabled && status.tunnelRunning && (
                    <div className="hint warning">⚠️ Tunnel is public without 2FA!</div>
                )}
                <button onClick={request2FA} className="secondary">View QR Code / Secret</button>
            </div>

            {/* 2FA Setup */}
            {show2FA && twoFAData && (
                <div className="card highlight">
                    <h2>🔐 2FA Setup</h2>
                    <p className="note">Scan with Google Authenticator or Apple Passwords</p>
                    <div className="qr-container">
                        <img src={twoFAData.qr} alt="QR Code" />
                    </div>
                    <div className="url-box">
                        <code>{twoFAData.secret}</code>
                        <button onClick={() => copyText(twoFAData.secret)}>📋</button>
                    </div>
                    <button onClick={() => setShow2FA(false)} className="secondary">Close</button>
                </div>
            )}

            {/* Quick Actions */}
            <div className="card">
                <h2>⚡ Quick Actions</h2>
                <div className="button-row">
                    <button onClick={() => vscode.postMessage({ type: 'openLocal' })} disabled={!status.serverRunning}>
                        Open Local UI
                    </button>
                    {status.tunnelRunning && status.tunnelUrl && (
                        <button onClick={() => vscode.postMessage({ type: 'openTunnel' })}>
                            Open Mobile UI
                        </button>
                    )}
                </div>
            </div>

            <p className="footer">Antigravity Shit-Chat v1.4.0</p>
        </div>
    );
}

export default App;
