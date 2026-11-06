import { useEffect, useState } from "react";
import type { Me } from "@dendrop/shared";
import { connectGateway, logout } from "./api.ts";

/**
 * The main layout: server rail, sidebar, main pane. The DM list and chat view fill the
 * sidebar and main pane in Phase 1; servers fill the rail in Phase 3.
 */
export function Shell({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const [online, setOnline] = useState(false);

  useEffect(() => connectGateway(() => {}, setOnline), []);

  return (
    <div className="shell">
      <nav className="rail" aria-label="Servers">
        <button className="rail-item active" title="Direct messages">
          <img src="/favicon.svg" alt="Direct messages" width={32} height={32} />
        </button>
        <div className="rail-sep" />
      </nav>

      <aside className="sidebar">
        <header className="sidebar-header">Direct messages</header>
        <div className="sidebar-body muted">No conversations yet.</div>
        <footer className="me">
          <div className="avatar" aria-hidden>
            {me.displayName.slice(0, 1).toUpperCase()}
            <span className={`status ${online ? "on" : ""}`} title={online ? "Connected" : "Reconnecting…"} />
          </div>
          <div className="me-names">
            <strong>{me.displayName}</strong>
            <span className="muted">@{me.username}</span>
          </div>
          <button className="ghost" onClick={() => void logout().then(onSignedOut)} title="Sign out">
            Sign out
          </button>
        </footer>
      </aside>

      <main className="main">
        <div className="empty">
          <img src="/favicon.svg" alt="" width={96} height={96} />
          <h2>The den is quiet</h2>
          <p className="muted">Add a friend to start a private conversation.</p>
        </div>
      </main>
    </div>
  );
}
