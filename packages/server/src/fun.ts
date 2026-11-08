import { randomInt } from "node:crypto";
import { FUN_LIMITS, parseDice, RPS_PICKS, type Game, type GameKind, type Poll, type Reminder, type RpsPick } from "@dendrop/shared";
import { now, tx, type Db } from "./db.js";
import { HttpError } from "./errors.js";

/**
 * Polls, quick games and reminders. The poll and game state lives next to its message (see
 * ConversationRepo.sendCard), and is shown on the message as `poll` / `game`.
 */

interface PollRow {
  message_id: number;
  question: string | null;
  options: string | null;
  option_count: number;
  multi: number;
  closes_at: string | null;
  closed_at: string | null;
}

/** A game as stored: like Game, but rock paper scissors picks stay here until both are in. */
interface GameState {
  kind: GameKind;
  players: number[];
  board: number[] | null;
  turn: number | null;
  picks: Record<string, RpsPick>;
  dice: Game["dice"];
  winner: number | null;
  line: number[] | null;
  draw: boolean;
  done: boolean;
}

interface ReminderRow {
  id: number;
  user_id: number;
  message_id: number;
  conversation_id: number;
  remind_at: string;
  created_at: string;
  fired_at: string | null;
}

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

const BEATS: Record<RpsPick, RpsPick> = { rock: "scissors", paper: "rock", scissors: "paper" };

const toReminder = (r: ReminderRow): Reminder => ({
  id: r.id,
  messageId: r.message_id,
  conversationId: r.conversation_id,
  remindAt: r.remind_at,
  createdAt: r.created_at,
  firedAt: r.fired_at,
});

/** A poll as given by its maker: the plain words, or (encrypted) just how many options. */
export interface NewPoll {
  question: string | null;
  options: string[] | null;
  optionCount: number;
  multi: boolean;
  closesAt: string | null;
}

/** Checks a new poll. `encrypted` polls keep their words in the message body instead. */
export function cleanPoll(input: { question?: unknown; options?: unknown; optionCount?: unknown; multi?: unknown; closesInMinutes?: unknown }, encrypted: boolean): NewPoll {
  let question: string | null = null;
  let options: string[] | null = null;
  let optionCount: number;
  if (encrypted) {
    optionCount = Number(input.optionCount);
    if (!Number.isInteger(optionCount) || optionCount < 2 || optionCount > FUN_LIMITS.pollOptions) throw new HttpError(400, `A poll needs 2 to ${FUN_LIMITS.pollOptions} options`);
  } else {
    if (typeof input.question !== "string" || !input.question.trim()) throw new HttpError(400, "A poll needs a question");
    question = input.question.replace(/\s+/g, " ").trim();
    if (question.length > FUN_LIMITS.pollQuestion) throw new HttpError(400, `Questions can be up to ${FUN_LIMITS.pollQuestion} characters`);
    if (!Array.isArray(input.options)) throw new HttpError(400, "A poll needs options");
    options = input.options.map((o) => (typeof o === "string" ? o.replace(/\s+/g, " ").trim() : "")).filter(Boolean);
    if (options.length < 2 || options.length > FUN_LIMITS.pollOptions) throw new HttpError(400, `A poll needs 2 to ${FUN_LIMITS.pollOptions} options`);
    if (options.some((o) => o.length > FUN_LIMITS.pollOption)) throw new HttpError(400, `Options can be up to ${FUN_LIMITS.pollOption} characters`);
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new HttpError(400, "Each option has to be different");
    optionCount = options.length;
  }
  let closesAt: string | null = null;
  if (input.closesInMinutes !== undefined && input.closesInMinutes !== null) {
    const mins = Number(input.closesInMinutes);
    if (!Number.isInteger(mins) || mins < 1 || mins > FUN_LIMITS.pollMinutes) throw new HttpError(400, "A poll can stay open for up to two weeks");
    closesAt = new Date(Date.now() + mins * 60_000).toISOString();
  }
  return { question, options, optionCount, multi: input.multi === true, closesAt };
}

export class FunRepo {
  constructor(private readonly db: Db) {}

  // ---- Reading, for messages -----------------------------------------------------------

  polls(messageIds: number[]): Map<number, Poll> {
    const out = new Map<number, Poll>();
    if (!messageIds.length) return out;
    const marks = messageIds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM polls WHERE message_id IN (${marks})`).all(...messageIds) as unknown as PollRow[];
    if (!rows.length) return out;
    const votes = this.db
      .prepare(`SELECT message_id, user_id, option FROM poll_votes WHERE message_id IN (${rows.map(() => "?").join(",")}) ORDER BY created_at, user_id`)
      .all(...rows.map((r) => r.message_id)) as { message_id: number; user_id: number; option: number }[];
    const t = Date.now();
    for (const r of rows) {
      const counts: number[][] = Array.from({ length: r.option_count }, () => []);
      for (const v of votes) if (v.message_id === r.message_id) counts[v.option]?.push(v.user_id);
      out.set(r.message_id, {
        question: r.question,
        options: r.options ? (JSON.parse(r.options) as string[]) : null,
        optionCount: r.option_count,
        multi: !!r.multi,
        closesAt: r.closes_at,
        closed: !!r.closed_at || (!!r.closes_at && Date.parse(r.closes_at) <= t),
        votes: counts,
      });
    }
    return out;
  }

  games(messageIds: number[]): Map<number, Game> {
    const out = new Map<number, Game>();
    if (!messageIds.length) return out;
    const rows = this.db
      .prepare(`SELECT message_id, state FROM message_games WHERE message_id IN (${messageIds.map(() => "?").join(",")})`)
      .all(...messageIds) as { message_id: number; state: string }[];
    for (const r of rows) out.set(r.message_id, view(JSON.parse(r.state) as GameState));
    return out;
  }

  // ---- Polls ------------------------------------------------------------------------------

  addPoll(messageId: number, p: NewPoll): void {
    this.db
      .prepare("INSERT INTO polls (message_id, question, options, option_count, multi, closes_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(messageId, p.question, p.options ? JSON.stringify(p.options) : null, p.optionCount, p.multi ? 1 : 0, p.closesAt);
  }

  /** Replaces someone's votes on a poll with `options` (empty takes them back). */
  vote(messageId: number, userId: number, options: unknown): void {
    const poll = this.polls([messageId]).get(messageId);
    if (!poll) throw new HttpError(404, "That isn't a poll");
    if (poll.closed) throw new HttpError(409, "This poll is closed");
    if (!Array.isArray(options)) throw new HttpError(400, "options is a list of option numbers");
    const picked = [...new Set(options.map(Number))];
    if (picked.some((o) => !Number.isInteger(o) || o < 0 || o >= poll.optionCount)) throw new HttpError(400, "No such option");
    if (!poll.multi && picked.length > 1) throw new HttpError(400, "This poll takes one answer");
    tx(this.db, () => {
      this.db.prepare("DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?").run(messageId, userId);
      const add = this.db.prepare("INSERT INTO poll_votes (message_id, user_id, option, created_at) VALUES (?, ?, ?, ?)");
      const t = now();
      for (const o of picked) add.run(messageId, userId, o, t);
    });
  }

  closePoll(messageId: number): void {
    const res = this.db.prepare("UPDATE polls SET closed_at = ? WHERE message_id = ? AND closed_at IS NULL").run(now(), messageId);
    if (!Number(res.changes)) throw new HttpError(409, "This poll is already closed");
  }

  // ---- Games ------------------------------------------------------------------------------

  /** A new game's state. In a 1:1 DM the other person is seated straight away. */
  newGame(kind: unknown, by: number, opponent: number | null, dice?: unknown): GameState {
    const base: GameState = { kind: "dice", players: [by], board: null, turn: null, picks: {}, dice: null, winner: null, line: null, draw: false, done: false };
    if (kind === "dice") {
      const spec = typeof dice === "string" && dice.trim() ? dice : "1d6";
      const d = parseDice(spec);
      if (!d) throw new HttpError(400, `Dice look like 2d6: up to ${FUN_LIMITS.dice} dice with 2 to ${FUN_LIMITS.diceSides} sides`);
      const rolls = Array.from({ length: d.count }, () => randomInt(1, d.sides + 1));
      return { ...base, dice: { spec: `${d.count}d${d.sides}`, rolls, total: rolls.reduce((a, b) => a + b, 0) }, done: true };
    }
    if (kind !== "tictactoe" && kind !== "rps") throw new HttpError(400, "Games are tictactoe, rps and dice");
    const players = opponent ? [by, opponent] : [by];
    return {
      ...base,
      kind,
      players,
      board: kind === "tictactoe" ? Array<number>(9).fill(0) : null,
      turn: kind === "tictactoe" && opponent ? by : null,
    };
  }

  addGame(messageId: number, state: GameState): void {
    this.db.prepare("INSERT INTO message_games (message_id, kind, state) VALUES (?, ?, ?)").run(messageId, state.kind, JSON.stringify(state));
  }

  /** Takes the open seat, makes a tic-tac-toe move, or picks rock, paper or scissors. */
  play(messageId: number, userId: number, action: { action?: unknown; cell?: unknown; pick?: unknown }): void {
    tx(this.db, () => {
      const row = this.db.prepare("SELECT state FROM message_games WHERE message_id = ?").get(messageId) as { state: string } | undefined;
      if (!row) throw new HttpError(404, "That isn't a game");
      const g = JSON.parse(row.state) as GameState;
      if (g.done) throw new HttpError(409, "This game is over");
      if (action.action === "join") {
        if (g.players.includes(userId)) throw new HttpError(409, "You're already playing");
        if (g.players.length >= 2) throw new HttpError(409, "Both seats are taken");
        g.players.push(userId);
        if (g.kind === "tictactoe") g.turn = g.players[0]!;
      } else if (action.action === "move" && g.kind === "tictactoe") {
        const cell = Number(action.cell);
        if (!g.players.includes(userId)) throw new HttpError(403, "You're not in this game");
        if (g.turn !== userId) throw new HttpError(409, "It's not your turn");
        if (!Number.isInteger(cell) || cell < 0 || cell > 8 || g.board![cell] !== 0) throw new HttpError(400, "Pick an empty square");
        g.board![cell] = g.players.indexOf(userId) + 1;
        const line = LINES.find((l) => l.every((c) => g.board![c] === g.board![cell]));
        if (line) Object.assign(g, { winner: userId, line, done: true, turn: null });
        else if (g.board!.every((c) => c !== 0)) Object.assign(g, { draw: true, done: true, turn: null });
        else g.turn = g.players.find((p) => p !== userId)!;
      } else if (action.action === "pick" && g.kind === "rps") {
        if (!g.players.includes(userId)) throw new HttpError(403, "You're not in this game");
        if (!RPS_PICKS.includes(action.pick as RpsPick)) throw new HttpError(400, "Pick rock, paper or scissors");
        if (g.picks[userId]) throw new HttpError(409, "You already picked");
        g.picks[userId] = action.pick as RpsPick;
        if (g.players.length === 2 && g.players.every((p) => g.picks[p])) {
          const [a, b] = g.players.map((p) => g.picks[p]!) as [RpsPick, RpsPick];
          g.done = true;
          if (a === b) g.draw = true;
          else g.winner = BEATS[a] === b ? g.players[0]! : g.players[1]!;
        }
      } else throw new HttpError(400, "That isn't a move in this game");
      this.db.prepare("UPDATE message_games SET state = ? WHERE message_id = ?").run(JSON.stringify(g), messageId);
    });
  }

  // ---- Nudges -----------------------------------------------------------------------------

  /** Seconds until `userId` can nudge in this chat again (0: now). */
  nudgeWait(conversationId: number, userId: number): number {
    const r = this.db
      .prepare("SELECT created_at FROM messages WHERE conversation_id = ? AND author_id = ? AND nudge IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(conversationId, userId) as { created_at: string } | undefined;
    if (!r) return 0;
    const left = FUN_LIMITS.nudgeSeconds * 1000 - (Date.now() - Date.parse(r.created_at));
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  // ---- Reminders --------------------------------------------------------------------------

  addReminder(userId: number, messageId: number, conversationId: number, at: unknown): Reminder {
    const when = typeof at === "string" ? Date.parse(at) : NaN;
    if (Number.isNaN(when)) throw new HttpError(400, "at is when to remind you, as a date and time");
    if (when < Date.now() + 30_000) throw new HttpError(400, "Pick a time in the future");
    if (when > Date.now() + FUN_LIMITS.reminderDays * 86_400_000) throw new HttpError(400, "Reminders can be up to a year ahead");
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?").get(userId) as { n: number };
    if (Number(pending.n) >= FUN_LIMITS.reminders) throw new HttpError(400, `You can have up to ${FUN_LIMITS.reminders} reminders; dismiss some first`);
    const res = this.db
      .prepare("INSERT INTO reminders (user_id, message_id, conversation_id, remind_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, messageId, conversationId, new Date(when).toISOString(), now());
    return this.reminder(Number(res.lastInsertRowid))!;
  }

  reminder(id: number): Reminder | undefined {
    const r = this.db.prepare("SELECT * FROM reminders WHERE id = ?").get(id) as ReminderRow | undefined;
    return r && toReminder(r);
  }

  /** Someone's reminders: those still to come, and those that went off and aren't dismissed. */
  reminders(userId: number): Reminder[] {
    return (this.db.prepare("SELECT * FROM reminders WHERE user_id = ? ORDER BY remind_at, id").all(userId) as unknown as ReminderRow[]).map(toReminder);
  }

  removeReminder(id: number, userId: number): void {
    const res = this.db.prepare("DELETE FROM reminders WHERE id = ? AND user_id = ?").run(id, userId);
    if (!Number(res.changes)) throw new HttpError(404, "No such reminder");
  }

  /** Marks every reminder due by `at` as gone off, and returns them with whose they are. */
  fireDue(at: Date = new Date()): (Reminder & { userId: number })[] {
    return tx(this.db, () => {
      const rows = this.db.prepare("SELECT * FROM reminders WHERE fired_at IS NULL AND remind_at <= ? ORDER BY remind_at").all(at.toISOString()) as unknown as ReminderRow[];
      const mark = this.db.prepare("UPDATE reminders SET fired_at = ? WHERE id = ?");
      const t = now();
      for (const r of rows) mark.run(t, r.id);
      return rows.map((r) => ({ ...toReminder({ ...r, fired_at: t }), userId: r.user_id }));
    });
  }
}

/** What everyone sees of a game: rock paper scissors picks only once both are in. */
function view(g: GameState): Game {
  return {
    kind: g.kind,
    players: g.players,
    board: g.board,
    turn: g.turn,
    picked: g.players.filter((p) => g.picks[p]),
    picks: g.kind === "rps" && g.done ? g.players.map((p) => g.picks[p]!) : null,
    dice: g.dice,
    winner: g.winner,
    line: g.line,
    draw: g.draw,
    done: g.done,
  };
}

export type { GameState };
