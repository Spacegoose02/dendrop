package io.github.spacegoose02.dendrop.call;

import androidx.annotation.Nullable;
import com.getcapacitor.JSObject;

/**
 * Hands calls between the notification and the web page. The page listens for "callAnswered"
 * (join this call) and "callEnded" (hung up from the notification), and asks for an answer it
 * missed while it was loading.
 */
public final class NativeCalls {

    /** What the plugin does with an event; set while the page's plugin is alive. */
    public interface Listener {
        void callAnswered(JSObject answer);

        void callEnded(int conversationId);
    }

    @Nullable
    private static Listener listener;
    /** An answer the page hasn't picked up yet (it may still be loading). */
    @Nullable
    private static JSObject pendingAnswer;
    private static long pendingAt;
    /** An answer older than this is for a call that has rung out. */
    private static final long ANSWER_KEEP_MS = 60_000;

    private NativeCalls() {}

    public static synchronized void setListener(@Nullable Listener l) {
        listener = l;
    }

    public static synchronized void clearListener(Listener l) {
        if (listener == l) listener = null;
    }

    /** Answered on the notification. conversationId is null when the app couldn't tell which call yet. */
    public static void answered(@Nullable Integer conversationId, boolean video) {
        JSObject a = new JSObject();
        if (conversationId != null) a.put("conversationId", (int) conversationId);
        a.put("video", video);
        Listener l;
        synchronized (NativeCalls.class) {
            pendingAnswer = a;
            pendingAt = System.currentTimeMillis();
            l = listener;
        }
        if (l != null) l.callAnswered(a);
    }

    /** Takes the answer the page hasn't seen yet, if any. */
    @Nullable
    public static synchronized JSObject takePendingAnswer() {
        JSObject a = pendingAnswer;
        pendingAnswer = null;
        if (a != null && System.currentTimeMillis() - pendingAt > ANSWER_KEEP_MS) return null;
        return a;
    }

    /** Hung up from the in-call notification (the app already told the server). */
    public static void ended(int conversationId) {
        Listener l;
        synchronized (NativeCalls.class) {
            l = listener;
        }
        if (l != null) l.callEnded(conversationId);
    }
}
