# WebSocket Implementation Clarification

## Issue

PR #1 states: "Direct WebSocket snapshots: Snapshots are now broadcast directly via WebSocket on connect instead of requiring client polling"

This description is misleading because **WebSockets were already used from the start**.

## Original Implementation (Before PR #1)

The original `server.js` **already used WebSockets**:

```javascript
// Client connection
function connectWebSocket() {
    ws = new WebSocket(`${protocol}//${window.location.host}`);
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'snapshot_update') {
            loadSnapshot();  // Fetches via HTTP GET
        }
    };
}
```

The server sent WebSocket notifications when snapshots changed:
```javascript
client.send(JSON.stringify({
    type: 'snapshot_update',
    timestamp: new Date().toISOString()
}));
```

Then clients made an HTTP GET request to fetch the actual snapshot data:
```javascript
const response = await fetch('/snapshot');
const data = await response.json();
```

## Current Implementation (After PR #1)

The new implementation still uses WebSockets, but now **sends snapshot data directly** through the WebSocket connection:

```typescript
// Server sends snapshot data via WebSocket
ws.send(JSON.stringify({
    type: 'snapshot',
    data: lastSnapshot,
    timestamp: new Date().toISOString()
}));
```

The client receives the data directly:
```javascript
ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'snapshot' && msg.data) {
        renderSnapshot(msg.data);  // No HTTP request needed
    }
};
```

## Accurate Description

The improvement is **NOT** "now using websockets instead of client polling" because:

1. WebSockets were already being used
2. It wasn't traditional "client polling" - it was event-driven via WebSocket notifications

The **actual improvement** is:

> **Direct WebSocket data transfer**: Snapshot data is now sent directly through WebSocket messages instead of sending notifications that require clients to make separate HTTP GET requests. This reduces round trips and improves real-time performance.

## Conclusion

The original implementation was **not** using "client polling" in the traditional sense (no `setInterval` making repeated requests). It was using WebSockets for **notifications** + HTTP for **data transfer**. 

The new implementation uses WebSockets for **both notifications and data transfer**, which is more efficient and truly real-time.
