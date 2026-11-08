import { useState, type FormEvent } from "react";
import { EVENT_LIMITS, isVoiceKind, type Channel, type ChatServer, type EventRsvp, type ScheduledEvent } from "@dendrop/shared";
import { api } from "./api.ts";
import { Avatar } from "./Avatar.tsx";
import { channelMark } from "./channels.ts";
import { Modal } from "./Modal.tsx";
import { can } from "./roles.ts";

const day = (d: Date) => d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const time = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "Fri, Nov 14 · 7:00 PM – 9:00 PM", or "Every Friday · 7:00 PM" for a weekly one. */
export function eventWhen(e: Pick<ScheduledEvent, "startsAt" | "endsAt" | "repeat">): string {
  const start = new Date(e.startsAt);
  const end = e.endsAt ? new Date(e.endsAt) : null;
  const first =
    e.repeat === "weekly" ? `Every ${start.toLocaleDateString([], { weekday: "long" })} (next ${start.toLocaleDateString([], { month: "short", day: "numeric" })})` : day(start);
  if (!end) return `${first} · ${time(start)}`;
  const sameDay = end.toDateString() === start.toDateString();
  return `${first} · ${time(start)} – ${sameDay ? time(end) : `${day(end)} ${time(end)}`}`;
}

/** "in 15 minutes", "in 3 hours", "tomorrow"… for the next event. */
function startsIn(iso: string): string {
  const min = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (min <= 0) return "any minute now";
  if (min < 60) return `in ${min} minute${min === 1 ? "" : "s"}`;
  const h = Math.round(min / 60);
  if (h < 24) return `in ${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return d === 1 ? "tomorrow" : `in ${d} days`;
}

const nameOf = (server: ChatServer, userId: number) => {
  const m = server.members.find((x) => x.user.id === userId);
  return m ? (m.nickname ?? m.user.displayName) : "Someone";
};

/** Where an event is: its channel, or the place someone typed. */
function Where({ event, server }: { event: ScheduledEvent; server: ChatServer }) {
  const channel = event.channelId === null ? undefined : server.channels.find((c) => c.id === event.channelId);
  if (channel) {
    return (
      <span>
        <span aria-hidden>{channelMark({ ...channel, locked: false })}</span> {channel.name}
      </span>
    );
  }
  return <span>📍 {event.location || "Place to be decided"}</span>;
}

/** The server's events, soonest first: RSVP, join the live ones, and (for hosts) plan and run them. */
export function EventsDialog({
  server,
  events,
  callsEnabled,
  onJoin,
  onClose,
}: {
  server: ChatServer;
  events: ScheduledEvent[];
  callsEnabled: boolean;
  onJoin: (channel: Channel) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<ScheduledEvent | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (editing) {
    return (
      <Modal title={editing === "new" ? "New event" : `Edit ${editing.name}`} onClose={onClose}>
        <EventForm server={server} event={editing === "new" ? null : editing} onDone={() => setEditing(null)} />
      </Modal>
    );
  }

  return (
    <Modal title={`Events · ${server.name}`} onClose={onClose} wide>
      {can(server, "manageEvents") && (
        <div className="row">
          <button className="primary small-button" onClick={() => setEditing("new")}>
            ＋ New event
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {events.length === 0 && (
        <p className="muted">
          Nothing planned yet.{" "}
          {can(server, "manageEvents") ? "Plan a game night or a movie night, and everyone who says they're coming gets a reminder." : ""}
        </p>
      )}
      <div className="event-list">
        {events.map((e) => {
          const channel = e.channelId === null ? undefined : server.channels.find((c) => c.id === e.channelId);
          const rsvp = (status: EventRsvp | null) => act(() => api(`/api/events/${e.id}/rsvp`, { method: "PUT", body: { status } }));
          const going = e.goingIds.map((id) => ({ id, name: nameOf(server, id) }));
          return (
            <article key={e.id} className={`event-card ${e.status === "live" ? "live" : ""}`}>
              <header>
                {e.status === "live" ? <span className="live-tag">Live now</span> : <span className="muted small">{startsIn(e.startsAt)}</span>}
                {e.repeat === "weekly" && <span className="role-tag">weekly</span>}
              </header>
              <h3>{e.name}</h3>
              <p className="muted small event-meta">
                <span>🕒 {eventWhen(e)}</span>
                <Where event={e} server={server} />
              </p>
              {e.description && <p className="event-description">{e.description}</p>}
              <p className="small event-people">
                {going.slice(0, 5).map((p) => (
                  <Avatar key={p.id} name={p.name} size={20} />
                ))}
                <span className="muted">
                  {going.length ? `${going.length} going` : "Nobody's said they're going yet"}
                  {e.interestedIds.length ? ` · ${e.interestedIds.length} interested` : ""}
                  {e.createdBy ? ` · hosted by ${nameOf(server, e.createdBy.id)}` : ""}
                </span>
              </p>
              <div className="row event-actions">
                <button className={`chip ${e.myRsvp === "going" ? "on" : ""}`} aria-pressed={e.myRsvp === "going"} onClick={() => void rsvp(e.myRsvp === "going" ? null : "going")}>
                  ✓ Going
                </button>
                <button
                  className={`chip ${e.myRsvp === "interested" ? "on" : ""}`}
                  aria-pressed={e.myRsvp === "interested"}
                  onClick={() => void rsvp(e.myRsvp === "interested" ? null : "interested")}
                >
                  ★ Interested
                </button>
                {e.status === "live" && channel && callsEnabled && (
                  <button className="accept small-button" onClick={() => onJoin(channel)}>
                    Join {channel.kind === "stage" ? "stage" : "voice"}
                  </button>
                )}
                {e.canManage && (
                  <span className="event-host-actions">
                    {e.status === "scheduled" ? (
                      <button className="small-button" onClick={() => void act(() => api(`/api/events/${e.id}/start`, { body: {} }))}>
                        Start now
                      </button>
                    ) : (
                      <button className="small-button" onClick={() => void act(() => api(`/api/events/${e.id}/end`, { body: {} }))}>
                        End event
                      </button>
                    )}
                    <button className="small-button" onClick={() => setEditing(e)}>
                      Edit
                    </button>
                    <button
                      className="small-button"
                      onClick={() => {
                        if (confirm(`Cancel ${e.name}${e.repeat === "weekly" ? " (every week)" : ""}?`)) void act(() => api(`/api/events/${e.id}`, { method: "DELETE" }));
                      }}
                    >
                      Cancel event
                    </button>
                  </span>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <p className="muted small">
        Everyone who's going or interested gets a reminder {EVENT_LIMITS.reminderMinutes} minutes before, and again when it starts.
      </p>
    </Modal>
  );
}

/** yyyy-mm-dd and hh:mm in this device's time zone, for the date and time inputs. */
const pad = (n: number) => String(n).padStart(2, "0");
const dateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Plans an event, or changes one. */
function EventForm({ server, event, onDone }: { server: ChatServer; event: ScheduledEvent | null; onDone: () => void }) {
  const places = server.channels.filter((c) => isVoiceKind(c.kind));
  // New events default to the next whole hour, two hours long, on the first stage (or voice) channel.
  const defaultStart = new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 3_600_000);
  const start0 = event ? new Date(event.startsAt) : defaultStart;
  const end0 = event ? (event.endsAt ? new Date(event.endsAt) : null) : new Date(defaultStart.getTime() + 2 * 3_600_000);
  const [name, setName] = useState(event?.name ?? "");
  const [description, setDescription] = useState(event?.description ?? "");
  const [place, setPlace] = useState<string>(
    event ? (event.channelId !== null ? String(event.channelId) : "elsewhere") : String((places.find((c) => c.kind === "stage") ?? places[0])?.id ?? "elsewhere"),
  );
  const [location, setLocation] = useState(event?.location ?? "");
  const [date, setDate] = useState(dateInput(start0));
  const [startTime, setStartTime] = useState(timeInput(start0));
  const [endTime, setEndTime] = useState(end0 ? timeInput(end0) : "");
  const [weekly, setWeekly] = useState(event?.repeat === "weekly");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = event?.status === "live";

  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    const start = new Date(`${date}T${startTime}`);
    if (Number.isNaN(start.getTime())) return setError("Pick a day and a start time");
    let end: Date | null = null;
    if (endTime) {
      end = new Date(`${date}T${endTime}`);
      // An end before the start is the next morning (a late movie night).
      if (end <= start) end = new Date(end.getTime() + 24 * 3_600_000);
    }
    const body = {
      name,
      description,
      ...(place === "elsewhere" ? { channelId: null, location } : { channelId: Number(place) }),
      ...(live ? {} : { startsAt: start.toISOString() }),
      endsAt: end ? end.toISOString() : null,
      repeat: weekly ? "weekly" : "none",
    };
    setBusy(true);
    try {
      if (event) await api(`/api/events/${event.id}`, { method: "PATCH", body });
      else await api(`/api/servers/${server.id}/events`, { body });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  return (
    <form className="event-form" onSubmit={(e) => void save(e)}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={EVENT_LIMITS.name} placeholder="Friday movie night" required autoFocus />
      </label>
      <label>
        What's happening (optional)
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={EVENT_LIMITS.description} rows={3} placeholder="Bring snacks. We're voting on the movie at 7." />
      </label>
      <label>
        Where
        <select value={place} onChange={(e) => setPlace(e.target.value)}>
          {places.map((c) => (
            <option key={c.id} value={c.id}>
              {channelMark({ ...c, locked: false })} {c.name}
            </option>
          ))}
          <option value="elsewhere">📍 Somewhere else</option>
        </select>
      </label>
      {place === "elsewhere" && (
        <label>
          Place
          <input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={EVENT_LIMITS.location} placeholder="Grandma's house" required />
        </label>
      )}
      <div className="row event-times">
        <label>
          Day
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={live} required />
        </label>
        <label>
          Starts
          <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} disabled={live} required />
        </label>
        <label>
          Ends (optional)
          <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </label>
      </div>
      <label className="toggle">
        <input type="checkbox" checked={weekly} onChange={(e) => setWeekly(e.target.checked)} />
        <span>
          <strong>Every week</strong>
          <span className="muted small">When it ends, it moves on to the same time next week, and everyone's RSVPs stay.</span>
        </span>
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="button" onClick={onDone}>
          Back
        </button>
        <button className="primary" disabled={busy || !name.trim()}>
          {event ? "Save" : "Plan it"}
        </button>
      </div>
    </form>
  );
}

/** A heads-up that an event you RSVP'd to starts soon, or just started. Sits where incoming calls do. */
export function EventReminderCard({
  event,
  minutes,
  server,
  callsEnabled,
  onJoin,
  onOpen,
  onClose,
}: {
  event: ScheduledEvent;
  minutes: number;
  server: ChatServer;
  callsEnabled: boolean;
  onJoin: (channel: Channel) => void;
  onOpen: () => void;
  onClose: () => void;
}) {
  const channel = event.channelId === null ? undefined : server.channels.find((c) => c.id === event.channelId);
  return (
    <div className="incoming event-reminder" role="dialog" aria-label={`${event.name} ${minutes ? "starts soon" : "is starting"}`}>
      <div className="play-together-icon" aria-hidden>
        📅
      </div>
      <h2>{event.name}</h2>
      <p className="muted">
        {minutes ? `Starts in ${minutes} minute${minutes === 1 ? "" : "s"}` : "Starting now"} on {server.name} · <Where event={event} server={server} />
      </p>
      <div className="row">
        <button onClick={onClose}>Dismiss</button>
        <button onClick={onOpen}>Details</button>
        {channel && callsEnabled && (
          <button className="accept" onClick={() => onJoin(channel)}>
            Join {channel.kind === "stage" ? "stage" : "voice"}
          </button>
        )}
      </div>
    </div>
  );
}
