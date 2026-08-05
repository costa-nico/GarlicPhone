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

  // Multiplayer State (Restored from localStorage if available)
  let userId = localStorage.getItem('garlic_user_id');
  if (!userId) {
    userId = Math.random().toString(36).slice(2, 10);
    localStorage.setItem('garlic_user_id', userId);
  }
  const vibrantColors = ['#FF3B30', '#FF9500', '#FFCC00', '#4CD964', '#5AC8FA', '#007AFF', '#5856D6', '#FF2D55'];
  let userColor = localStorage.getItem('garlic_nametag_color') || vibrantColors[Math.floor(Math.random() * vibrantColors.length)];
  let userName = localStorage.getItem('garlic_user_name') || ("익명" + Math.floor(Math.random() * 90 + 10));
  
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
      checkpointIndex = -1;
      eventsHistory = msg.history;
      renderHistory();
      // Remove stale remote cursors that are no longer active
      Object.keys(remoteCursors).forEach(id => {
        if (!msg.users || !msg.users[id]) {
          removeRemoteCursor(id);
        }
      });
      // Handle active remote cursors
      Object.keys(msg.users || {}).forEach(id => {
        if (id !== userId) updateRemoteCursor(id, msg.users[id]);
      });
      updateOnlineUserCount();
    } else if (msg.type === 'cursor') {
      if (msg.id !== userId) updateRemoteCursor(msg.id, msg);
    } else if (msg.type === 'disconnect') {
      removeRemoteCursor(msg.id);
    } else if (msg.type === 'undo') {
      checkpointIndex = -1;
      eventsHistory = eventsHistory.filter(e => e.strokeId !== msg.strokeId);
      renderHistory();
    } else if (msg.type === 'chat') {
      spawnDanmakuMessage(msg.text, msg.name, msg.color);
      return;
    } else if (msg.type === 'emoji_burst') {
      spawnEmojiBurst(msg.emoji);
      return;
    } else if (msg.type === 'cursor' && msg.id !== userId) {
      if (msg.pos) {
        remoteCursors[msg.id] = {
          id: msg.id,
          name: msg.name || '상대방',
          color: msg.color || '#FF9500',
          pos: msg.pos,
          size: msg.size || 8,
          tool: msg.tool || 'pen',
          lastSeen: Date.now()
        };
        drawActiveStrokes();
      }
      return;
    } else if (msg.type === 'clear') {
      checkpointIndex = -1;
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
      resetLasso();
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
    } else if (ev.type === 'fill' || ev.type === 'square' || ev.type === 'lasso_paste') {
      drawHistoryItem(ctx, ev);
    }
  }

  function drawHistoryItem(targetCtx, item) {
    if (item.type === 'stroke') {
      drawSingleStrokeTo(targetCtx, item);
    } else if (item.type === 'fill') {
      floodFill(item.pos.x, item.pos.y, hexToRgb(item.color), targetCtx);
    } else if (item.type === 'square') {
      targetCtx.globalAlpha = item.opacity || 1;
      targetCtx.strokeStyle = item.color;
      targetCtx.lineWidth = item.size;
      targetCtx.lineCap = 'square';
      targetCtx.lineJoin = 'miter';
      targetCtx.strokeRect(item.startPos.x, item.startPos.y, item.endPos.x - item.startPos.x, item.endPos.y - item.startPos.y);
      targetCtx.globalAlpha = 1;
    } else if (item.type === 'clear') {
      targetCtx.fillStyle = '#FFFFFF';
      targetCtx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    } else if (item.type === 'lasso_paste') {
      // 1. Fill original cutout area (srcPath) with white
      targetCtx.save();
      targetCtx.beginPath();
      const path = item.srcPath || item.path;
      if (path && path.length > 0) {
        path.forEach((pt, idx) => {
          if (idx === 0) targetCtx.moveTo(pt.x, pt.y);
          else targetCtx.lineTo(pt.x, pt.y);
        });
      }
      targetCtx.closePath();
      targetCtx.clip();
      targetCtx.fillStyle = '#FFFFFF';
      targetCtx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
      targetCtx.restore();
      
      // 2. Draw cutout image at new destination
      const dstX = Math.round(item.dstPos.x);
      const dstY = Math.round(item.dstPos.y);
      if (item._img && (item._img.complete || item._img instanceof HTMLCanvasElement)) {
        try {
          targetCtx.drawImage(item._img, dstX, dstY);
        } catch(err) {}
      } else if (item.dataUrl) {
        const img = new Image();
        img.onload = () => {
          item._img = img;
          try {
            targetCtx.drawImage(img, dstX, dstY);
            drawActiveStrokes();
          } catch(err) {}
        };
        img.src = item.dataUrl;
        if (img.complete) {
          item._img = img;
          try {
            targetCtx.drawImage(img, dstX, dstY);
          } catch(err) {}
        }
      }
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

    // Render active Lasso selection UI
    if (lassoState === 'selecting' && lassoPath.length > 0) {
      activeCtx.save();
      activeCtx.strokeStyle = '#007AFF';
      activeCtx.lineWidth = 2;
      activeCtx.setLineDash([6, 6]);
      activeCtx.beginPath();
      lassoPath.forEach((pt, idx) => {
        if (idx === 0) activeCtx.moveTo(pt.x, pt.y);
        else activeCtx.lineTo(pt.x, pt.y);
      });
      activeCtx.stroke();
      activeCtx.restore();
    } else if ((lassoState === 'selected' || lassoState === 'dragging') && lassoCutoutCanvas && lassoBoundingBox) {
      const offsetX = Math.round(lassoBoundingBox.minX + lassoDragOffset.x);
      const offsetY = Math.round(lassoBoundingBox.minY + lassoDragOffset.y);
      
      activeCtx.drawImage(lassoCutoutCanvas, offsetX, offsetY);
      
      activeCtx.save();
      activeCtx.strokeStyle = '#007AFF';
      activeCtx.lineWidth = 2;
      activeCtx.setLineDash([6, 6]);
      activeCtx.beginPath();
      lassoPath.forEach((pt, idx) => {
        const px = pt.x + lassoDragOffset.x;
        const py = pt.y + lassoDragOffset.y;
        if (idx === 0) activeCtx.moveTo(px, py);
        else activeCtx.lineTo(px, py);
      });
      activeCtx.closePath();
      activeCtx.stroke();
      activeCtx.restore();
    }

    // Render Real-Time Remote Cursors (상대방 펜 커서 & 닉네임 태그)
    renderRemoteCursors();
  }

  let remoteCursors = {}; // userId -> { id, name, color, pos, size, tool, lastSeen }

  function renderRemoteCursors() {
    const now = Date.now();
    Object.keys(remoteCursors).forEach(id => {
      const cur = remoteCursors[id];
      if (now - cur.lastSeen > 3000) {
        delete remoteCursors[id];
        return;
      }

      if (!cur.pos) return;
      const { x, y } = cur.pos;
      const radius = Math.max(5, (cur.size || 8) / 2);

      activeCtx.save();

      // 1. Draw brush cursor ring matching remote user's color
      activeCtx.strokeStyle = cur.color || '#FF9500';
      activeCtx.lineWidth = 2.5;
      activeCtx.beginPath();
      activeCtx.arc(x, y, radius, 0, Math.PI * 2);
      activeCtx.stroke();

      // 2. Draw crosshair center dot
      activeCtx.fillStyle = cur.color || '#FF9500';
      activeCtx.beginPath();
      activeCtx.arc(x, y, 2.5, 0, Math.PI * 2);
      activeCtx.fill();

      // 3. Draw nickname badge pill tag [Name] above cursor
      const label = cur.name || '상대방';
      activeCtx.font = 'bold 15px sans-serif';
      const textWidth = activeCtx.measureText(label).width;
      const tagPadding = 8;
      const tagWidth = textWidth + tagPadding * 2;
      const tagHeight = 22;
      const tagX = x - tagWidth / 2;
      const tagY = y - radius - tagHeight - 8;

      // Outer Shadow
      activeCtx.shadowColor = 'rgba(0,0,0,0.4)';
      activeCtx.shadowBlur = 6;
      activeCtx.shadowOffsetY = 2;

      // Tag Background Pill
      activeCtx.fillStyle = cur.color || '#FF9500';
      activeCtx.beginPath();
      if (activeCtx.roundRect) {
        activeCtx.roundRect(tagX, tagY, tagWidth, tagHeight, 11);
      } else {
        activeCtx.rect(tagX, tagY, tagWidth, tagHeight);
      }
      activeCtx.fill();

      // Tag Text
      activeCtx.shadowColor = 'transparent';
      activeCtx.fillStyle = '#FFFFFF';
      activeCtx.textAlign = 'center';
      activeCtx.textBaseline = 'middle';
      activeCtx.fillText(label, x, tagY + tagHeight / 2 + 1);

      activeCtx.restore();
    });
  }

  function buildSnapshotCheckpoint() {
    const CHECKPOINT_INTERVAL = 30;
    if (eventsHistory.length < CHECKPOINT_INTERVAL) {
      checkpointIndex = -1;
      return;
    }
    
    const targetIndex = Math.floor(eventsHistory.length / CHECKPOINT_INTERVAL) * CHECKPOINT_INTERVAL - 1;
    if (targetIndex === checkpointIndex) return;
    
    snapshotCtx.fillStyle = '#FFFFFF';
    snapshotCtx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    for (let i = 0; i <= targetIndex; i++) {
      drawHistoryItem(snapshotCtx, eventsHistory[i]);
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
      drawHistoryItem(ctx, eventsHistory[i]);
    }

    // Mask out original lasso selection area so history replay NEVER restores original image underneath
    if ((lassoState === 'selected' || lassoState === 'dragging') && originalLassoPath.length > 0) {
      ctx.save();
      ctx.beginPath();
      originalLassoPath.forEach((pt, idx) => {
        if (idx === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      });
      ctx.closePath();
      ctx.clip();
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
      ctx.restore();
    }

    drawActiveStrokes();
  }

  // --- Local Drawing State (Restored from localStorage if available) ---
  let isDrawing = false;
  let currentTool = 'pen';
  let currentColor = localStorage.getItem('garlic_pen_color') || '#000000';
  let penSize = parseInt(localStorage.getItem('garlic_pen_size'), 10) || 8;
  let eraserSize = parseInt(localStorage.getItem('garlic_eraser_size'), 10) || 30;
  let currentSize = penSize;
  let currentOpacity = parseFloat(localStorage.getItem('garlic_opacity'));
  if (isNaN(currentOpacity) || currentOpacity < 0.05 || currentOpacity > 1) currentOpacity = 1;
  let currentStrokeId = null;
  let startPos = null;

  // --- Lasso Tool State ---
  let lassoState = 'idle'; // 'idle', 'selecting', 'selected', 'dragging'
  let lassoPath = [];
  let originalLassoPath = []; // Stores original un-offset selection path for clearing source
  let lassoCutoutCanvas = null;
  let lassoBoundingBox = null; // { minX, minY, maxX, maxY }
  let lassoDragStart = null;
  let lassoDragOffset = { x: 0, y: 0 };

  function stampLassoSelection() {
    if (lassoState !== 'selected' && lassoState !== 'dragging') return;
    if (!lassoCutoutCanvas || !lassoBoundingBox) {
      resetLasso();
      return;
    }
    
    const finalX = Math.round(lassoBoundingBox.minX + lassoDragOffset.x);
    const finalY = Math.round(lassoBoundingBox.minY + lassoDragOffset.y);
    
    // Draw the cutout permanently onto main canvas
    ctx.drawImage(lassoCutoutCanvas, finalX, finalY);
    
    const strokeObj = {
      type: 'lasso_paste',
      strokeId: Math.random().toString(36).slice(2),
      userId,
      dataUrl: lassoCutoutCanvas.toDataURL(),
      dstPos: { x: finalX, y: finalY },
      srcPath: originalLassoPath,
      _img: lassoCutoutCanvas // Pre-attach canvas for instant 0ms local synchronous drawing
    };
    
    emitAndProcess(strokeObj);
    myStrokes.push(strokeObj.strokeId);
    checkpointIndex = -1;
    resetLasso();
  }

  function resetLasso() {
    lassoState = 'idle';
    lassoPath = [];
    originalLassoPath = [];
    lassoCutoutCanvas = null;
    lassoBoundingBox = null;
    lassoDragStart = null;
    lassoDragOffset = { x: 0, y: 0 };
    drawActiveStrokes();
  }

  function isPointInsideLasso(pt) {
    if (!lassoBoundingBox) return false;
    const curMinX = lassoBoundingBox.minX + lassoDragOffset.x;
    const curMaxX = lassoBoundingBox.maxX + lassoDragOffset.x;
    const curMinY = lassoBoundingBox.minY + lassoDragOffset.y;
    const curMaxY = lassoBoundingBox.maxY + lassoDragOffset.y;
    return pt.x >= curMinX && pt.x <= curMaxX && pt.y >= curMinY && pt.y <= curMaxY;
  }

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

  // Temporary Stylus Eraser State
  let isStylusEraserActive = false;
  let savedToolBeforeStylus = null;

  function checkStylusBarrelButton(e) {
    const isPen = e.pointerType === 'pen' || e.pointerType === 'stylus' || e.buttons === 2 || e.buttons === 5 || e.buttons === 32;
    const isBarrelPressed = (e.buttons & 2) !== 0 || (e.buttons & 32) !== 0 || e.button === 2 || e.button === 5;

    if (isPen && isBarrelPressed) {
      if (!isStylusEraserActive) {
        isStylusEraserActive = true;
        savedToolBeforeStylus = currentTool;
        setActiveTool('eraser', btnEraser);
      }
      return true;
    }
    return false;
  }

  function releaseStylusBarrelButton() {
    if (isStylusEraserActive) {
      isStylusEraserActive = false;
      if (savedToolBeforeStylus && savedToolBeforeStylus !== 'eraser') {
        const targetBtn = savedToolBeforeStylus === 'pen' ? btnPen :
                          savedToolBeforeStylus === 'fill' ? btnFill :
                          savedToolBeforeStylus === 'picker' ? btnPicker :
                          savedToolBeforeStylus === 'lasso' ? btnLasso : btnPen;
        setActiveTool(savedToolBeforeStylus, targetBtn);
      }
      savedToolBeforeStylus = null;
    }
  }

  // --- Canvas Zoom & Pan Engine (Zoom & D-Pad Widget) ---
  let canvasScale = 1.0;
  let canvasPanX = 0;
  let canvasPanY = 0;

  function updateCanvasTransform() {
    if (canvasScale === 1.0) {
      canvasPanX = 0;
      canvasPanY = 0;
    }
    const transformStr = (canvasScale === 1.0 && canvasPanX === 0 && canvasPanY === 0)
      ? ''
      : `translate(${canvasPanX}px, ${canvasPanY}px) scale(${canvasScale})`;
    
    canvas.style.transform = transformStr;
    activeCanvas.style.transform = transformStr;
    canvas.style.transformOrigin = 'center center';
    activeCanvas.style.transformOrigin = 'center center';

    const zoomText = document.getElementById('zoom-level-text');
    if (zoomText) {
      zoomText.textContent = `${Math.round(canvasScale * 100)}%`;
    }
  }

  function setCanvasZoom(newScale) {
    canvasScale = Math.min(4.0, Math.max(0.25, Math.round(newScale * 100) / 100));
    if (canvasScale === 1.0 && canvasPanX === 0 && canvasPanY === 0) {
      canvasPanX = 0;
      canvasPanY = 0;
    }
    updateCanvasTransform();
  }

  function panCanvas(dx, dy) {
    const step = 80;
    canvasPanX += dx * step;
    canvasPanY += dy * step;
    updateCanvasTransform();
  }

  // --- 360-Degree Interactive Analog Joystick Knob ---
  const joystickBase = document.getElementById('joystick-base');
  const joystickKnob = document.getElementById('joystick-knob');
  let isJoystickDragging = false;
  let joystickCenter = { x: 0, y: 0 };
  let joystickAnimationId = null;
  let joystickVector = { x: 0, y: 0 };

  function processJoystickPan() {
    if (isJoystickDragging) {
      const speed = 10 * Math.max(0.5, canvasScale / 2);
      canvasPanX -= joystickVector.x * speed; // INVERTED direction for intuitive camera panning!
      canvasPanY -= joystickVector.y * speed; // INVERTED direction for intuitive camera panning!
      updateCanvasTransform();
      joystickAnimationId = requestAnimationFrame(processJoystickPan);
    } else {
      joystickAnimationId = null;
    }
  }

  function startJoystickDrag(e) {
    if (!joystickBase || !joystickKnob) return;
    e.preventDefault();
    e.stopPropagation();
    isJoystickDragging = true;

    const rect = joystickBase.getBoundingClientRect();
    joystickCenter = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };

    try { joystickBase.setPointerCapture(e.pointerId); } catch(err) {}
    updateJoystickKnob(e);

    if (!joystickAnimationId) {
      joystickAnimationId = requestAnimationFrame(processJoystickPan);
    }
  }

  function updateJoystickKnob(e) {
    if (!isJoystickDragging) return;
    const dx = e.clientX - joystickCenter.x;
    const dy = e.clientY - joystickCenter.y;
    const dist = Math.hypot(dx, dy);

    const baseRect = joystickBase.getBoundingClientRect();
    const maxRadius = baseRect.width / 2 - 4; // Constrain knob within base

    let clampedX = dx;
    let clampedY = dy;
    if (dist > maxRadius) {
      clampedX = (dx / dist) * maxRadius;
      clampedY = (dy / dist) * maxRadius;
    }

    joystickKnob.style.transform = `translate(${clampedX}px, ${clampedY}px)`;
    joystickKnob.style.transition = 'none';

    joystickVector = {
      x: maxRadius > 0 ? clampedX / maxRadius : 0,
      y: maxRadius > 0 ? clampedY / maxRadius : 0
    };
  }

  function stopJoystickDrag(e) {
    if (!isJoystickDragging) return;
    isJoystickDragging = false;
    joystickVector = { x: 0, y: 0 };
    if (joystickKnob) {
      joystickKnob.style.transition = 'transform 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
      joystickKnob.style.transform = 'translate(0px, 0px)';
    }
    try { joystickBase.releasePointerCapture(e.pointerId); } catch(err) {}
  }

  if (joystickBase) {
    joystickBase.addEventListener('pointerdown', startJoystickDrag);
    joystickBase.addEventListener('pointermove', updateJoystickKnob);
    joystickBase.addEventListener('pointerup', stopJoystickDrag);
    joystickBase.addEventListener('pointercancel', stopJoystickDrag);
  }

  const btnZoomIn = document.getElementById('btn-zoom-in');
  const btnZoomOut = document.getElementById('btn-zoom-out');
  const btnZoomReset = document.getElementById('btn-zoom-reset');
  const zoomLevelText = document.getElementById('zoom-level-text');

  if (btnZoomIn) {
    btnZoomIn.addEventListener('click', (e) => {
      e.stopPropagation();
      setCanvasZoom(canvasScale + 0.25);
    });
  }

  if (btnZoomOut) {
    btnZoomOut.addEventListener('click', (e) => {
      e.stopPropagation();
      setCanvasZoom(canvasScale - 0.25);
    });
  }

  if (btnZoomReset) {
    btnZoomReset.addEventListener('click', (e) => {
      e.stopPropagation();
      canvasPanX = 0;
      canvasPanY = 0;
      setCanvasZoom(1.0);
    });
  }

  if (zoomLevelText) {
    zoomLevelText.addEventListener('click', (e) => {
      e.stopPropagation();
      canvasPanX = 0;
      canvasPanY = 0;
      setCanvasZoom(1.0);
    });
  }

  // Fullscreen Toggle for Tablets & Desktop
  const btnFullscreen = document.getElementById('btn-fullscreen');
  if (btnFullscreen) {
    btnFullscreen.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        const docEl = document.documentElement;
        if (docEl.requestFullscreen) {
          docEl.requestFullscreen();
        } else if (docEl.webkitRequestFullscreen) {
          docEl.webkitRequestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
      }
    });

    const updateFullscreenIcon = () => {
      const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement);
      btnFullscreen.textContent = isFull ? '✕' : '⛶';
      btnFullscreen.title = isFull ? "전체화면 종료 (Exit Fullscreen)" : "전체화면 전환 (Fullscreen)";
    };

    document.addEventListener('fullscreenchange', updateFullscreenIcon);
    document.addEventListener('webkitfullscreenchange', updateFullscreenIcon);
  }

  // Pointer Events
  function startDrawing(e) {
    const isStylusBarrel = checkStylusBarrelButton(e);
    if (!isStylusBarrel && e.button !== 0 && e.button !== undefined) return;
    
    isDrawing = true;
    startPos = getCoordinates(e);
    currentStrokeId = Math.random().toString(36).slice(2);
    
    myRedoStack = []; // Clear redo stack on new action
    
    if (currentTool === 'lasso') {
      if (lassoState === 'selected' && isPointInsideLasso(startPos)) {
        lassoState = 'dragging';
        lassoDragStart = startPos;
        activeCanvas.setPointerCapture(e.pointerId);
        return;
      }
      
      if (lassoState === 'selected' || lassoState === 'dragging') {
        stampLassoSelection();
      }
      
      lassoState = 'selecting';
      lassoPath = [startPos];
      drawActiveStrokes();
      activeCanvas.setPointerCapture(e.pointerId);
      return;
    }

    if (lassoState === 'selected' || lassoState === 'dragging') {
      stampLassoSelection();
    }
    
    if (currentTool === 'fill') {
      emitAndProcess({ type: 'fill', strokeId: currentStrokeId, userId, color: currentColor, opacity: currentOpacity, pos: startPos });
      myStrokes.push(currentStrokeId);
      isDrawing = false;
      return;
    } else if (currentTool === 'picker') {
      pickColorInteractive(startPos.x, startPos.y);
      activeCanvas.setPointerCapture(e.pointerId);
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
    try { activeCanvas.setPointerCapture(e.pointerId); } catch(err) {}
  }

  let previewShape = null; // Temp state for local square preview

  let lastCursorSend = 0;
  function draw(e) {
    // Broadcast cursor position (Logical coordinates, throttled to 30fps = ~35ms)
    const pos = getCoordinates(e);
    if (pos.x >= 0 && pos.x <= LOGICAL_WIDTH && pos.y >= 0 && pos.y <= LOGICAL_HEIGHT) {
      const now = Date.now();
      if (now - lastCursorSend > 35) {
        broadcast({
          type: 'cursor',
          id: userId,
          name: userName,
          color: userColor,
          pos: { x: Math.round(pos.x), y: Math.round(pos.y) },
          size: currentSize,
          tool: currentTool
        });
        lastCursorSend = now;
      }
    }

    // Update Local Brush Preview Cursor
    updateBrushPreview(e);

    if (!isDrawing) return;
    if (e.buttons === 0 && e.pointerType === 'mouse') {
      stopDrawing(e);
      return;
    }
    
    if (isDrawing) {
      checkStylusBarrelButton(e);
    }

    if (currentTool === 'lasso') {
      if (lassoState === 'selecting') {
        lassoPath.push(pos);
        drawActiveStrokes();
      } else if (lassoState === 'dragging') {
        lassoDragOffset = {
          x: Math.round(pos.x - lassoDragStart.x),
          y: Math.round(pos.y - lassoDragStart.y)
        };
        drawActiveStrokes();
      }
      return;
    }
    
    if (currentTool === 'picker') {
      pickColorInteractive(pos.x, pos.y);
      return;
    }
    
    if (currentTool === 'square') {
      previewShape = { color: currentColor, opacity: currentOpacity, size: currentSize, startPos, endPos: pos };
      drawActiveStrokes();
      updateBrushPreview(e);
      return;
    }
    
    updateBrushPreview(e);
    
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (let ev of events) {
      const p = getCoordinates(ev);
      if (activeStrokes[currentStrokeId]) {
        activeStrokes[currentStrokeId].points.push(p);
        if (currentTool === 'eraser') {
          drawSingleStrokeTo(ctx, activeStrokes[currentStrokeId]);
        } else {
          drawActiveStrokes();
        }
        broadcast({ type: 'draw_live', strokeId: currentStrokeId, tool: currentTool, color: currentColor, opacity: currentOpacity, size: currentSize, pos: p });
      }
    }
  }

  function stopDrawing(e) {
    if (!isDrawing) return;
    
    if (currentTool === 'lasso') {
      if (lassoState === 'selecting') {
        if (lassoPath.length > 5) {
          let rawMinX = Infinity, rawMinY = Infinity, rawMaxX = -Infinity, rawMaxY = -Infinity;
          lassoPath.forEach(pt => {
            if (pt.x < rawMinX) rawMinX = pt.x;
            if (pt.y < rawMinY) rawMinY = pt.y;
            if (pt.x > rawMaxX) rawMaxX = pt.x;
            if (pt.y > rawMaxY) rawMaxY = pt.y;
          });
          
          const minX = Math.floor(rawMinX);
          const minY = Math.floor(rawMinY);
          const maxX = Math.ceil(rawMaxX);
          const maxY = Math.ceil(rawMaxY);
          const width = maxX - minX;
          const height = maxY - minY;
          
          if (width >= 5 && height >= 5) {
            lassoBoundingBox = { minX, minY, maxX, maxY, width, height };
            originalLassoPath = JSON.parse(JSON.stringify(lassoPath)); // Clone original path
            
            lassoCutoutCanvas = document.createElement('canvas');
            lassoCutoutCanvas.width = width;
            lassoCutoutCanvas.height = height;
            const cCtx = lassoCutoutCanvas.getContext('2d');
            
            cCtx.beginPath();
            lassoPath.forEach((pt, idx) => {
              if (idx === 0) cCtx.moveTo(pt.x - minX, pt.y - minY);
              else cCtx.lineTo(pt.x - minX, pt.y - minY);
            });
            cCtx.closePath();
            cCtx.clip();
            cCtx.drawImage(canvas, -minX, -minY);
            
            ctx.save();
            ctx.beginPath();
            lassoPath.forEach((pt, idx) => {
              if (idx === 0) ctx.moveTo(pt.x, pt.y);
              else ctx.lineTo(pt.x, pt.y);
            });
            ctx.closePath();
            ctx.clip();
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
            ctx.restore();
            
            lassoState = 'selected';
            lassoDragOffset = { x: 0, y: 0 };
          } else {
            resetLasso();
          }
        } else {
          resetLasso();
        }
      } else if (lassoState === 'dragging') {
        lassoBoundingBox.minX += lassoDragOffset.x;
        lassoBoundingBox.minY += lassoDragOffset.y;
        lassoPath.forEach(pt => {
          pt.x += lassoDragOffset.x;
          pt.y += lassoDragOffset.y;
        });
        lassoDragOffset = { x: 0, y: 0 };
        lassoState = 'selected';
      }
      
      drawActiveStrokes();
      isDrawing = false;
      try { activeCanvas.releasePointerCapture(e.pointerId); } catch(err) {}
      return;
    }

    if (currentTool === 'picker') {
      isDrawing = false;
      try { activeCanvas.releasePointerCapture(e.pointerId); } catch(err) {}
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
      try { activeCanvas.releasePointerCapture(e.pointerId); } catch(err) {}
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
    releaseStylusBarrelButton();
    try { activeCanvas.releasePointerCapture(e.pointerId); } catch(err) {}
  }

  activeCanvas.addEventListener('pointerdown', startDrawing);
  activeCanvas.addEventListener('pointermove', draw);
  activeCanvas.addEventListener('pointerup', stopDrawing);
  activeCanvas.addEventListener('pointercancel', stopDrawing);
  window.addEventListener('pointerup', stopDrawing);
  window.addEventListener('pointercancel', stopDrawing);
  activeCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Brush Preview Cursor UI
  const brushPreview = document.getElementById('brush-preview');

  function updateBrushPreview(e) {
    if (!brushPreview) return;
    const containerRect = canvas.parentElement.getBoundingClientRect();
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / LOGICAL_WIDTH;
    const displaySize = Math.max(4, currentSize * scale);
    
    const x = e.clientX - containerRect.left;
    const y = e.clientY - containerRect.top;
    
    if (x < 0 || x > containerRect.width || y < 0 || y > containerRect.height) {
      brushPreview.style.display = 'none';
      return;
    }

    if (currentTool === 'picker' || currentTool === 'lasso') {
      brushPreview.style.display = 'none';
      activeCanvas.style.cursor = 'crosshair';
      return;
    }
    
    activeCanvas.style.cursor = 'none';
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

  function updateOnlineUserCount() {
    const el = document.getElementById('online-user-count');
    if (!el) return;
    const remoteCount = Object.keys(remoteCursors).length;
    el.textContent = remoteCount + 1; // 1 (myself) + active remote users
  }

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
      updateOnlineUserCount();
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
      updateOnlineUserCount();
    }
  }

  // --- UI Logic ---
  const btnPen = document.getElementById('btn-pen');
  const btnEraser = document.getElementById('btn-eraser');
  const btnFill = document.getElementById('btn-fill');
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');
  const btnPicker = document.getElementById('btn-picker');
  const btnLasso = document.getElementById('btn-lasso');
  const btnClear = document.getElementById('btn-clear');
  
  let myRedoStack = []; // Stores { strokeId, events: [] }

  function setActiveTool(tool, btn) {
    if (!btn) return;
    
    // If leaving lasso tool with an active selection, stamp it
    if (currentTool === 'lasso' && tool !== 'lasso') {
      stampLassoSelection();
    }

    // Save current size to previous tool
    if (currentTool === 'eraser') {
      eraserSize = currentSize;
    } else {
      penSize = currentSize;
    }
    
    currentTool = tool;
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Switch size slider smoothly to selected tool's size
    if (currentTool === 'eraser') {
      updateSize(eraserSize);
    } else {
      updateSize(penSize);
    }
  }

  btnPen.addEventListener('click', () => setActiveTool('pen', btnPen));
  btnEraser.addEventListener('click', () => setActiveTool('eraser', btnEraser));
  btnFill.addEventListener('click', () => setActiveTool('fill', btnFill));
  if (btnPicker) btnPicker.addEventListener('click', () => setActiveTool('picker', btnPicker));
  if (btnLasso) btnLasso.addEventListener('click', () => setActiveTool('lasso', btnLasso));
  
  function performUndo() {
    if (myStrokes.length > 0) {
      const lastStrokeId = myStrokes.pop();
      const undoneEvents = eventsHistory.filter(e => e.strokeId === lastStrokeId);
      myRedoStack.push({ strokeId: lastStrokeId, events: undoneEvents });
      broadcast({ type: 'undo', strokeId: lastStrokeId, userId });
      checkpointIndex = -1;
      eventsHistory = eventsHistory.filter(e => e.strokeId !== lastStrokeId);
      renderHistory();
    }
  }

  function performRedo() {
    if (myRedoStack.length > 0) {
      const redoItem = myRedoStack.pop();
      myStrokes.push(redoItem.strokeId);
      checkpointIndex = -1;
      redoItem.events.forEach(ev => {
        eventsHistory.push(ev);
        processEvent(ev);
        broadcast(ev);
      });
    }
  }

  btnUndo.addEventListener('click', performUndo);

  // Enable Redo!
  btnRedo.style.opacity = '1';
  btnRedo.style.cursor = 'pointer';
  btnRedo.addEventListener('click', performRedo);

  // Keyboard Shortcuts (Ctrl+Z Undo, Ctrl+Y Redo, Tool Hotkeys, Esc Cancel)
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const isCmdOrCtrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (isCmdOrCtrl && key === 'z') {
      if (e.shiftKey) {
        e.preventDefault();
        performRedo();
      } else {
        e.preventDefault();
        performUndo();
      }
    } else if (isCmdOrCtrl && key === 'y') {
      e.preventDefault();
      performRedo();
    } else if (key === 'b') {
      setActiveTool('pen', btnPen);
    } else if (key === 'e') {
      setActiveTool('eraser', btnEraser);
    } else if (key === 'g') {
      setActiveTool('fill', btnFill);
    } else if (key === 'l') {
      if (btnLasso) setActiveTool('lasso', btnLasso);
    } else if (key === 'i') {
      if (btnPicker) setActiveTool('picker', btnPicker);
    } else if (key === 'escape') {
      if (lassoState === 'selected' || lassoState === 'dragging') {
        resetLasso();
      }
    }
  });
  
  btnClear.addEventListener('click', () => {
    if (confirm("정말 화면을 모두 지우시겠습니까?")) {
      const msg = { type: 'clear', userId };
      checkpointIndex = -1;
      emitAndProcess(msg);
      myRedoStack = []; // Clear redo stack on full clear
    }
  });

  // --- Fixed 3x6 Color Palette ---
  const fixedPaletteColors = [
    '#000000', '#555555', '#AAAAAA', '#FFFFFF', '#8B4513', '#D2691E',
    '#FF3B30', '#FF9500', '#FFCC00', '#4CD964', '#28CD41', '#00C7BE',
    '#5AC8FA', '#007AFF', '#5856D6', '#AF52DE', '#FF2D55', '#FF6B81'
  ];

  const paletteGrid = document.getElementById('palette-grid');
  const customColorPicker = document.getElementById('current-color-picker');

  function renderPalette() {
    if (!paletteGrid) return;
    paletteGrid.innerHTML = '';
    
    fixedPaletteColors.forEach(hex => {
      const btn = document.createElement('button');
      btn.className = 'color-btn';
      btn.dataset.color = hex.toUpperCase();
      btn.style.backgroundColor = hex;
      if (currentColor.toUpperCase() === hex.toUpperCase()) {
        btn.classList.add('active');
      }
      
      btn.addEventListener('click', () => {
        currentColor = hex.toUpperCase();
        updateColorUI(currentColor);
        if (currentTool === 'eraser') setActiveTool('pen', btnPen);
      });
      
      paletteGrid.appendChild(btn);
    });
  }

  function updateColorUI(hex) {
    hex = hex.toUpperCase();
    if (customColorPicker) customColorPicker.value = hex;
    localStorage.setItem('garlic_pen_color', hex);
    
    if (paletteGrid) {
      paletteGrid.querySelectorAll('.color-btn').forEach(btn => {
        if (btn.dataset.color === hex) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });
    }
  }

  if (customColorPicker) {
    customColorPicker.addEventListener('input', (e) => {
      currentColor = e.target.value.toUpperCase();
      updateColorUI(currentColor);
      if (currentTool === 'eraser') setActiveTool('pen', btnPen);
    });
  }

  renderPalette();
  updateColorUI(currentColor);

  // Size
  const sizeSlider = document.getElementById('size-slider');
  const sizeIndicator = document.getElementById('size-indicator');
  
  function updateSize(val) {
    currentSize = parseInt(val, 10);
    if (currentTool === 'eraser') {
      eraserSize = currentSize;
      localStorage.setItem('garlic_eraser_size', eraserSize);
    } else {
      penSize = currentSize;
      localStorage.setItem('garlic_pen_size', penSize);
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
    if (isNaN(currentOpacity) || currentOpacity < 0.05 || currentOpacity > 1) currentOpacity = 1;
    localStorage.setItem('garlic_opacity', currentOpacity);
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
      localStorage.setItem('garlic_user_name', userName);
    });
  }

  if (userColorPicker) {
    userColorPicker.value = userColor;
    userColorPicker.addEventListener('input', (e) => {
      userColor = e.target.value;
      localStorage.setItem('garlic_nametag_color', userColor);
    });
  }

  // Save PNG Image Download with Toast
  const btnSave = document.getElementById('btn-save');
  if (btnSave) {
    btnSave.addEventListener('click', () => {
      const saveCanvas = document.createElement('canvas');
      saveCanvas.width = LOGICAL_WIDTH;
      saveCanvas.height = LOGICAL_HEIGHT;
      const saveCtx = saveCanvas.getContext('2d');
      
      saveCtx.fillStyle = '#FFFFFF';
      saveCtx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
      saveCtx.drawImage(canvas, 0, 0);

      const link = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      link.download = `garlic_drawing_${timestamp}.png`;
      link.href = saveCanvas.toDataURL('image/png');
      link.click();
      showToast("💾 고화질 PNG 이미지가 저장되었습니다!");
    });
  }

  // Clipboard Image Copy
  const btnCopy = document.getElementById('btn-copy');
  if (btnCopy) {
    btnCopy.addEventListener('click', async () => {
      try {
        const saveCanvas = document.createElement('canvas');
        saveCanvas.width = LOGICAL_WIDTH;
        saveCanvas.height = LOGICAL_HEIGHT;
        const saveCtx = saveCanvas.getContext('2d');
        
        saveCtx.fillStyle = '#FFFFFF';
        saveCtx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
        saveCtx.drawImage(canvas, 0, 0);

        saveCanvas.toBlob(async (blob) => {
          if (!blob) return;
          try {
            await navigator.clipboard.write([
              new ClipboardItem({ 'image/png': blob })
            ]);
            showToast("📋 클립보드에 이미지가 복사되었습니다! (Ctrl+V로 붙여넣기)");
          } catch(err) {
            showToast("⚠️ 클립보드 복사 권한이 필요합니다. 이미지 다운로드(💾)를 이용해주세요.");
          }
        }, 'image/png');
      } catch(err) {
        showToast("⚠️ 클립보드 복사를 지원하지 않는 브라우저입니다.");
      }
    });
  }

  // --- Toast Notifications ---
  function showToast(text) {
    let toast = document.querySelector('.toast-notification');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast-notification';
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 2500);
  }

  // --- Niconico Danmaku Flying Chat System & Emoji Burst ---
  const danmakuContainer = document.getElementById('danmaku-container');
  const chatInput = document.getElementById('chat-input');
  const btnSendChat = document.getElementById('btn-send-chat');

  function spawnDanmakuMessage(text, name, color) {
    if (!danmakuContainer || !text) return;
    const el = document.createElement('div');
    el.className = 'danmaku-item';
    
    if (name) {
      el.innerHTML = `<span style="color:${color || '#FF9500'}">[${escapeHtml(name)}]</span> ${escapeHtml(text)}`;
    } else {
      el.textContent = text;
    }

    const randomTop = Math.floor(Math.random() * 70 + 10);
    el.style.top = `${randomTop}%`;

    danmakuContainer.appendChild(el);

    setTimeout(() => {
      if (el.parentNode) {
        el.parentNode.removeChild(el);
      }
    }, 3600);
  }

  // Bottom-Up Fountain Emoji Burst (Randomized Midpoint Pause Height)
  function spawnEmojiBurst(emoji) {
    if (!danmakuContainer || !emoji) return;
    const count = 8;
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        const el = document.createElement('div');
        el.className = 'emoji-burst-item';
        el.textContent = emoji;

        // 1. Random horizontal position (10% to 90% width)
        const randomLeft = Math.floor(Math.random() * 80 + 10);
        
        // 2. Random MIDPOINT PAUSE HEIGHT (-20vh to -65vh) for each emoji!
        const randomPauseY = -Math.floor(Math.random() * 45 + 20);

        // 3. Random scale & wobble rotation
        const randomScale = (Math.random() * 0.5 + 1.3).toFixed(2);
        const randomRot = Math.floor(Math.random() * 60 - 30);

        el.style.left = `${randomLeft}%`;
        el.style.setProperty('--pause-y', `${randomPauseY}vh`);
        el.style.setProperty('--scale', randomScale);
        el.style.setProperty('--rot', `${randomRot}deg`);

        danmakuContainer.appendChild(el);

        setTimeout(() => {
          if (el.parentNode) {
            el.parentNode.removeChild(el);
          }
        }, 2600);
      }, i * 65); // 65ms staggered explosion burst!
    }
  }

  function sendChatMessage(text) {
    text = (text || '').trim();
    if (!text) return;
    const chatMsg = { type: 'chat', text, name: userName, color: userColor };
    spawnDanmakuMessage(text, userName, userColor);
    broadcast(chatMsg);
  }

  if (btnSendChat && chatInput) {
    btnSendChat.addEventListener('click', () => {
      sendChatMessage(chatInput.value);
      chatInput.value = '';
    });

    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        sendChatMessage(chatInput.value);
        chatInput.value = '';
      }
    });
  }

  // Quick Emoji Burst Buttons
  document.querySelectorAll('.emoji-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const emoji = btn.dataset.emoji;
      spawnEmojiBurst(emoji);
      broadcast({ type: 'emoji_burst', emoji });
    });
  });

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  window.addEventListener('beforeunload', () => {
    broadcast({ type: 'disconnect', id: userId });
  });
});
