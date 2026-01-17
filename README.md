# Antigravity Shit-Chat Mobile Monitor

Need to go to the bathroom? But Opus 4.5 might be done with that big task soon? Want to eat lunch? But there's more tokens left before they reset right after lunch?

<img width="1957" height="1060" alt="screenshot" src="https://github.com/user-attachments/assets/95318065-d943-43f1-b05c-26fd7c0733dd" />


A real-time mobile interface for monitoring and interacting with Antigravity chat sessions. 

## How It Works

It's a simple system, but pretty hacky.

The mobile monitor operates through three main components:

### 1. Reading (Snapshot Capture)
The server connects to Antigravity via Chrome DevTools Protocol (CDP) and periodically captures **snapshots of the chat interface**:
- Captures all CSS styles to preserve formatting
- Captures the HTML of the chat interface
- Buttons and everything that you wont be able to click
- Polls every 3 seconds and only updates when content changes

### 2. Injecting (Message Sending)
Antigravity must be run in chrome with remote debugging enabled.
Messages typed in the mobile interface are injected directly into Antigravity:
- Locates the Antigravity chat input editor
- Inserts the message text and triggers submission
- Handles the input safely without interfering with ongoing operations

### 3. Serving (Web Interface)
A lightweight web server provides the mobile UI:
- WebSocket connection for real-time updates
- Auto-refresh when new content appears
- Clean, responsive interface optimized for mobile devices
- Send messages directly from your phone

## Setup

### 1. Start Antigravity with CDP

Start Antigravity with Chrome DevTools Protocol enabled:

```bash
antigravity . --remote-debugging-port=9000
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Start the Monitor

**Development mode** (with hot reload):
```bash
npm run dev
```

**Production mode**:
```bash
npm run build
npm start
```

### 4. Access from Mobile

Open your browser in the bathroom and navigate to:
```
http://<your-local-ip>:3000
```

This is over local network, so it will not work if you are on a different network, unless you use a VPN or something.

The interface will automatically connect and display your Antigravity conversation in almost real-time.
