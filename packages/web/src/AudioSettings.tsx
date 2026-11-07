import { useEffect, useRef, useState } from "react";
import { comboFromEvent, comboLabel, hasGlobalShortcuts, saveKeybinds, setRecording, useKeybinds, type Combo, type VoiceAction } from "./keybinds.ts";
import { applyOutput, canPickOutput, micConstraints, micError, playSound, saveAudio, useAudioPrefs, VoiceGate, type AudioPrefs, type NoiseLevel } from "./audio.ts";

const NOISE: { id: NoiseLevel; label: string; detail: string }[] = [
  { id: "off", label: "Off", detail: "Your mic as it is." },
  { id: "standard", label: "Standard", detail: "Takes out fans, hum and hiss." },
  { id: "strong", label: "Strong", detail: "Also isolates your voice, where this browser can." },
];

/** Settings, Voice and audio: mic and speakers, a mic check, input sensitivity, cleanup, sounds. Saved on this device. */
export function AudioSettings() {
  const prefs = useAudioPrefs();
  const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null);
  const set = (patch: Partial<AudioPrefs>) => saveAudio(patch);

  const loadDevices = () =>
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
  useEffect(() => {
    loadDevices();
    navigator.mediaDevices?.addEventListener("devicechange", loadDevices);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", loadDevices);
  }, []);

  const inputs = devices?.filter((d) => d.kind === "audioinput" && d.deviceId !== "default") ?? [];
  const outputs = devices?.filter((d) => d.kind === "audiooutput" && d.deviceId !== "default") ?? [];
  // Names stay hidden until the mic has been allowed once.
  const unnamed = inputs.length > 0 && inputs.every((d) => !d.label);
  const sensitivity = prefs.sensitivity;

  return (
    <section className="audio-settings">
      <h3>Voice and audio</h3>
      <p className="muted small">For calls and voice channels. Saved on this device.</p>
      {devices && inputs.length === 0 && (
        <p className="warning-note" role="alert">
          No microphone found. Plug one in and it will show up here.
        </p>
      )}
      <div className="audio-grid">
        <label>
          Microphone
          <select value={prefs.inputId} onChange={(e) => set({ inputId: e.target.value })}>
            <option value="">System default</option>
            {inputs.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Microphone ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Speakers
          {canPickOutput() ? (
            <select value={prefs.outputId} onChange={(e) => set({ outputId: e.target.value })}>
              <option value="">System default</option>
              {outputs.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Speakers ${i + 1}`}
                </option>
              ))}
            </select>
          ) : (
            <select disabled>
              <option>System default (this browser can't pick)</option>
            </select>
          )}
        </label>
      </div>
      {unnamed && <p className="muted small">Check your mic once below to see the devices' names.</p>}

      <label className="range-row">
        <span>Volume of others</span>
        <input type="range" min={0} max={100} value={prefs.outputVolume} onChange={(e) => set({ outputVolume: Number(e.target.value) })} />
        <span className="range-value">{prefs.outputVolume}%</span>
        <button type="button" onClick={() => playSound("join", { ...prefs, sounds: true })}>
          Test speakers
        </button>
      </label>

      <MicCheck prefs={prefs} onAllowed={loadDevices} />

      <Keybinds />

      <h3>Input sensitivity</h3>
      <div className="chips" role="radiogroup" aria-label="Input sensitivity">
        {(
          [
            ["auto", "Automatic"],
            ["manual", "Manual"],
            ["off", "Always on"],
          ] as const
        ).map(([id, label]) => {
          const on = id === "manual" ? typeof sensitivity === "number" : sensitivity === id;
          return (
            <button
              key={id}
              role="radio"
              aria-checked={on}
              className={`chip ${on ? "on" : ""}`}
              onClick={() => set({ sensitivity: id === "manual" ? (typeof sensitivity === "number" ? sensitivity : -50) : id })}
            >
              {label}
            </button>
          );
        })}
      </div>
      <p className="muted small">
        {sensitivity === "auto"
          ? "Your mic only sends when you're louder than the room's background noise, and adjusts as the room gets louder or quieter."
          : sensitivity === "off"
            ? "Your mic always sends while you're unmuted."
            : "Your mic only sends above the line. Drag it so the bar crosses it when you talk, not when you type."}
      </p>
      {typeof sensitivity === "number" && (
        <label className="range-row">
          <span>Threshold</span>
          <input type="range" min={-90} max={-10} value={sensitivity} onChange={(e) => set({ sensitivity: Number(e.target.value) })} />
          <span className="range-value">{sensitivity} dB</span>
        </label>
      )}

      <h3>Noise suppression</h3>
      <div className="chips" role="radiogroup" aria-label="Noise suppression">
        {NOISE.map((n) => (
          <button key={n.id} role="radio" aria-checked={prefs.noiseSuppression === n.id} className={`chip ${prefs.noiseSuppression === n.id ? "on" : ""}`} onClick={() => set({ noiseSuppression: n.id })}>
            {n.label}
          </button>
        ))}
      </div>
      <p className="muted small">{NOISE.find((n) => n.id === prefs.noiseSuppression)?.detail}</p>

      <h3>Advanced</h3>
      <label className="toggle">
        <input type="checkbox" checked={prefs.echoCancellation} onChange={(e) => set({ echoCancellation: e.target.checked })} />
        <span>
          <strong>Echo cancellation</strong>
          <span className="muted small">Stops others hearing themselves through your speakers. Turn off with headphones for fuller sound.</span>
        </span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={prefs.autoGain} onChange={(e) => set({ autoGain: e.target.checked })} />
        <span>
          <strong>Automatic gain control</strong>
          <span className="muted small">Evens out your volume when you lean in or move away.</span>
        </span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={prefs.sounds} onChange={(e) => set({ sounds: e.target.checked })} />
        <span>
          <strong>Sounds</strong>
          <span className="muted small">Little chimes for mute, unmute, deafen, undeafen, and people joining or leaving voice.</span>
        </span>
      </label>
    </section>
  );
}

/** Opens the mic with the current settings and shows its level against the sensitivity line. */
function MicCheck({ prefs, onAllowed }: { prefs: AudioPrefs; onAllowed: () => void }) {
  const [on, setOn] = useState(false);
  const [hear, setHear] = useState(false);
  const [level, setLevel] = useState(-100);
  const [threshold, setThreshold] = useState(-100);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const echo = useRef<HTMLAudioElement>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const constraints = JSON.stringify(micConstraints(prefs));

  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    let gate: VoiceGate | null = null;
    let cancelled = false;
    setError(null);
    navigator.mediaDevices
      .getUserMedia({ audio: JSON.parse(constraints) as MediaTrackConstraints })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        onAllowed();
        const track = s.getAudioTracks()[0]!;
        gate = new VoiceGate(
          track,
          () => prefsRef.current.sensitivity,
          (isOpen, l, t) => {
            setLevel(l);
            setThreshold(t);
            setOpen(isOpen);
            track.enabled = isOpen;
          },
        );
        if (echo.current) echo.current.srcObject = s;
      })
      .catch((err: Error) => {
        setError(micError(err));
        setOn(false);
      });
    return () => {
      cancelled = true;
      gate?.close();
      stream?.getTracks().forEach((t) => t.stop());
      if (echo.current) echo.current.srcObject = null;
    };
    // Restart when the mic or its cleanup changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, constraints]);

  useEffect(() => {
    if (echo.current) applyOutput(echo.current, prefs);
  }, [prefs]);

  const pct = (db: number) => `${Math.max(0, Math.min(100, ((db + 90) / 80) * 100))}%`;

  return (
    <div className="mic-check">
      <div className="mic-check-row">
        <button type="button" className={on ? "" : "primary"} onClick={() => setOn(!on)}>
          {on ? "Stop checking" : "Check my mic"}
        </button>
        {on && (
          <label className="toggle inline">
            <input type="checkbox" checked={hear} onChange={(e) => setHear(e.target.checked)} />
            <span>Hear myself (use headphones)</span>
          </label>
        )}
      </div>
      {on && (
        <>
          <div className="meter" role="meter" aria-label="Mic level" aria-valuemin={-90} aria-valuemax={-10} aria-valuenow={Math.round(level)}>
            <span className={`meter-fill ${open ? "open" : ""}`} style={{ width: pct(level) }} />
            {threshold > -90 && <span className="meter-line" style={{ left: pct(threshold) }} title="Input sensitivity" />}
          </div>
          <p className="muted small">{open ? "You're being heard." : "Quiet: nothing is sent right now."}</p>
        </>
      )}
      <audio ref={echo} autoPlay muted={!hear} />
      {error && <p className="error">{error}</p>}
    </div>
  );
}

const ACTIONS: { id: VoiceAction; label: string }[] = [
  { id: "pushToTalk", label: "Push to talk (hold)" },
  { id: "mute", label: "Mute or unmute" },
  { id: "deafen", label: "Deafen or undeafen" },
];

/** Input mode, and the keys for push-to-talk, mute and deafen. */
function Keybinds() {
  const k = useKeybinds();
  const [recordingFor, setRecordingFor] = useState<VoiceAction | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!recordingFor) return;
    setRecording(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") return setRecordingFor(null);
      const c = comboFromEvent(e);
      if (!c) return;
      // Plain letters would fire while typing anywhere but a text box; push-to-talk is the exception people expect.
      if (recordingFor !== "pushToTalk" && !c.ctrl && !c.alt && !c.meta && !/^F\d{1,2}$/.test(c.code)) {
        setNote("Use Ctrl, Alt or an F key for mute and deafen, so typing doesn't set them off.");
        return;
      }
      const binds = { ...k.binds };
      // One key does one thing.
      for (const a of Object.keys(binds) as VoiceAction[]) if (a !== recordingFor && binds[a] && comboLabel(binds[a]!) === comboLabel(c)) binds[a] = null;
      binds[recordingFor] = c;
      saveKeybinds({ ...k, binds });
      setNote(null);
      setRecordingFor(null);
    };
    addEventListener("keydown", onKey, true);
    return () => {
      removeEventListener("keydown", onKey, true);
      setRecording(false);
    };
  }, [recordingFor, k]);

  const setBind = (a: VoiceAction, c: Combo | null) => saveKeybinds({ ...k, binds: { ...k.binds, [a]: c } });

  return (
    <>
      <h3>Input mode</h3>
      <div className="chips" role="radiogroup" aria-label="Input mode">
        {(
          [
            ["voice", "Voice activity"],
            ["ptt", "Push to talk"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="radio" aria-checked={k.inputMode === id} className={`chip ${k.inputMode === id ? "on" : ""}`} onClick={() => saveKeybinds({ ...k, inputMode: id })}>
            {label}
          </button>
        ))}
      </div>
      <p className="muted small">
        {k.inputMode === "ptt"
          ? k.binds.pushToTalk
            ? `Your mic only sends while you hold ${comboLabel(k.binds.pushToTalk)}, with Dendrop in front.`
            : "Pick a push-to-talk key below. Until then your mic stays quiet."
          : "Your mic sends when you talk, using the input sensitivity below."}
      </p>
      <h3>Keybinds</h3>
      <div className="keybinds">
        {ACTIONS.map((a) => {
          const c = k.binds[a.id];
          return (
            <div key={a.id} className="keybind">
              <span>{a.label}</span>
              <button type="button" className={`keycap ${recordingFor === a.id ? "recording" : ""}`} onClick={() => setRecordingFor(recordingFor === a.id ? null : a.id)}>
                {recordingFor === a.id ? "Press keys…" : c ? comboLabel(c) : "Not set"}
              </button>
              {c && (
                <button type="button" className="ghost" onClick={() => setBind(a.id, null)} aria-label={`Clear ${a.label}`}>
                  Clear
                </button>
              )}
            </div>
          );
        })}
      </div>
      {note && <p className="error">{note}</p>}
      <p className="muted small">
        {hasGlobalShortcuts()
          ? "Mute and deafen also work while Dendrop is in the background. Push to talk works with Dendrop in front."
          : "Keybinds work while this tab is in front. In the PC app, mute and deafen also work in the background."}
      </p>
    </>
  );
}
