# Shit-Chat Antigravity Extension

A VS Code extension that integrates Shit-Chat mobile monitoring directly into Antigravity.

## Features

- **Status Bar Integration**: Click the 💩 Shit-Chat icon for quick access to all functions
- **Control Panel**: Full-featured React-based settings UI
- **Cloudflare Tunnel**: Expose your local server securely to access from mobile
- **2FA Security**: TOTP-based authentication for remote access
- **CDP Auto-Detection**: Automatically detects Antigravity's remote debugging port

## Installation

### Prerequisites

1. **Cloudflared** (for tunnel support):
   ```bash
   brew install cloudflare/cloudflare/cloudflared
   ```

2. **Start Antigravity with CDP enabled**:
   ```bash
   antigravity --remote-debugging-port=9000
   ```

### Install the Extension

Run the install script from the project root:

```bash
./install-extension.sh
```

Then restart Antigravity.

## Usage

### Quick Menu (Recommended)

Click the **"○ Shit-Chat"** status bar item in the bottom-right corner to access:
- Start/Stop Server
- Start/Stop Tunnel
- Open Local/Mobile UI
- Copy Tunnel URL
- Open Control Panel

### Control Panel

Run command: `Shit-Chat: Open Control Panel`

The control panel shows:
- **CDP Connection**: Status of connection to Antigravity
- **Local Server**: Toggle server on/off, configure port
- **Cloudflare Tunnel**: Toggle public URL on/off
- **2FA Security**: Enable/disable authentication, view QR code

### Commands

| Command | Description |
|---------|-------------|
| `Shit-Chat: Start Mobile Monitor` | Start the server |
| `Shit-Chat: Stop Mobile Monitor` | Stop server and tunnel |
| `Shit-Chat: Open Control Panel` | Open settings UI |
| `Shit-Chat: Setup 2FA (QR Code)` | View 2FA setup |
| `Shit-Chat: Open Mobile UI` | Open tunnel URL in browser |

## Development

### Building the Webview UI

```bash
cd extension/webview-ui
npm install
npm run build
```

### Project Structure

```
extension/
├── extension.js      # Main extension code
├── server.js         # HTTP/WebSocket server
├── settings.html     # Legacy settings (backup)
├── package.json      # Extension manifest
└── webview-ui/       # React control panel
    ├── src/
    │   ├── App.tsx   # Main React component
    │   ├── main.tsx  # Entry point
    │   └── index.css # Styles
    └── dist/         # Built assets
```

## Security

- **2FA**: Uses TOTP (Google Authenticator, Apple Passwords compatible)
- **Session**: 7-day session tokens stored in HTTP-only cookies
- **Warning**: A modal warns when enabling tunnel without 2FA
