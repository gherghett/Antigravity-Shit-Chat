# Antigravity Shit-Chat Mobile Monitor

Need to go to the bathroom? But Opus 4.5 might be done with that big task soon? Want to eat lunch? But there's more tokens left before they reset right after lunch?

<img width="1957" height="1060" alt="screenshot" src="https://github.com/user-attachments/assets/95318065-d943-43f1-b05c-26fd7c0733dd" />


A real-time mobile interface for monitoring and interacting with Antigravity chat sessions.

## Features

- **Real-time Monitoring**: Mirrors the Antigravity chat interface to your phone.
- **Secure Access**: Authenticated via QR Code (auto-generated token).
- **Remote Control**: Type messages from your phone and inject them into Antigravity.
- **Multi-Instance Support**: Run multiple Antigravity windows and switch between them on your phone.

## How It Works

It's a simple system, but pretty hacky.

### 1. Snapshot Capture
The server connects to Antigravity via Chrome DevTools Protocol (CDP) and periodically captures snapshots of the chat interface. It captures HTML/CSS to preserve the exact look and feel.

### 2. Secure Web Interface
A lightweight web server (Express + WebSocket) serves the mobile UI. It requires a security token to connect, which is embedded in the QR code displayed in your terminal.

## Setup

### 1. Start Antigravity with Remote Debugging

You need to start Antigravity with the `--remote-debugging-port` flag.

**Single Instance:**
```powershell
& "path\to\Antigravity.exe" --remote-debugging-port=9222
```

**Running Multiple Instances:**
If you want to run a *second* instance, you MUST specify a separate user data directory, or Electron will just focus the existing window.

```powershell
# Instance 1 (Port 9000)
& "path\to\Antigravity.exe" --remote-debugging-port=9000 --user-data-dir="C:\Temp\AG_Instance_1"

# Instance 2 (Port 9222)
& "path\to\Antigravity.exe" --remote-debugging-port=9222 --user-data-dir="C:\Temp\AG_Instance_2"
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Start the Monitor

```bash
npm run dev
```

The terminal will generate a **QR Code**.

### 4. Connect

1.  **Scan the QR Code** with your phone.
2.  It will automatically open the monitor in your browser with the correct authentication token.
3.  **Authentication**: If the token is valid, you will see the chat immediately.

### 5. Multi-Instance Switching

If the monitor detects multiple running Antigravity instances (e.g., ports 9000 and 9222):
1.  Click the **Monitor Icon** (🖥️) in the top-right corner of your phone screen.
2.  Select the instance/port you want to view.
3.  The view will update instantly (cached state) and then sync with the live window.

## Troubleshooting

- **"Connection Refused"**: Ensure Antigravity is running with the correct `--remote-debugging-port`.
- **"Blank Screen"**: Try refreshing the page on your phone. If persisting, ensure the Antigravity window on your computer is not minimized/sleeping.
- **"Address in Use"**: If `npm run dev` fails, make sure you don't have another terminal window running the server.
