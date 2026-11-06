import { useEffect } from "react";
import type { Call, Conversation, Me } from "@dendrop/shared";
import { Avatar } from "./Avatar.tsx";
import { conversationTitle } from "./util.ts";

/** A soft two-tone ring made in the browser, so there's no sound file to ship. */
function useRing() {
  useEffect(() => {
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    const ring = () => {
      if (!ctx || ctx.state === "closed") return;
      for (const [i, freq] of [440, 554].entries()) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        const t = ctx.currentTime + i * 0.25;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.15, t + 0.03);
        gain.gain.linearRampToValueAtTime(0, t + 0.22);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.25);
      }
    };
    ring();
    const timer = setInterval(ring, 2000);
    return () => {
      clearInterval(timer);
      void ctx?.close();
    };
  }, []);
}

export function IncomingCall({
  me,
  call,
  conversation,
  onAccept,
  onDecline,
}: {
  me: Me;
  call: Call;
  conversation: Conversation | undefined;
  onAccept: (video: boolean) => void;
  onDecline: () => void;
}) {
  useRing();
  const caller = conversation?.members.find((m) => m.id === call.startedBy);
  const title = conversation ? conversationTitle(conversation, me.id) : "Someone";
  return (
    <div className="incoming" role="alertdialog" aria-label={`Incoming call from ${caller?.displayName ?? title}`}>
      <Avatar name={caller?.displayName ?? title} size={72} />
      <h2>{caller?.displayName ?? title}</h2>
      <p className="muted">
        {call.video ? "Video call" : "Voice call"}
        {conversation?.isGroup ? ` in ${title}` : ""}
      </p>
      <div className="row">
        <button className="hangup" onClick={onDecline}>
          Decline
        </button>
        <button className="accept" onClick={() => onAccept(false)}>
          Answer
        </button>
        {call.video && (
          <button className="accept" onClick={() => onAccept(true)}>
            Answer with video
          </button>
        )}
      </div>
    </div>
  );
}
