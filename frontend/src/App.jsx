import { lazy, Suspense, useEffect, useState } from "react";
import { apiRequest } from "./api.js";

const Board = lazy(() => import("./Board.jsx").then((module) => ({ default: module.Board })));

function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await apiRequest(`/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify({ name, email, password }),
      });
      localStorage.setItem("boardcollab.auth", JSON.stringify(result));
      onAuthenticated(result);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-story">
        <a className="brand brand-light" href="#"><span className="brand-mark">b.</span> boardcollab</a>
        <div className="story-copy">
          <p className="eyebrow">A little more in sync</p>
          <h1>Good ideas<br />find their shape<br /><em>together.</em></h1>
          <p>One shared space for the sketches, plans, and happy accidents that move work forward.</p>
        </div>
        <div className="story-foot"><span>01 — Make space</span><span>02 — Make something</span><span>03 — Make it better</span></div>
      </section>
      <section className="auth-panel">
        <div className="auth-form-wrap">
          <p className="eyebrow">{mode === "login" ? "Welcome back" : "Start with a blank canvas"}</p>
          <h2>{mode === "login" ? "Sign in to your space" : "Create your account"}</h2>
          <p className="muted">Pick up where the good ideas left off.</p>
          <form onSubmit={submit} className="form-stack">
            {mode === "register" && <label>Your name<input autoComplete="name" required minLength="2" maxLength="60" value={name} onChange={(event) => setName(event.target.value)} /></label>}
            <label>Email address<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label>Password<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength="8" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="button button-primary button-wide" disabled={busy}>{busy ? "One moment…" : mode === "login" ? "Sign in" : "Create account"} <span>↗</span></button>
          </form>
          <p className="switch-auth">{mode === "login" ? "New around here?" : "Already have an account?"}{" "}
            <button onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>
              {mode === "login" ? "Create an account" : "Sign in"}
            </button>
          </p>
        </div>
        <span className="auth-copyright">Made for the work that works better together.</span>
      </section>
    </main>
  );
}

function Lobby({ auth, onLogout, onOpenBoard }) {
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [roomId, setRoomId] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function createRoom(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await apiRequest("/rooms", {
        token: auth.token,
        method: "POST",
        body: JSON.stringify({ name: name.trim() || `${auth.user.name}'s board`, isPrivate }),
      });
      onOpenBoard(result.room, result.inviteCode);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await apiRequest(`/rooms/${encodeURIComponent(roomId.trim())}`, {
        token: auth.token,
        headers: inviteCode ? { "X-Room-Invite": inviteCode.trim() } : {},
      });
      onOpenBoard(result.room, inviteCode || undefined);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="lobby-page">
      <header className="lobby-nav">
        <a className="brand" href="#"><span className="brand-mark">b.</span> boardcollab</a>
        <div className="profile-chip"><span className="avatar">{auth.user.name.slice(0, 1).toUpperCase()}</span><span>{auth.user.name}</span><button onClick={onLogout}>Log out</button></div>
      </header>
      <section className="lobby-hero">
        <div>
          <p className="eyebrow">Your team's thinking space</p>
          <h1>Let's make<br /><em>something clear.</em></h1>
          <p className="muted">Start with a fresh board or pick up the thread in a room.</p>
        </div>
        <div className="hero-doodle" aria-hidden="true">
          <div className="doodle-card doodle-one"><span>the big idea</span><b>↗</b></div>
          <div className="doodle-card doodle-two"><span>what if…</span><i /></div>
          <div className="doodle-card doodle-three"><span>next steps</span><b>✳</b></div>
          <span className="doodle-loop">↝</span>
        </div>
      </section>
      <section className="room-grid">
        <form className="room-card create-card" onSubmit={createRoom}>
          <div className="card-icon">＋</div>
          <p className="eyebrow">Start fresh</p>
          <h2>Make a new board</h2>
          <p className="muted">A blank canvas is a great place to begin.</p>
          <label>Board name<input value={name} maxLength="80" placeholder="e.g. Monday brainstorm" onChange={(event) => setName(event.target.value)} /></label>
          <label className="checkbox-label"><input type="checkbox" checked={isPrivate} onChange={(event) => setIsPrivate(event.target.checked)} /> Invite-only board</label>
          <button className="button button-primary" disabled={busy}>Create board <span>↗</span></button>
        </form>
        <form className="room-card join-card" onSubmit={joinRoom}>
          <div className="card-icon card-icon-lilac">↗</div>
          <p className="eyebrow">Already have a room?</p>
          <h2>Come on in</h2>
          <p className="muted">Paste a room ID to join your collaborators.</p>
          <label>Room ID<input value={roomId} required placeholder="Paste your room ID" onChange={(event) => setRoomId(event.target.value)} /></label>
          <label>Invite code <span className="optional">(private rooms only)</span><input value={inviteCode} placeholder="Optional" onChange={(event) => setInviteCode(event.target.value)} /></label>
          <button className="button button-outline" disabled={busy}>Join board <span>↗</span></button>
        </form>
      </section>
      {error && <p className="form-error lobby-error" role="alert">{error}</p>}
      <footer className="lobby-footer"><span>Ideas are better when they have somewhere to land.</span><span>BOARDcollab · 2026</span></footer>
    </main>
  );
}

export default function App() {
  const [auth, setAuth] = useState(() => {
    try { return JSON.parse(localStorage.getItem("boardcollab.auth") ?? "null"); } catch { return null; }
  });
  const [activeBoard, setActiveBoard] = useState(null);

  useEffect(() => {
    if (!auth?.token) return;
    const params = new URLSearchParams(window.location.search);
    const roomId = params.get("room");
    if (!roomId) return;
    const inviteCode = params.get("invite") ?? undefined;
    apiRequest(`/rooms/${encodeURIComponent(roomId)}`, {
      token: auth.token,
      headers: inviteCode ? { "X-Room-Invite": inviteCode } : {},
    }).then(({ room }) => setActiveBoard({ room, inviteCode }))
      .catch(() => window.history.replaceState({}, "", window.location.pathname));
  }, [auth]);

  function openBoard(room, inviteCode) {
    setActiveBoard({ room, inviteCode });
    const params = new URLSearchParams({ room: room.roomId });
    if (inviteCode) params.set("invite", inviteCode);
    window.history.replaceState({}, "", `?${params}`);
  }

  function logout() {
    localStorage.removeItem("boardcollab.auth");
    setAuth(null);
    setActiveBoard(null);
  }

  if (!auth) return <AuthScreen onAuthenticated={setAuth} />;
  if (activeBoard) return (
    <Suspense fallback={<main className="board-loading">Opening your board…</main>}>
      <Board auth={auth} room={activeBoard.room} inviteCode={activeBoard.inviteCode} onBack={() => {
        setActiveBoard(null);
        window.history.replaceState({}, "", window.location.pathname);
      }} />
    </Suspense>
  );
  return <Lobby auth={auth} onLogout={logout} onOpenBoard={openBoard} />;
}
