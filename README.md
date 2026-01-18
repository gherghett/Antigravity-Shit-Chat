# Antigravity Shit-Chat Mobile Monitor

Need to go to the bathroom? But Opus 4.5 might be done with that big task soon? Want to eat lunch? But there's more tokens left before they reset right after lunch?

<img width="1957" height="1060" alt="screenshot" src="https://github.com/user-attachments/assets/95318065-d943-43f1-b05c-26fd7c0733dd" />


A real-time mobile interface for monitoring and interacting with Antigravity chat sessions. 

## How It Works

It's a simple system, but pretty hacky.

The mobile monitor operates through three main components:

### 1. Reading (Snapshot Capture)
The server connects to Antigravity via Chrome DevTools Protocol (CDP) and periodically captures **snapshots of the chat interface**:
- Captures all CSS styles to preserve formatting, sends CSS only once bc its huge
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
- Send messages directly from your phone

## Setup

### 1. Start Antigravity or Cursor with CDP

Start Antigravity or Cursor with Chrome DevTools Protocol enabled:

Antigravity:
```bash
antigravity . --remote-debugging-port=9000
```
(You will get this message: "Warning: 'remote-debugging-port' is not in the list of known options, but still passed to Electron/Chromium." that's fine)

Cursor:
```bash
cursor --remote-debugging-port=9000
```

You may see a warning about `remote-debugging-port` not being a known option. That is fine; Electron still passes it to Chromium. Make sure the AI Chat panel is open.

### 2. Install Dependencies

```bash
npm install
```

### 3. Start the Monitor

```bash
node server.js
```

### 4. Access from Mobile

Open your browser in the bathroom and navigate to:
```
http://<your-local-ip>:3000
```

### Problems?

Problems setting up? Don't know how to do a step? Can't find an explanation? **Open Shit-Chat folder in antigravity and tell the agent what issues you are having**. It can read the code in one go.

------------

This is over local network, so it will not work if you are on a different network, unless you use a VPN or tailscale or something.

I have tried keeping it simple and not adding any extra features, but if you want to add more features, feel free to do so, because of how simple it is it should be pretty easy. You might just want to use the server.js and just use the API it exposes to interact with open chatwindows with your own client.

### Thanks to https://github.com/lukasz-wronski for finding bugs and https://github.com/Mario4272 for the original idea. 
