package io.github.spacegoose02.dendrop.call;

import android.content.Context;
import androidx.annotation.Nullable;
import io.github.spacegoose02.dendrop.push.Notifier;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The call that's ringing this phone. A push only says "a call", so this asks the server (with
 * the app's own sign-in, never through the push service) which call it is and who is calling,
 * puts their name on the notification, and keeps checking until it's answered, so the phone
 * stops ringing when the caller hangs up or it's answered on another device. Answer and
 * Decline on the notification use what it found.
 */
public final class IncomingCalls {

    /** Rings for as long as the server does. */
    private static final long RING_MS = 45_000;
    private static final long CHECK_EVERY_MS = 3_000;

    private static final ScheduledExecutorService IO = Executors.newSingleThreadScheduledExecutor();
    private static final Object LOCK = new Object();

    /** Bumped for every new ring, so checks for an older one stop. */
    private static int generation = 0;
    @Nullable
    private static ScheduledFuture<?> watch;
    /** The ringing call's conversation, once the server said which it is. */
    @Nullable
    private static Integer conversationId;
    private static boolean video;
    private static boolean named;

    private IncomingCalls() {}

    /** A call push arrived: ring, then find out which call it is. */
    public static void ring(Context context) {
        Context app = context.getApplicationContext();
        int gen;
        synchronized (LOCK) {
            gen = ++generation;
            cancelWatch();
            conversationId = null;
            video = false;
            named = false;
            long started = System.currentTimeMillis();
            Notifier.showCall(app, null, null, false, false);
            watch = IO.scheduleWithFixedDelay(
                () -> {
                    if (System.currentTimeMillis() - started > RING_MS) {
                        stopIf(app, gen);
                        return;
                    }
                    check(app, gen);
                },
                0,
                CHECK_EVERY_MS,
                TimeUnit.MILLISECONDS
            );
        }
    }

    /** The conversation of the call that's ringing, if known. */
    @Nullable
    public static Integer ringingConversation() {
        synchronized (LOCK) {
            return conversationId;
        }
    }

    public static boolean ringingWithVideo() {
        synchronized (LOCK) {
            return video;
        }
    }

    /** Stops ringing on this phone and stops checking, for an answer, a decline or the app opening. */
    public static void stop(Context context) {
        synchronized (LOCK) {
            generation++;
            cancelWatch();
        }
        Notifier.clearCall(context);
    }

    /**
     * Decline from the notification: tells the server, so the caller sees it, then stops ringing.
     * conversationId may be null when the server wasn't reached yet; then every call ringing this
     * person is declined. Blocks; call off the main thread.
     */
    public static void decline(Context context, @Nullable Integer known) {
        Integer cid = known;
        if (cid == null) cid = ringingConversation();
        stop(context);
        if (cid != null) {
            ServerApi.request(context, "POST", "/api/conversations/" + cid + "/call/decline", new JSONObject());
            return;
        }
        Integer myId = myId(context);
        JSONArray calls = ServerApi.request(context, "GET", "/api/calls", null).array();
        if (myId == null || calls == null) return;
        for (int i = 0; i < calls.length(); i++) {
            JSONObject call = calls.optJSONObject(i);
            if (call != null && contains(call.optJSONArray("ringing"), myId)) {
                ServerApi.request(context, "POST", "/api/conversations/" + call.optInt("conversationId") + "/call/decline", new JSONObject());
            }
        }
    }

    /** Hang up from the in-call notification. Blocks; call off the main thread. */
    public static void leave(Context context, int conversationId) {
        ServerApi.request(context, "POST", "/api/conversations/" + conversationId + "/call/leave", new JSONObject());
    }

    private static void check(Context context, int gen) {
        Integer myId = myId(context);
        JSONArray calls = ServerApi.request(context, "GET", "/api/calls", null).array();
        // Signed out or the server is unreachable: let it ring out rather than guess.
        if (myId == null || calls == null) return;
        Integer known;
        synchronized (LOCK) {
            if (gen != generation) return;
            known = conversationId;
        }
        JSONObject found = null;
        for (int i = 0; i < calls.length(); i++) {
            JSONObject call = calls.optJSONObject(i);
            if (call == null || !contains(call.optJSONArray("ringing"), myId)) continue;
            if (found == null || (known != null && call.optInt("conversationId") == known)) found = call;
        }
        if (found == null) {
            // Answered on another device, declined, or the caller hung up.
            stopIf(context, gen);
            return;
        }
        int cid = found.optInt("conversationId");
        boolean withVideo = found.optBoolean("video", false);
        boolean needsName;
        synchronized (LOCK) {
            if (gen != generation) return;
            conversationId = cid;
            video = withVideo;
            needsName = !named;
            named = true;
        }
        if (!needsName) return;
        String name = callerName(context, cid, found.optInt("startedBy"));
        synchronized (LOCK) {
            if (gen != generation) return;
            Notifier.showCall(context, name, cid, withVideo, true);
        }
    }

    /** "Sam", or "Sam in Book club" for a group; null when the server didn't say. */
    @Nullable
    private static String callerName(Context context, int cid, int startedBy) {
        JSONObject conv = ServerApi.request(context, "GET", "/api/conversations/" + cid, null).object();
        if (conv == null) return null;
        JSONArray members = conv.optJSONArray("members");
        String caller = null;
        if (members != null) {
            for (int i = 0; i < members.length(); i++) {
                JSONObject m = members.optJSONObject(i);
                if (m != null && m.optInt("id") == startedBy) caller = m.optString("displayName", null);
            }
        }
        if (caller == null || caller.isEmpty()) return null;
        if (!conv.optBoolean("isGroup", false)) return caller;
        String group = conv.optString("name", "");
        return caller + " in " + (group.isEmpty() || "null".equals(group) ? "a group" : group);
    }

    @Nullable
    private static Integer myId(Context context) {
        JSONObject me = ServerApi.request(context, "GET", "/api/me", null).object();
        return me == null || !me.has("id") ? null : me.optInt("id");
    }

    private static boolean contains(@Nullable JSONArray ids, int id) {
        if (ids == null) return false;
        for (int i = 0; i < ids.length(); i++) if (ids.optInt(i) == id) return true;
        return false;
    }

    private static void stopIf(Context context, int gen) {
        synchronized (LOCK) {
            if (gen != generation) return;
            generation++;
            cancelWatch();
        }
        Notifier.clearCall(context);
    }

    private static void cancelWatch() {
        if (watch != null) watch.cancel(false);
        watch = null;
    }
}
