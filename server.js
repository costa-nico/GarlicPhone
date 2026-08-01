const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve frontend files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

let history = [];
let users = {};

wss.on('connection', (ws) => {
  const connId = Math.random().toString(36).slice(2);
  ws.id = connId;

  console.log('Client connected:', connId);

  // Send existing history to the new user
  ws.send(JSON.stringify({ type: 'sync', history, users }));

  ws.on('message', (message) => {
    const messageStr = message.toString();
    try {
      const msg = JSON.parse(messageStr);
      
      if (msg.type === 'cursor') {
        users[msg.id] = { ...users[msg.id], cursor: msg.pos, name: msg.name };
        broadcast(messageStr, ws);
        return;
      }
      
      if (msg.type === 'disconnect') {
        delete users[msg.id];
        broadcast(messageStr, ws);
        return;
      }

      if (msg.type === 'clear') {
        history = [];
        history.push(msg);
      } else if (msg.type === 'undo') {
        if (msg.strokeId) {
          history = history.filter(e => e.strokeId !== msg.strokeId);
        }
      } else {
        history.push(msg);
      }
      
      broadcast(messageStr, ws);
    } catch (e) {
      console.error('Error parsing message', e);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected:', connId);
  });
});

function broadcast(data, excludeWs) {
  wss.clients.forEach((client) => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// Use PORT from environment or 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`GarlicPhone Server is running on port ${PORT}`);
});
