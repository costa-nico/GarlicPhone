document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('drawing-canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  
  // Logical resolution setup (Fixed 4:3)
  const LOGICAL_WIDTH = 1600;
  const LOGICAL_HEIGHT = 1200;
  canvas.width = LOGICAL_WIDTH;
  canvas.height = LOGICAL_HEIGHT;
  
  // Set context properties
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Multiplayer State
  const userId = Math.random().toString(36).slice(2, 10);
  const userName = prompt("사용할 닉네임을 입력하세요", "익명") || "익명";
  
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
    } else if (ev.type === 'start') {
      activeStrokes[ev.strokeId] = { ...ev, points: [ev.pos] };
      ctx.beginPath();
      ctx.fillStyle = ev.tool === 'eraser' ? '#FFFFFF' : ev.color;
      ctx.arc(ev.pos.x, ev.pos.y, ev.size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (ev.type === 'draw') {
      const stroke = activeStrokes[ev.strokeId];
      if (stroke) {
        stroke.points.push(ev.pos);
        drawStrokeSegment(stroke, stroke.points.length - 1);
      }
    } else if (ev.type === 'end') {
      delete activeStrokes[ev.strokeId];
    } else if (ev.type === 'fill') {
      floodFill(ev.pos.x, ev.pos.y, hexToRgb(ev.color));
    } else if (ev.type === 'square') {
      ctx.strokeStyle = ev.color;
      ctx.lineWidth = ev.size;
      ctx.lineCap = 'square';
      ctx.lineJoin = 'miter';
      ctx.strokeRect(ev.startPos.x, ev.startPos.y, ev.endPos.x - ev.startPos.x, ev.endPos.y - ev.startPos.y);
    }
  }

  function drawStrokeSegment(stroke, index) {
    const points = stroke.points;
    ctx.strokeStyle = stroke.tool === 'eraser' ? '#FFFFFF' : stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    if (points.length >= 3 && index >= 2) {
      const pt1 = points[index - 2], pt2 = points[index - 1], pt3 = points[index];
      const mid1 = { x: (pt1.x + pt2.x)/2, y: (pt1.y + pt2.y)/2 };
      const mid2 = { x: (pt2.x + pt3.x)/2, y: (pt2.y + pt3.y)/2 };
      ctx.beginPath(); ctx.moveTo(mid1.x, mid1.y);
      ctx.quadraticCurveTo(pt2.x, pt2.y, mid2.x, mid2.y); ctx.stroke();
    } else if (points.length === 2 && index === 1) {
      const pt1 = points[0], pt2 = points[1];
      const mid = { x: (pt1.x + pt2.x)/2, y: (pt1.y + pt2.y)/2 };
      ctx.beginPath(); ctx.moveTo(pt1.x, pt1.y);
      ctx.lineTo(mid.x, mid.y); ctx.stroke();
    }
  }

  function renderHistory() {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    activeStrokes = {};
    for (let ev of eventsHistory) {
      processEvent(ev);
    }
  }

  // --- Local Drawing State ---
  let isDrawing = false;
  let currentTool = 'pen';
  let currentColor = '#000000';
  let currentSize = 8;
  let currentStrokeId = null;
  let startPos = null;

  function getCoordinates(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  }

  function getNormalizedCursorPos(e) {
    const rect = canvas.getBoundingClientRect();
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

  function floodFill(startX, startY, fillColor) {
    startX = Math.floor(startX);
    startY = Math.floor(startY);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
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
    ctx.putImageData(imageData, 0, 0);
  }

  // Pointer Events
  function startDrawing(e) {
    if (e.button !== 0 && e.button !== undefined) return;
    
    isDrawing = true;
    startPos = getCoordinates(e);
    currentStrokeId = Math.random().toString(36).slice(2);
    
    myRedoStack = []; // Clear redo stack on new action
    
    if (currentTool === 'fill') {
      emitAndProcess({ type: 'fill', strokeId: currentStrokeId, userId, color: currentColor, pos: startPos });
      myStrokes.push(currentStrokeId);
      isDrawing = false;
      return;
    } else if (currentTool === 'picker') {
      pickColorInteractive(startPos.x, startPos.y);
      canvas.setPointerCapture(e.pointerId);
      return;
    } else if (currentTool !== 'square') {
      emitAndProcess({ type: 'start', strokeId: currentStrokeId, userId, tool: currentTool, color: currentColor, size: currentSize, pos: startPos });
      myStrokes.push(currentStrokeId);
    }
    canvas.setPointerCapture(e.pointerId);
  }

  let savedStateBeforeShape = null; // Temp state for local square preview

  let lastCursorSend = 0;
  function draw(e) {
    // Broadcast cursor position (Throttled to 20 times a second to save bandwidth)
    const normPos = getNormalizedCursorPos(e);
    if (normPos.x >= 0 && normPos.x <= 1 && normPos.y >= 0 && normPos.y <= 1) {
      const now = Date.now();
      if (now - lastCursorSend > 50) {
        broadcast({ type: 'cursor', id: userId, name: userName, pos: normPos });
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
      if (!savedStateBeforeShape) savedStateBeforeShape = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const currentPos = getCoordinates(e);
      ctx.putImageData(savedStateBeforeShape, 0, 0);
      ctx.strokeStyle = currentColor;
      ctx.lineWidth = currentSize;
      ctx.lineCap = 'square';
      ctx.lineJoin = 'miter';
      ctx.strokeRect(startPos.x, startPos.y, currentPos.x - startPos.x, currentPos.y - startPos.y);
      return;
    }
    
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (let ev of events) {
      const pos = getCoordinates(ev);
      emitAndProcess({ type: 'draw', strokeId: currentStrokeId, pos });
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
      savedStateBeforeShape = null; // Clear preview temp
      // Restore without the temp drawing to cleanly apply via emitAndProcess
      renderHistory(); 
      emitAndProcess({ type: 'square', strokeId: currentStrokeId, userId, color: currentColor, size: currentSize, startPos, endPos });
      myStrokes.push(currentStrokeId);
      isDrawing = false;
      canvas.releasePointerCapture(e.pointerId);
      return;
    }
    
    emitAndProcess({ type: 'end', strokeId: currentStrokeId });
    isDrawing = false;
    canvas.releasePointerCapture(e.pointerId);
  }

  canvas.addEventListener('pointerdown', startDrawing);
  canvas.addEventListener('pointermove', draw);
  canvas.addEventListener('pointerup', stopDrawing);
  canvas.addEventListener('pointercancel', stopDrawing);
  canvas.addEventListener('pointerout', (e) => {
    stopDrawing(e);
    broadcast({ type: 'disconnect', id: userId });
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
    if (!remoteCursors[id]) {
      const el = document.createElement('div');
      el.style.position = 'absolute';
      el.style.transition = 'transform 0.05s linear';
      el.innerHTML = `
        <div style="position:relative;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="position:absolute; left:-12px; top:-12px; filter: drop-shadow(0px 2px 2px rgba(0,0,0,0.3));">
            <path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87c.45 0 .67-.54.35-.85L6.35 2.85a.5.5 0 0 0-.85.35Z" fill="#ff3b30" stroke="white" stroke-width="2"/>
          </svg>
          <div style="position:absolute; left:0px; top:12px; background:#ff3b30; color:white; padding:2px 6px; border-radius:4px; font-size:12px; font-weight:bold; white-space:nowrap; box-shadow: 0 2px 4px rgba(0,0,0,0.2);">
            ${data.name}
          </div>
        </div>
      `;
      cursorContainer.appendChild(el);
      remoteCursors[id] = el;
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
    currentTool = tool;
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
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
});
