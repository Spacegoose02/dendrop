import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { LIMITS, type ChatServer, type RailItem } from "@dendrop/shared";
import { api } from "./api.ts";
import { ServerIcon } from "./Servers.tsx";

/** Folder colors to pick from (null is the plain one). */
const FOLDER_COLORS = [null, "#5865f2", "#3ba55d", "#faa61a", "#ed4245", "#eb459e", "#9b59b6", "#1abc9c"];

const OPEN_KEY = "dendrop.openFolders";
const readOpen = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};

/**
 * The layout as shown: the saved one with servers you've left dropped, and servers it doesn't
 * mention (new ones) at the end in the order you joined.
 */
export function arrangeRail(rail: RailItem[], servers: ChatServer[]): RailItem[] {
  const have = new Set(servers.map((s) => s.id));
  const placed = new Set<number>();
  const out: RailItem[] = [];
  for (const item of rail) {
    if (item.type === "server") {
      if (have.has(item.id) && !placed.has(item.id)) {
        placed.add(item.id);
        out.push(item);
      }
      continue;
    }
    const ids = item.serverIds.filter((id) => have.has(id) && !placed.has(id));
    ids.forEach((id) => placed.add(id));
    if (ids.length) out.push({ ...item, serverIds: ids });
  }
  for (const s of servers) if (!placed.has(s.id)) out.push({ type: "server", id: s.id });
  return out;
}

const newFolderId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Takes a server out of wherever it is in the layout (dropping a folder left empty). */
function without(items: RailItem[], serverId: number): RailItem[] {
  return items.flatMap((it): RailItem[] => {
    if (it.type === "server") return it.id === serverId ? [] : [it];
    const ids = it.serverIds.filter((id) => id !== serverId);
    return ids.length ? [{ ...it, serverIds: ids }] : [];
  });
}

type Menu = { x: number; y: number } & ({ kind: "server"; serverId: number; folderId: string | null } | { kind: "folder"; folderId: string });

/**
 * The server list down the left: servers and folders of servers. Right-click (or long-press) a
 * server or folder to organize, or drag a server onto another to make a folder.
 */
export function ServerRail({
  servers,
  rail,
  onRail,
  renderServer,
  folderAlert,
}: {
  servers: ChatServer[];
  rail: RailItem[];
  onRail: (r: RailItem[]) => void;
  /** One server's rail button. */
  renderServer: (s: ChatServer, extra: { onContextMenu: (e: ReactMouseEvent) => void; draggable: boolean; onDragStart: (e: DragEvent) => void; onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void }) => ReactNode;
  /** A folder's unread state: whether anything in it is unread, and its pings. */
  folderAlert: (serverIds: number[]) => { unread: boolean; mentions: number };
}) {
  const items = arrangeRail(rail, servers);
  const byId = new Map(servers.map((s) => [s.id, s]));
  const [open, setOpen] = useState<Set<string>>(readOpen);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
    } catch {
      /* private mode: folders just start closed */
    }
  }, [open]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const save = (next: RailItem[]) => {
    setMenu(null);
    setError(null);
    onRail(next);
    api<RailItem[]>("/api/me/rail", { method: "PUT", body: { rail: next } }).then(onRail, (e: Error) => setError(e.message));
  };
  const folders = items.filter((i): i is Extract<RailItem, { type: "folder" }> => i.type === "folder");

  const toNewFolder = (serverId: number, withId?: number) => {
    let next = without(items, serverId);
    if (withId !== undefined) next = without(next, withId);
    // The folder takes the place of the server it was made from.
    const at = items.findIndex((i) => (i.type === "server" ? i.id === (withId ?? serverId) : i.serverIds.includes(withId ?? serverId)));
    const folder: RailItem = { type: "folder", id: newFolderId(), name: "", color: null, serverIds: withId !== undefined ? [withId, serverId] : [serverId] };
    const before = items.slice(0, Math.max(at, 0)).filter((i) => !(i.type === "server" && (i.id === serverId || i.id === withId))).length;
    next.splice(Math.min(before, next.length), 0, folder);
    setOpen((o) => new Set(o).add(folder.id));
    save(next);
  };
  const toFolder = (serverId: number, folderId: string) => {
    const next = without(items, serverId).map((i) => (i.type === "folder" && i.id === folderId ? { ...i, serverIds: [...i.serverIds, serverId] } : i));
    save(next);
  };
  const outOfFolder = (serverId: number, folderId: string) => {
    const at = items.findIndex((i) => i.type === "folder" && i.id === folderId);
    const next = without(items, serverId);
    const stillThere = next.findIndex((i) => i.type === "folder" && i.id === folderId);
    next.splice(stillThere === -1 ? at : stillThere + 1, 0, { type: "server", id: serverId });
    save(next);
  };
  const move = (key: (i: RailItem) => boolean, by: -1 | 1) => {
    const i = items.findIndex(key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= items.length) return setMenu(null);
    const next = [...items];
    [next[i], next[j]] = [next[j]!, next[i]!];
    save(next);
  };
  const moveInFolder = (folderId: string, serverId: number, by: -1 | 1) => {
    save(
      items.map((it) => {
        if (it.type !== "folder" || it.id !== folderId) return it;
        const ids = [...it.serverIds];
        const i = ids.indexOf(serverId);
        const j = i + by;
        if (i < 0 || j < 0 || j >= ids.length) return it;
        [ids[i], ids[j]] = [ids[j]!, ids[i]!];
        return { ...it, serverIds: ids };
      }),
    );
  };
  const editFolder = (folderId: string, change: Partial<{ name: string; color: string | null }>) =>
    save(items.map((i) => (i.type === "folder" && i.id === folderId ? { ...i, ...change } : i)));
  const ungroup = (folderId: string) => save(items.flatMap((i): RailItem[] => (i.type === "folder" && i.id === folderId ? i.serverIds.map((id) => ({ type: "server", id })) : [i])));

  const dragProps = (serverId: number, target: { serverId?: number; folderId?: string }) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      dragging.current = serverId;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(serverId));
    },
    onDragOver: (e: DragEvent) => {
      if (dragging.current !== null && dragging.current !== target.serverId) e.preventDefault();
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const from = dragging.current;
      dragging.current = null;
      if (from === null || from === target.serverId) return;
      if (target.folderId) toFolder(from, target.folderId);
      else if (target.serverId !== undefined) toNewFolder(from, target.serverId);
    },
  });

  const server = (s: ChatServer, folderId: string | null) =>
    renderServer(s, {
      onContextMenu: (e) => {
        e.preventDefault();
        setMenu({ kind: "server", serverId: s.id, folderId, x: e.clientX, y: e.clientY });
      },
      ...dragProps(s.id, folderId ? { folderId } : { serverId: s.id }),
    });

  const m = menu;
  const menuServerItem = m?.kind === "server" ? m : null;
  const menuFolder = m?.kind === "folder" ? folders.find((f) => f.id === m.folderId) : undefined;

  return (
    <>
      {items.map((it) => {
        if (it.type === "server") {
          const s = byId.get(it.id);
          return s ? <span key={`s${s.id}`} className="rail-slot">{server(s, null)}</span> : null;
        }
        const isOpen = open.has(it.id);
        const alert = folderAlert(it.serverIds);
        const label = it.name || "Folder";
        const toggle = () =>
          setOpen((o) => {
            const n = new Set(o);
            if (n.has(it.id)) n.delete(it.id);
            else n.add(it.id);
            return n;
          });
        const drop = dragProps(-1, { folderId: it.id });
        return (
          <div key={it.id} className={`rail-folder ${isOpen ? "open" : ""}`} style={it.color ? ({ "--folder": it.color } as CSSProperties) : undefined}>
            <button
              className="rail-folder-button"
              title={`${label}: ${it.serverIds.map((id) => byId.get(id)?.name).filter(Boolean).join(", ")}`}
              aria-label={`${label} folder, ${it.serverIds.length} servers`}
              aria-expanded={isOpen}
              onClick={toggle}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ kind: "folder", folderId: it.id, x: e.clientX, y: e.clientY });
              }}
              onDragOver={drop.onDragOver}
              onDrop={drop.onDrop}
            >
              {isOpen ? (
                <span className="rail-folder-icon" aria-hidden>
                  📁
                </span>
              ) : (
                <span className="rail-folder-grid" aria-hidden>
                  {it.serverIds.slice(0, 4).map((id) => {
                    const s = byId.get(id);
                    return s ? <ServerIcon key={id} server={s} size={20} /> : null;
                  })}
                </span>
              )}
              {!isOpen && alert.unread && <span className="rail-dot" aria-label="Unread" />}
              {!isOpen && alert.mentions > 0 && <span className="rail-badge">{alert.mentions > 99 ? "99+" : alert.mentions}</span>}
            </button>
            {isOpen &&
              it.serverIds.map((id) => {
                const s = byId.get(id);
                return s ? (
                  <span key={`s${id}`} className="rail-slot">
                    {server(s, it.id)}
                  </span>
                ) : null;
              })}
          </div>
        );
      })}
      {error && (
        <p className="rail-error" role="alert" onClick={() => setError(null)}>
          {error}
        </p>
      )}
      {m && (
        <div ref={menuRef} className="rail-menu" role="menu" style={{ left: m.x, top: Math.min(m.y, window.innerHeight - 320) }}>
          {menuServerItem && (
            <>
              <strong className="small ellipsis">{byId.get(menuServerItem.serverId)?.name}</strong>
              {menuServerItem.folderId ? (
                <>
                  <button role="menuitem" onClick={() => outOfFolder(menuServerItem.serverId, menuServerItem.folderId!)}>
                    Take out of folder
                  </button>
                  <button role="menuitem" onClick={() => moveInFolder(menuServerItem.folderId!, menuServerItem.serverId, -1)}>
                    Move up
                  </button>
                  <button role="menuitem" onClick={() => moveInFolder(menuServerItem.folderId!, menuServerItem.serverId, 1)}>
                    Move down
                  </button>
                </>
              ) : (
                <>
                  <button role="menuitem" onClick={() => toNewFolder(menuServerItem.serverId)}>
                    New folder with this server
                  </button>
                  {folders.map((f) => (
                    <button key={f.id} role="menuitem" onClick={() => toFolder(menuServerItem.serverId, f.id)}>
                      Add to {f.name || "folder"}
                    </button>
                  ))}
                  <button role="menuitem" onClick={() => move((i) => i.type === "server" && i.id === menuServerItem.serverId, -1)}>
                    Move up
                  </button>
                  <button role="menuitem" onClick={() => move((i) => i.type === "server" && i.id === menuServerItem.serverId, 1)}>
                    Move down
                  </button>
                </>
              )}
            </>
          )}
          {menuFolder && (
            <>
              {renaming?.id === menuFolder.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    editFolder(menuFolder.id, { name: renaming.name.trim() });
                    setRenaming(null);
                  }}
                >
                  <input autoFocus maxLength={LIMITS.folderName} value={renaming.name} onChange={(e) => setRenaming({ id: menuFolder.id, name: e.target.value })} aria-label="Folder name" placeholder="Folder name" />
                </form>
              ) : (
                <button role="menuitem" onClick={() => setRenaming({ id: menuFolder.id, name: menuFolder.name })}>
                  Rename{menuFolder.name ? ` “${menuFolder.name}”` : ""}
                </button>
              )}
              <div className="rail-colors" aria-label="Folder color">
                {FOLDER_COLORS.map((c) => (
                  <button
                    key={c ?? "none"}
                    className={`swatch ${menuFolder.color === c ? "on" : ""}`}
                    style={{ background: c ?? "var(--dd-bg-raised)" }}
                    title={c ?? "No color"}
                    aria-label={c ? `Color ${c}` : "No color"}
                    onClick={() => editFolder(menuFolder.id, { color: c })}
                  />
                ))}
              </div>
              <button role="menuitem" onClick={() => move((i) => i.type === "folder" && i.id === menuFolder.id, -1)}>
                Move up
              </button>
              <button role="menuitem" onClick={() => move((i) => i.type === "folder" && i.id === menuFolder.id, 1)}>
                Move down
              </button>
              <button role="menuitem" onClick={() => ungroup(menuFolder.id)}>
                Ungroup (keeps the servers)
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
