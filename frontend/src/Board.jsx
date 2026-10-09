import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Circle, Layer, Line, Rect, Stage, Text } from "react-konva";
import { io } from "socket.io-client";
import { useDispatch, useSelector } from "react-redux";
import { apiRequest, socketUrl } from "./api.js";
import {
  acknowledgeOperation,
  applyCanonical,
  applyLocal,
  applyLocalBatch,
  createOperation,
  hydrateBoard,
  redoOperation,
  resetBoard,
  store,
  undoOperation,
} from "./store.js";

const COLORS = ["#25282b", "#5a64d8", "#e47d55", "#378b72", "#dbb94b"];

function visibleInViewport(element, width, height) {
  const data = element.data ?? {};
  const x = Number(data.x ?? data.points?.[0] ?? 0);
  const y = Number(data.y ?? data.points?.[1] ?? 0);
  const right = x + Number(data.width ?? 0);
  const bottom = y + Number(data.height ?? 0);
  return right >= 0 && bottom >= 0 && x <= width && y <= height;
}

const CanvasElement = memo(function CanvasElement({ element, editable, onMove }) {
  const data = element.data ?? {};
  if (element.deleted) return null;
  if (element.type === "stroke") {
    return <Line points={data.points ?? []} stroke={data.color ?? "#25282b"} strokeWidth={data.width ?? 3} lineCap="round" lineJoin="round" tension={0.12} draggable={editable} onDragEnd={(event) => {
      const offsetX = event.target.x();
      const offsetY = event.target.y();
      event.target.position({ x: 0, y: 0 });
      onMove(element, { ...data, points: data.points.map((value, index) => value + (index % 2 === 0 ? offsetX : offsetY)) });
    }} />;
  }
  if (element.type === "rect") {
    return <Rect x={data.x} y={data.y} width={data.width} height={data.height} stroke={data.color} strokeWidth={2} cornerRadius={4} draggable={editable} onDragEnd={(event) => onMove(element, { ...data, x: event.target.x(), y: event.target.y() })} />;
  }
  if (element.type === "circle") {
    return <Circle x={data.x} y={data.y} radius={data.radius} stroke={data.color} strokeWidth={2} draggable={editable} onDragEnd={(event) => onMove(element, { ...data, x: event.target.x(), y: event.target.y() })} />;
  }
  if (element.type === "text") {
    return <Text x={data.x} y={data.y} text={data.text} fill={data.color} fontSize={data.fontSize ?? 20} fontFamily="Inter, sans-serif" draggable={editable} onDragEnd={(event) => onMove(element, { ...data, x: event.target.x(), y: event.target.y() })} />;
  }
  return null;
});

export function Board({ auth, room, inviteCode, onBack }) {
  const dispatch = useDispatch();
  const elements = useSelector((state) => state.board.elements);
  const outbox = useSelector((state) => state.board.outbox);
  const undoStack = useSelector((state) => state.board.undoStack);
  const redoStack = useSelector((state) => state.board.redoStack);
  const [connection, setConnection] = useState("connecting");
  const [users, setUsers] = useState([]);
  const [tool, setTool] = useState("stroke");
  const [color, setColor] = useState(COLORS[0]);
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [draft, setDraft] = useState(null);
  const [previews, setPreviews] = useState({});
  const [error, setError] = useState("");
  const [width, setWidth] = useState(window.innerWidth);
  const [height, setHeight] = useState(window.innerHeight - 132);
  const socketRef = useRef(null);
  const draftRef = useRef(null);
  const lastPreviewRef = useRef(0);
  const stageRef = useRef(null);
  const invite = inviteCode || new URLSearchParams(window.location.search).get("invite") || undefined;

  useEffect(() => {
    dispatch(resetBoard());
    try {
      const cached = JSON.parse(localStorage.getItem(`boardcollab.board.${room.roomId}`) ?? "null");
      if (cached) dispatch(hydrateBoard(cached));
    } catch (storageError) {
      console.warn("Unable to restore the local board cache", storageError);
    }

    const socket = io(socketUrl, { auth: { token: auth.token }, transports: ["websocket", "polling"] });
    socketRef.current = socket;
    socket.on("connect", () => {
      setConnection("connecting");
      socket.emit("join-room", { roomId: room.roomId, inviteCode: invite }, (result) => {
        if (result?.error) {
          setError(result.error);
          setConnection("error");
          return;
        }
        dispatch(hydrateBoard({
          elements: Object.fromEntries((result.elements ?? []).map((element) => [element.elementId, element])),
        }));
        setUsers(result.users ?? []);
        setConnection("connected");
        const pending = store.getState().board.outbox;
        for (let index = 0; index < pending.length; index += 100) {
          socket.emit("draw-operations", pending.slice(index, index + 100));
        }
      });
    });
    socket.on("connect_error", (socketError) => {
      setConnection("error");
      setError(socketError.message);
    });
    socket.on("disconnect", () => setConnection("offline"));
    socket.on("draw-operation", (operation) => {
      dispatch(applyCanonical(operation));
      setPreviews((current) => {
        if (!current[operation.elementId]) return current;
        const next = { ...current };
        delete next[operation.elementId];
        return next;
      });
    });
    socket.on("operation-ack", ({ opId }) => dispatch(acknowledgeOperation(opId)));
    socket.on("user-joined", (user) => setUsers((current) => [...current.filter((item) => item.id !== user.id), user]));
    socket.on("user-left", ({ id }) => setUsers((current) => current.filter((item) => item.id !== id)));
    socket.on("draw-preview", (preview) => setPreviews((current) => ({
      ...current,
      [preview.elementId]: {
        ...preview,
        points: [...(current[preview.elementId]?.points ?? []), ...preview.points].slice(-4096),
      },
    })));

    const handleResize = () => {
      setWidth(window.innerWidth);
      setHeight(window.innerHeight - 132);
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [auth.token, dispatch, invite, room.roomId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        localStorage.setItem(`boardcollab.board.${room.roomId}`, JSON.stringify({ elements, outbox }));
      } catch {
        setError("Local browser storage is full; unsynced edits may not survive a reload");
      }
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [elements, outbox, room.roomId]);

  const visibleElements = useMemo(
    () => Object.values(elements).filter((element) => !element.deleted && visibleInViewport(element, width, height)),
    [elements, height, width]
  );

  const commitOperation = useCallback((element) => {
    const current = store.getState().board;
    const clock = current.clock + 1;
    const operation = createOperation(element, auth.user.id, clock);
    dispatch(applyLocal({ operation }));
    socketRef.current?.emit("draw-operations", [operation], (result) => {
      if (result?.error) setError(result.error);
    });
  }, [auth.user.id, dispatch]);

  const moveElement = useCallback((element, data) => {
    commitOperation({ elementId: element.elementId, type: element.type, data });
  }, [commitOperation]);

  function onPointerDown(event) {
    const stage = event.target.getStage();
    const point = stage.getPointerPosition();
    if (!point) return;
    if (tool === "select") return;
    if (tool === "text") {
      const text = window.prompt("Add a note");
      if (text?.trim()) commitOperation({
        elementId: crypto.randomUUID(), type: "text",
        data: { x: point.x, y: point.y, text: text.trim().slice(0, 500), color, fontSize: 20 },
      });
      return;
    }
    const next = {
      elementId: crypto.randomUUID(), type: tool, color, strokeWidth,
      start: point, points: [point.x, point.y],
    };
    draftRef.current = next;
    setDraft(next);
  }

  function onPointerMove(event) {
    const active = draftRef.current;
    if (!active) return;
    const point = event.target.getStage().getPointerPosition();
    if (!point) return;
    const next = active.type === "stroke"
      ? { ...active, points: [...active.points, point.x, point.y] }
      : { ...active, current: point };
    if (next.type === "stroke" && next.points.length > 4096) {
      const compacted = [];
      for (let index = 0; index < next.points.length - 2; index += 4) {
        compacted.push(next.points[index], next.points[index + 1]);
      }
      compacted.push(...next.points.slice(-2));
      next.points = compacted;
    }
    draftRef.current = next;
    setDraft(next);

    const now = Date.now();
    if (now - lastPreviewRef.current > 45 && active.type === "stroke") {
      lastPreviewRef.current = now;
      socketRef.current?.volatile.emit("draw-preview", {
        elementId: active.elementId, type: active.type,
        points: next.points.slice(-32), color: active.color, strokeWidth: active.strokeWidth,
      });
    }
  }

  function onPointerUp() {
    const active = draftRef.current;
    if (!active) return;
    draftRef.current = null;
    setDraft(null);
    const end = active.current ?? active.start;
    let data;
    if (active.type === "stroke") {
      data = { points: active.points, color: active.color, width: active.strokeWidth };
    } else if (active.type === "rect") {
      data = {
        x: Math.min(active.start.x, end.x), y: Math.min(active.start.y, end.y),
        width: Math.abs(end.x - active.start.x), height: Math.abs(end.y - active.start.y), color: active.color,
      };
    } else {
      data = {
        x: active.start.x, y: active.start.y,
        radius: Math.hypot(end.x - active.start.x, end.y - active.start.y), color: active.color,
      };
    }
    commitOperation({ elementId: active.elementId, type: active.type, data });
  }

  const applyHistory = useCallback((action) => {
    const operation = action === "undo"
      ? undoOperation(store.getState(), auth.user.id)
      : redoOperation(store.getState(), auth.user.id);
    if (!operation) return;
    dispatch(applyLocal({ operation, history: action }));
    socketRef.current?.emit("draw-operations", [operation], (result) => {
      if (result?.error) setError(result.error);
    });
  }, [auth.user.id, dispatch]);

  useEffect(() => {
    function handleHistoryShortcut(event) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      applyHistory(event.shiftKey ? "redo" : "undo");
    }
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [applyHistory]);

  function clearBoard() {
    if (!window.confirm("Clear every element on this board?")) return;
    const current = store.getState().board.elements;
    if (connection !== "connected") {
      setError("Reconnect before clearing the shared board");
      return;
    }
    let clock = store.getState().board.clock;
    const operations = Object.values(current).filter((element) => !element.deleted).map((element) => {
      clock += 1;
      return createOperation({
        elementId: element.elementId, type: element.type, data: {}, deleted: true,
      }, auth.user.id, clock);
    });
    dispatch(applyLocalBatch(operations));
    for (let index = 0; index < operations.length; index += 100) {
      socketRef.current?.emit("draw-operations", operations.slice(index, index + 100), (result) => {
        if (result?.error) setError(result.error);
      });
    }
  }

  function exportPng() {
    const stage = stageRef.current;
    if (!stage) {
      setError("The canvas is not ready to export yet");
      return;
    }
    const link = document.createElement("a");
    link.download = `${room.name.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() || "board"}.png`;
    link.href = stage.toDataURL({ pixelRatio: 2 });
    link.click();
  }

  async function copyInvite() {
    const url = new URL(window.location.href);
    url.searchParams.set("room", room.roomId);
    if (invite) url.searchParams.set("invite", invite);
    try {
      await navigator.clipboard.writeText(url.toString());
      setError("Invite link copied");
      window.setTimeout(() => setError(""), 2200);
    } catch {
      setError("Could not access the clipboard. Copy the room URL from your address bar.");
    }
  }

  function saveSvg() {
    const escape = (text) => String(text).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
    })[character]);
    const markup = Object.values(elements).filter((element) => !element.deleted).map((element) => {
      const data = element.data ?? {};
      if (element.type === "stroke") {
        const points = (data.points ?? []).reduce((pairs, value, index, all) => {
          if (index % 2 === 0) pairs.push(`${value},${all[index + 1]}`);
          return pairs;
        }, []).join(" ");
        return `<polyline points="${points}" fill="none" stroke="${escape(data.color)}" stroke-width="${data.width ?? 3}" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
      if (element.type === "rect") return `<rect x="${data.x}" y="${data.y}" width="${data.width}" height="${data.height}" fill="none" stroke="${escape(data.color)}" stroke-width="2"/>`;
      if (element.type === "circle") return `<circle cx="${data.x}" cy="${data.y}" r="${data.radius}" fill="none" stroke="${escape(data.color)}" stroke-width="2"/>`;
      if (element.type === "text") return `<text x="${data.x}" y="${data.y}" fill="${escape(data.color)}" font-size="${data.fontSize ?? 20}">${escape(data.text)}</text>`;
      return "";
    }).join("");
    const blob = new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${markup}</svg>`], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${room.name.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() || "board"}.svg`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;

  return (
    <main className="board-app">
      <header className="board-header">
        <button className="back-button" onClick={onBack} aria-label="Back to boards">←</button>
        <div className="board-title"><a className="brand" href="#"><span className="brand-mark">b.</span></a><span className="title-divider" /> <div><strong>{room.name}</strong><small>Shared workspace</small></div></div>
        <div className="board-header-right">
          <span className={`connection ${connection}`}><i />{connection === "connected" ? "Live" : connection === "offline" ? "Reconnecting" : connection === "error" ? "Connection issue" : "Connecting"}</span>
          <div className="user-stack" title={users.map((user) => user.name).join(", ")}>
            {users.slice(0, 4).map((user, index) => <span key={`${user.id}-${index}`} className={`avatar avatar-${index % 4}`}>{user.name.slice(0, 1).toUpperCase()}</span>)}
            {users.length > 4 && <span className="avatar avatar-more">+{users.length - 4}</span>}
          </div>
          <span className="participant-count">{users.length} here</span>
          <button className="button button-small button-outline" onClick={copyInvite}>Share</button>
        </div>
      </header>
      <div className="toolbar">
        <div className="tool-group" aria-label="Drawing tools">
          {[["select", "↖", "Select and move"], ["stroke", "／", "Pen"], ["rect", "□", "Rectangle"], ["circle", "◯", "Circle"], ["text", "T", "Text"]].map(([value, icon, label]) => (
            <button key={value} title={label} aria-label={label} aria-pressed={tool === value} className={`tool-button ${tool === value ? "selected" : ""}`} onClick={() => setTool(value)}>{icon}</button>
          ))}
        </div>
        <span className="toolbar-divider" />
        <div className="color-group" aria-label="Colors">
          {COLORS.map((item) => <button key={item} className={`color-dot ${color === item ? "active" : ""}`} style={{ "--swatch": item }} aria-label={`Use ${item}`} aria-pressed={color === item} onClick={() => setColor(item)} />)}
        </div>
        <span className="toolbar-divider" />
        <label className="width-control">Size <input aria-label="Brush size" type="range" min="1" max="12" value={strokeWidth} onChange={(event) => setStrokeWidth(Number(event.target.value))} /></label>
        <div className="toolbar-spacer" />
        <div className="history-tools">
          <button className="text-tool" disabled={!canUndo} onClick={() => applyHistory("undo")} title="Undo your latest edit">↶ <span>Undo</span></button>
          <button className="text-tool" disabled={!canRedo} onClick={() => applyHistory("redo")} title="Redo your latest edit">↷ <span>Redo</span></button>
        </div>
        <span className="toolbar-divider" />
        <div className="menu-tools">
          <button className="text-tool" onClick={exportPng}>↓ <span>PNG</span></button>
          <button className="text-tool" onClick={saveSvg}>↓ <span>SVG</span></button>
          <button className="clear-button" onClick={clearBoard}>Clear</button>
        </div>
      </div>
      <section className="canvas-shell">
        <div className="canvas-hint"><span className="hint-icon">✳</span> {tool === "stroke" ? "Sketch something out" : `Click and drag to draw a ${tool}`}</div>
        <Stage ref={stageRef} width={width} height={height} onMouseDown={onPointerDown} onMouseMove={onPointerMove} onMouseUp={onPointerUp} onTouchStart={onPointerDown} onTouchMove={onPointerMove} onTouchEnd={onPointerUp} className="whiteboard">
          <Layer listening={tool === "select"}>
            {visibleElements.map((element) => <CanvasElement key={element.elementId} element={element} editable={tool === "select"} onMove={moveElement} />)}
            {draft?.type === "stroke" && <Line points={draft.points} stroke={draft.color} strokeWidth={draft.strokeWidth} lineCap="round" lineJoin="round" />}
            {draft?.type === "rect" && draft.current && <Rect x={Math.min(draft.start.x, draft.current.x)} y={Math.min(draft.start.y, draft.current.y)} width={Math.abs(draft.current.x - draft.start.x)} height={Math.abs(draft.current.y - draft.start.y)} stroke={draft.color} strokeWidth={2} />}
            {draft?.type === "circle" && draft.current && <Circle x={draft.start.x} y={draft.start.y} radius={Math.hypot(draft.current.x - draft.start.x, draft.current.y - draft.start.y)} stroke={draft.color} strokeWidth={2} />}
            {Object.values(previews).map((preview) => <Line key={preview.elementId} points={preview.points} stroke={preview.color} strokeWidth={preview.strokeWidth} lineCap="round" lineJoin="round" opacity={0.65} />)}
          </Layer>
        </Stage>
        <div className="canvas-corner"><span>⌘</span> + <span>Z</span> to undo</div>
      </section>
      {error && <button className={`toast ${connection === "error" ? "toast-error" : ""}`} onClick={() => setError("")} aria-live="polite">{error} <span>×</span></button>}
    </main>
  );
}
