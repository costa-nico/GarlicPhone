document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('drawing-canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  
  const activeCanvas = document.getElementById('active-canvas');
  const activeCtx = activeCanvas.getContext('2d');
  
  // Logical resolution setup (Fixed 4:3)
  const LOGICAL_WIDTH = 1600;
  const LOGICAL_HEIGHT = 1200;
  canvas.width = LOGICAL_WIDTH;
  canvas.height = LOGICAL_HEIGHT;
  activeCanvas.width = LOGICAL_WIDTH;
  activeCanvas.height = LOGICAL_HEIGHT;
  
  // Set context properties
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  activeCtx.imageSmoothingEnabled = true;
  activeCtx.imageSmoothingQuality = 'high';

  // Snapshot Checkpoint Cache (Non-destructive rendering acceleration)
  const snapshotCanvas = document.createElement('canvas');
  snapshotCanvas.width = LOGICAL_WIDTH;
  snapshotCanvas.height = LOGICAL_HEIGHT;
  const snapshotCtx = snapshotCanvas.getContext('2d');
  let checkpointIndex = -1; // History index covered by the snapshot canvas

  // Multiplayer State
  const userId = Math.random().toString(36).slice(2, 10); // Differentiated by unique random ID!
  const vibrantColors = ['#FF3B30', '#FF9500', '#FFCC00', '#4CD964', '#5AC8FA', '#007AFF', '#5856D6', '#FF2D55'];
  let userColor = vibrantColors[Math.floor(Math.random() * vibrantColors.length)];
  let userName = "익명" + Math.floor(Math.random() * 90 + 10);
  
  let eventsHistory = [];
  let myStrokes = []; // Track my own stroke IDs for Undo
  let activeStrokes = {}; // strokeId -> stroke state (points, tool, color, size)
  
  // WebSocket Connection
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/parties/main/garlic-room`;
  const ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    console.log("Connected to Multiplayer Server");
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    
    if (msg.type === 'sync') {
      eventsHistory = msg.history;
      renderHistory();
      // Handle remote cursors
      Object.keys(msg.users || {}).forEach(id => {
        if (id !== userId) updateRemoteCursor(id, msg.users[id]);
      });
    } else if (msg.type === 'cursor') {
      if (msg.id !== userId) updateRemoteCursor(msg.id, msg);
    } else if (msg.type === 'disconnect') {
      removeRemoteCursor(msg.id);
    } else if (msg.type === 'undo') {
      eventsHistory = eventsHistory.filter(e => e.strokeId !== msg.strokeId);
      renderHistory();
    } else if (msg.type === 'clear') {
      eventsHistory = [];
      eventsHistory.push(msg);
      processEvent(msg);
    } else {
      // Regular drawing event
      eventsHistory.push(msg);
      processEvent(msg);
    }
  };

  function broadcast(msg) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // --- Rendering Engine ---
  
  function processEvent(ev) {
    if (ev.type === 'clear') {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      activeStrokes = {};
      drawActiveStrokes();
    } else if (ev.type === 'draw_live') {
      if (!activeStrokes[ev.strokeId]) {
        activeStrokes[ev.strokeId] = { strokeId: ev.strokeId, tool: ev.tool, color: ev.color, opacity: ev.opacity, size: ev.size, points: [ev.pos] };
      } else {
        activeStrokes[ev.strokeId].points.push(ev.pos);
      }
      if (ev.tool === 'eraser') {
        drawSingleStrokeTo(ctx, activeStrokes[ev.strokeId]);
      } else {
        drawActiveStrokes();
      }
    } else if (ev.type === 'stroke') {
      drawSingleStrokeTo(ctx, ev);
      delete activeStrokes[ev.strokeId];
      drawActiveStrokes();
    } else if (ev.type === 'fill') {
      floodFill(ev.pos.x, ev.pos.y, hexToRgb(ev.color));
    } else if (ev.type === 'square') {
      ctx.globalAlpha = ev.opacity || 1;
      ctx.strokeStyle = ev.color;
      ctx.lineWidth = ev.size;
      ctx.lineCap = 'square';
      ctx.lineJoin = 'miter';
      ctx.strokeRect(ev.startPos.x, ev.startPos.y, ev.endPos.x - ev.startPos.x, ev.endPos.y - ev.startPos.y);
      ctx.globalAlpha = 1;
    }
  }

  function drawSingleStrokeTo(targetCtx, stroke) {
    if (!stroke || stroke.points.length === 0) return;
    targetCtx.globalAlpha = stroke.tool === 'eraser' ? 1 : (stroke.opacity || 1);
    targetCtx.strokeStyle = stroke.tool === 'eraser' ? '#FFFFFF' : stroke.color;
    targetCtx.lineWidth = stroke.size;
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';
    targetCtx.globalCompositeOperation = 'source-over';

    targetCtx.beginPath();
    const pts = stroke.points;
    targetCtx.moveTo(pts[0].x, pts[0].y);
    
    if (pts.length === 1) {
      targetCtx.fillStyle = targetCtx.strokeStyle;
      targetCtx.arc(pts[0].x, pts[0].y, stroke.size / 2, 0, Math.PI * 2);
      targetCtx.fill();
    } else {
      for (let i = 1; i < pts.length - 1; i++) {
        let midX = (pts[i].x + pts[i+1].x) / 2;
        let midY = (pts[i].y + pts[i+1].y) / 2;
        targetCtx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
      }
      targetCtx.lineTo(pts[pts.length-1].x, pts[pts.length-1].y);
      targetCtx.stroke();
    }
    
    targetCtx.globalAlpha = 1;
    targetCtx.globalCompositeOperation = 'source-over';
  }

  function drawActiveStrokes() {
    activeCtx.clearRect(0, 0, activeCanvas.width, activeCanvas.height);
    Object.values(activeStrokes).forEach(stroke => {
      drawSingleStrokeTo(activeCtx, stroke);
    });
    
    if (previewShape) {
      activeCtx.globalAlpha = previewShape.opacity || 1;
      activeCtx.strokeStyle = previewShape.color;
      activeCtx.lineWidth = previewShape.size;
      activeCtx.lineCap = 'square';
      activeCtx.lineJoin = 'miter';
      activeCtx.strokeRect(previewShape.startPos.x, previewShape.startPos.y, previewShape.endPos.x - previewShape.startPos.x, previewShape.endPos.y - previewShape.startPos.y);
      activeCtx.globalAlpha = 1;
    }
  }

  function buildSnapshotCheckpoint() {
    // Take a snapshot every 30 stroke events to keep replay time under 0.1ms
    const CHECKPOINT_INTERVAL = 30;
    if (eventsHistory.length < CHECKPOINT_INTERVAL) {
      checkpointIndex = -1;
      return;
    }
    
    const targetIndex = Math.floor(eventsHistory.length / CHECKPOINT_INTERVAL) * CHECKPOINT_INTERVAL - 1;
    if (targetIndex === checkpointIndex) return; // Already up to date
    
    snapshotCtx.fillStyle = '#FFFFFF';
    snapshotCtx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    for (let i = 0; i <= targetIndex; i++) {
      const item = eventsHistory[i];
      if (item.type === 'stroke') {
        drawSingleStrokeTo(snapshotCtx, item);
      } else if (item.type === 'fill') {
        floodFill(item.pos.x, item.pos.y, hexToRgb(item.color), snapshotCtx);
      } else if (item.type === 'square') {
        snapshotCtx.globalAlpha = item.opacity || 1;
        snapshotCtx.strokeStyle = item.color;
        snapshotCtx.lineWidth = item.size;
        snapshotCtx.lineCap = 'square';
        snapshotCtx.lineJoin = 'miter';
        snapshotCtx.strokeRect(item.startPos.x, item.startPos.y, item.endPos.x - item.startPos.x, item.endPos.y - item.startPos.y);
        snapshotCtx.globalAlpha = 1;
      } else if (item.type === 'clear') {
        snapshotCtx.fillStyle = '#FFFFFF';
        snapshotCtx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
      }
    }
    checkpointIndex = targetIndex;
  }

  function renderHistory() {
    activeStrokes = {};
    buildSnapshotCheckpoint();
    
    let startIndex = 0;
    if (checkpointIndex >= 0 && checkpointIndex < eventsHistory.length) {
      ctx.drawImage(snapshotCanvas, 0, 0);
      startIndex = checkpointIndex + 1;
    } else {
      checkpointIndex = -1;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    
    for (let i = startIndex; i < eventsHistory.length; i++) {
      const item = eventsHistory[i];
      if (item.type === 'stroke') {
        drawSingleStrokeTo(ctx, item);
      } else if (item.type === 'fill') {
        floodFill(item.pos.x, item.pos.y, hexToRgb(item.color));
      } else if (item.type === 'square') {
        ctx.globalAlpha = item.opacity || 1;
        ctx.strokeStyle = item.color;
        ctx.lineWidth = item.size;
        ctx.lineCap = 'square';
        ctx.lineJoin = 'miter';
        ctx.strokeRect(item.startPos.x, item.startPos.y, item.endPos.x - item.startPos.x, item.endPos.y - item.startPos.y);
        ctx.globalAlpha = 1;
      } else if (item.type === 'clear') {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    }
    drawActiveStrokes();
  }

  // --- Local Drawing State ---
  let isDrawing = false;
  let currentTool = 'pen';
  let currentColor = '#000000';
  let penSize = 8;
  let eraserSize = 30;
  let currentSize = penSize;
  let currentOpacity = 1;
  let currentStrokeId = null;
  let startPos = null;

  let lastKnownPos = null;
  function getCoordinates(e) {
    if (!e) return lastKnownPos || { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    let clientX = e.clientX;
    let clientY = e.clientY;
    
    // Guard against tablet touch release zero-coordinate artifacts
    if (clientX === undefined || clientY === undefined || (clientX === 0 && clientY === 0)) {
      if (lastKnownPos) return lastKnownPos;
    }
    
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const pos = {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
    lastKnownPos = pos;
    return pos;
  }

  function getNormalizedCursorPos(e) {
    const rect = canvas.getBoundingClientRect();
    if (!e || e.clientX === undefined) return { x: 0, y: 0 };
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height
    };
  }

  function emitAndProcess(msg) {
    eventsHistory.push(msg);
    processEvent(msg);
    broadcast(msg);
  }

  // Helpers
  function hexToRgb(hex) {
    const bigint = parseInt(hex.slice(1), 16);
    return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255, a: 255 };
  }

  function updateColorUI(hex) {
    const customColorPicker = document.getElementById('current-color-picker');
    if (customColorPicker) customColorPicker.value = hex;
    
    document.querySelectorAll('.color-btn').forEach(b => {
      b.classList.remove('active');
      if (b.dataset.color && b.dataset.color.toUpperCase() === hex.toUpperCase()) b.classList.add('active');
    });
  }

  function pickColorInteractive(x, y) {
    const imgData = ctx.getImageData(x, y, 1, 1).data;
    if (imgData[3] > 0) {
      const hex = "#" + (1 << 24 | imgData[0] << 16 | imgData[1] << 8 | imgData[2]).toString(16).slice(1).toUpperCase();
      currentColor = hex;
      updateColorUI(hex);
    }
  }

  function floodFill(startX, startY, fillColor, targetCtx = ctx) {
    startX = Math.floor(startX);
    startY = Math.floor(startY);
    const imageData = targetCtx.getImageData(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;
    const targetIdx = (startY * width + startX) * 4;
    const targetColor = { r: data[targetIdx], g: data[targetIdx + 1], b: data[targetIdx + 2], a: data[targetIdx + 3] };
    
    if (targetColor.r === fillColor.r && targetColor.g === fillColor.g && targetColor.b === fillColor.b) return;

    const pixelsToCheck = [startX, startY];
    function matchStartColor(pos) {
      return data[pos]===targetColor.r && data[pos+1]===targetColor.g && data[pos+2]===targetColor.b && data[pos+3]===targetColor.a;
    }
    function colorPixel(pos) {
      data[pos] = fillColor.r; data[pos+1] = fillColor.g; data[pos+2] = fillColor.b; data[pos+3] = 255;
    }

    while (pixelsToCheck.length > 0) {
      const y = pixelsToCheck.pop();
      let x = pixelsToCheck.pop();
      let pos = (y * width + x) * 4;
      while (x-- >= 0 && matchStartColor(pos)) pos -= 4;
      pos += 4; x++;
      let reachAbove = false, reachBelow = false;
      while (x++ < width && matchStartColor(pos)) {
        colorPixel(pos);
        if (y > 0) {
          if (matchStartColor(pos - width * 4)) {
            if (!reachAbove) { pixelsToCheck.push(x, y - 1); reachAbove = true; }
          } else if (reachAbove) reachAbove = false;
        }
        if (y < height - 1) {
          if (matchStartColor(pos + width * 4)) {
            if (!reachBelow) { pixelsToCheck.push(x, y + 1); reachBelow = true; }
          } else if (reachBelow) reachBelow = false;
        }
        pos += 4;
      }
    }
    targetCtx.putImageData(imageData, 0, 0);
  }

  // Pointer Events
  function startDrawing(e) {
    if (e.button !== 0 && e.button !== undefined) return;
    
    isDrawing = true;
    startPos = getCoordinates(e);
    currentStrokeId = Math.random().toString(36).slice(2);
    
    myRedoStack = []; // Clear redo stack on new action
    
    if (currentTool === 'fill') {
      emitAndProcess({ type: 'fill', strokeId: currentStrokeId, userId, color: currentColor, opacity: currentOpacity, pos: startPos });
      myStrokes.push(currentStrokeId);
      isDrawing = false;
      return;
    } else if (currentTool === 'picker') {
      pickColorInteractive(startPos.x, startPos.y);
      canvas.setPointerCapture(e.pointerId);
      return;
    } else if (currentTool !== 'square') {
      activeStrokes[currentStrokeId] = {
        strokeId: currentStrokeId,
        userId,
        tool: currentTool,
        color: currentColor,
        opacity: currentOpacity,
        size: currentSize,
        points: [startPos]
      };
      if (currentTool === 'eraser') {
        drawSingleStrokeTo(ctx, activeStrokes[currentStrokeId]);
      } else {
        drawActiveStrokes();
      }
      broadcast({ type: 'draw_live', strokeId: currentStrokeId, tool: currentTool, color: currentColor, opacity: currentOpacity, size: currentSize, pos: startPos });
    }
    canvas.setPointerCapture(e.pointerId);
  }

  let previewShape = null; // Temp state for local square preview

  let lastCursorSend = 0;
  function draw(e) {
    // Broadcast cursor position (Throttled to 20 times a second to save bandwidth)
    const normPos = getNormalizedCursorPos(e);
    if (normPos.x >= 0 && normPos.x <= 1 && normPos.y >= 0 && normPos.y <= 1) {
      const now = Date.now();
      if (now - lastCursorSend > 50) {
        broadcast({ type: 'cursor', id: userId, name: userName, color: userColor, pos: normPos });
        lastCursorSend = now;
      }
    }

    if (!isDrawing) return;
    
    if (currentTool === 'picker') {
      const pos = getCoordinates(e);
      pickColorInteractive(pos.x, pos.y);
      return;
    }
    
    if (currentTool === 'square') {
      // Local preview only, no broadcast yet
      const currentPos = getCoordinates(e);
      previewShape = { color: currentColor, opacity: currentOpacity, size: currentSize, startPos, endPos: currentPos };
      drawActiveStrokes();
      updateBrushPreview(e);
      return;
    }
    
    updateBrushPreview(e);
    
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (let ev of events) {
      const pos = getCoordinates(ev);
      if (activeStrokes[currentStrokeId]) {
        activeStrokes[currentStrokeId].points.push(pos);
        if (currentTool === 'eraser') {
          drawSingleStrokeTo(ctx, activeStrokes[currentStrokeId]);
        } else {
          drawActiveStrokes();
        }
        broadcast({ type: 'draw_live', strokeId: currentStrokeId, tool: currentTool, color: currentColor, opacity: currentOpacity, size: currentSize, pos });
      }
    }
  }

  function stopDrawing(e) {
    if (!isDrawing) return;
    
    if (currentTool === 'picker') {
      isDrawing = false;
      canvas.releasePointerCapture(e.pointerId);
      setActiveTool('pen', document.getElementById('btn-pen'));
      return;
    }
    
    if (currentTool === 'square') {
      const endPos = getCoordinates(e);
      previewShape = null; // Clear preview temp
      drawActiveStrokes(); // Clean active canvas
      emitAndProcess({ type: 'square', strokeId: currentStrokeId, userId, color: currentColor, opacity: currentOpacity, size: currentSize, startPos, endPos });
      myStrokes.push(currentStrokeId);
      isDrawing = false;
      canvas.releasePointerCapture(e.pointerId);
      return;
    }
    
    if (activeStrokes[currentStrokeId]) {
      const strokeObj = {
        type: 'stroke',
        strokeId: currentStrokeId,
        userId,
        tool: activeStrokes[currentStrokeId].tool,
        color: activeStrokes[currentStrokeId].color,
        opacity: activeStrokes[currentStrokeId].opacity,
        size: activeStrokes[currentStrokeId].size,
        points: activeStrokes[currentStrokeId].points
      };
      delete activeStrokes[currentStrokeId];
      drawActiveStrokes();
      emitAndProcess(strokeObj);
      myStrokes.push(currentStrokeId);
    }
    
    isDrawing = false;
    canvas.releasePointerCapture(e.pointerId);
  }

  activeCanvas.addEventListener('pointerdown', startDrawing);
  activeCanvas.addEventListener('pointermove', draw);
  activeCanvas.addEventListener('pointerup', stopDrawing);
  activeCanvas.addEventListener('pointercancel', stopDrawing);

  // Brush Preview Cursor UI
  const brushPreview = document.getElementById('brush-preview');

  function updateBrushPreview(e) {
    if (!brushPreview) return;
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / LOGICAL_WIDTH;
    const displaySize = Math.max(4, currentSize * scale);
    
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    if (x < 0 || x > rect.width || y < 0 || y > rect.height) {
      brushPreview.style.display = 'none';
      return;
    }
    
    brushPreview.style.display = 'block';
    brushPreview.style.left = `${x}px`;
    brushPreview.style.top = `${y}px`;
    brushPreview.style.width = `${displaySize}px`;
    brushPreview.style.height = `${displaySize}px`;

    if (currentTool === 'eraser') {
      brushPreview.style.backgroundColor = 'rgba(255, 255, 255, 0.4)';
    } else if (currentTool === 'pen' || currentTool === 'square') {
      const rgb = hexToRgb(currentColor);
      brushPreview.style.backgroundColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${currentOpacity * 0.5})`;
    } else {
      brushPreview.style.backgroundColor = 'transparent';
    }
  }

  activeCanvas.addEventListener('pointerenter', (e) => {
    if (brushPreview) brushPreview.style.display = 'block';
  });
  activeCanvas.addEventListener('pointerleave', () => {
    if (brushPreview) brushPreview.style.display = 'none';
  });

  // --- Remote Cursors UI ---
  const cursorContainer = document.createElement('div');
  cursorContainer.id = 'cursor-container';
  cursorContainer.style.position = 'absolute';
  cursorContainer.style.top = '0';
  cursorContainer.style.left = '0';
  cursorContainer.style.width = '100%';
  cursorContainer.style.height = '100%';
  cursorContainer.style.pointerEvents = 'none';
  canvas.parentElement.appendChild(cursorContainer);
  canvas.parentElement.style.position = 'relative';

  const remoteCursors = {}; // id -> HTMLElement

  function updateRemoteCursor(id, data) {
    const curColor = data.color || '#FF3B30';
    if (!remoteCursors[id]) {
      const el = document.createElement('div');
      el.style.position = 'absolute';
      el.style.transition = 'transform 0.05s linear';
      el.style.zIndex = '50';
      el.innerHTML = `
        <div style="position:relative;">
          <svg class="remote-cursor-svg" width="24" height="24" viewBox="0 0 24 24" fill="none" style="position:absolute; left:-12px; top:-12px; filter: drop-shadow(0px 2px 2px rgba(0,0,0,0.3));">
            <path class="cursor-path" d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87c.45 0 .67-.54.35-.85L6.35 2.85a.5.5 0 0 0-.85.35Z" fill="${curColor}" stroke="white" stroke-width="2"/>
          </svg>
          <div class="remote-name-tag" style="position:absolute; left:0px; top:12px; background:${curColor}; color:white; padding:2px 6px; border-radius:4px; font-size:12px; font-weight:bold; white-space:nowrap; box-shadow: 0 2px 4px rgba(0,0,0,0.2);">
            ${data.name}
          </div>
        </div>
      `;
      cursorContainer.appendChild(el);
      remoteCursors[id] = el;
    } else {
      // Dynamic updates if nickname or color changed
      const path = remoteCursors[id].querySelector('.cursor-path');
      const tag = remoteCursors[id].querySelector('.remote-name-tag');
      if (path) path.setAttribute('fill', curColor);
      if (tag) {
        tag.style.background = curColor;
        tag.textContent = data.name;
      }
    }
    
    // Position via CSS transform based on normalized coordinates
    const rect = canvas.getBoundingClientRect();
    const x = data.pos.x * rect.width;
    const y = data.pos.y * rect.height;
    remoteCursors[id].style.transform = `translate(${x}px, ${y}px)`;
  }

  function removeRemoteCursor(id) {
    if (remoteCursors[id]) {
      remoteCursors[id].remove();
      delete remoteCursors[id];
    }
  }

  // --- UI Logic ---
  const btnPen = document.getElementById('btn-pen');
  const btnEraser = document.getElementById('btn-eraser');
  const btnFill = document.getElementById('btn-fill');
  const btnSquare = document.getElementById('btn-square');
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');
  const btnPicker = document.getElementById('btn-picker');
  const btnClear = document.getElementById('btn-clear');
  
  let myRedoStack = []; // Stores { strokeId, events: [] }

  function setActiveTool(tool, btn) {
    if (!btn) return;
    
    // Save current size to previous tool
    if (currentTool === 'eraser') {
      eraserSize = currentSize;
    } else {
      penSize = currentSize;
    }
    
    currentTool = tool;
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Switch size slider smoothly to the selected tool's size
    if (currentTool === 'eraser') {
      updateSize(eraserSize);
    } else {
      updateSize(penSize);
    }
  }

  btnPen.addEventListener('click', () => setActiveTool('pen', btnPen));
  btnEraser.addEventListener('click', () => setActiveTool('eraser', btnEraser));
  btnFill.addEventListener('click', () => setActiveTool('fill', btnFill));
  btnSquare.addEventListener('click', () => setActiveTool('square', btnSquare));
  btnPicker.addEventListener('click', () => setActiveTool('picker', btnPicker));
  
  btnUndo.addEventListener('click', () => {
    // Only undo my strokes!
    if (myStrokes.length > 0) {
      const lastStrokeId = myStrokes.pop();
      
      // Save to redo stack before deleting
      const undoneEvents = eventsHistory.filter(e => e.strokeId === lastStrokeId);
      myRedoStack.push({ strokeId: lastStrokeId, events: undoneEvents });

      // Inform others to remove this stroke
      broadcast({ type: 'undo', strokeId: lastStrokeId, userId });
      
      // Remove locally and re-render
      eventsHistory = eventsHistory.filter(e => e.strokeId !== lastStrokeId);
      renderHistory();
    }
  });

  // Enable Redo!
  btnRedo.style.opacity = '1';
  btnRedo.style.cursor = 'pointer';
  btnRedo.addEventListener('click', () => {
    if (myRedoStack.length > 0) {
      const redoItem = myRedoStack.pop();
      
      // Add back to myStrokes so it can be undone again
      myStrokes.push(redoItem.strokeId);
      
      // Re-broadcast all events of this stroke to the server and local canvas
      redoItem.events.forEach(ev => {
        eventsHistory.push(ev);
        processEvent(ev); // draw locally
        broadcast(ev);    // send to server
      });
    }
  });
  
  btnClear.addEventListener('click', () => {
    if (confirm("정말 화면을 모두 지우시겠습니까?")) {
      const msg = { type: 'clear', userId };
      emitAndProcess(msg);
      myRedoStack = []; // Clear redo stack on full clear
    }
  });

  // Colors
  const customColorPicker = document.getElementById('current-color-picker');
  if (customColorPicker) {
    customColorPicker.addEventListener('input', (e) => {
      currentColor = e.target.value.toUpperCase();
      updateColorUI(currentColor);
      if (currentTool === 'eraser') setActiveTool('pen', btnPen);
    });
  }

  const colorBtns = document.querySelectorAll('.color-btn');
  colorBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      currentColor = btn.dataset.color.toUpperCase();
      updateColorUI(currentColor);
      if (currentTool === 'eraser') {
        setActiveTool('pen', btnPen);
      }
    });
  });

  // Size
  const sizeSlider = document.getElementById('size-slider');
  const sizeIndicator = document.getElementById('size-indicator');
  
  function updateSize(val) {
    currentSize = parseInt(val, 10);
    if (currentTool === 'eraser') {
      eraserSize = currentSize;
    } else {
      penSize = currentSize;
    }
    if (sizeSlider) sizeSlider.value = currentSize;
    if (sizeIndicator) {
      const scale = Math.max(0.2, currentSize / 10);
      sizeIndicator.style.transform = `scale(${scale})`;
    }
  }

  if (sizeSlider) {
    sizeSlider.addEventListener('input', (e) => {
      updateSize(e.target.value);
    });
    updateSize(currentSize);
  }

  // Opacity
  const opacitySlider = document.getElementById('opacity-slider');
  const opacityIndicator = document.getElementById('opacity-indicator');
  
  function updateOpacity(val) {
    currentOpacity = parseFloat(val);
    if (opacitySlider) opacitySlider.value = currentOpacity;
    if (opacityIndicator) {
      opacityIndicator.style.opacity = currentOpacity;
    }
  }

  if (opacitySlider) {
    opacitySlider.addEventListener('input', (e) => {
      updateOpacity(e.target.value);
    });
    updateOpacity(currentOpacity);
  }

  // User Profile Settings
  const userNameInput = document.getElementById('user-name-input');
  const userColorPicker = document.getElementById('user-color-picker');

  if (userNameInput) {
    userNameInput.value = userName;
    userNameInput.addEventListener('input', (e) => {
      userName = e.target.value.trim() || "익명";
    });
  }

  if (userColorPicker) {
    userColorPicker.value = userColor;
    userColorPicker.addEventListener('input', (e) => {
      userColor = e.target.value;
    });
  }
});
