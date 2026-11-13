package io.github.spacegoose02.dendrop.push;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import io.github.spacegoose02.dendrop.call.CallService;
import io.github.spacegoose02.dendrop.call.IncomingCalls;
import io.github.spacegoose02.dendrop.call.NativeCalls;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * Buttons on the call notifications that work without opening the app: Decline on the incoming
 * call, and Hang up on the call in progress. Both tell the server with the app's own sign-in.
 */
public class CallActionReceiver extends BroadcastReceiver {

    static final String ACTION_DECLINE = "io.github.spacegoose02.dendrop.DECLINE_CALL";
    public static final String ACTION_HANG_UP = "io.github.spacegoose02.dendrop.HANG_UP_CALL";
    /** The conversation, when the app knew which call it was. */
    public static final String EXTRA_CONVERSATION = "conversationId";

    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        Context app = context.getApplicationContext();
        Integer cid = intent.hasExtra(EXTRA_CONVERSATION) ? intent.getIntExtra(EXTRA_CONVERSATION, 0) : null;
        if (cid != null && cid <= 0) cid = null;
        if (ACTION_DECLINE.equals(action)) {
            // Stop ringing straight away; telling the server can take a moment.
            Notifier.clearCall(app);
            Integer known = cid;
            PendingResult result = goAsync();
            IO.execute(() -> {
                try {
                    IncomingCalls.decline(app, known);
                } finally {
                    result.finish();
                }
            });
        } else if (ACTION_HANG_UP.equals(action)) {
            CallService.stop(app);
            if (cid == null) return;
            int conversation = cid;
            // The page leaves the call; the server is told here too in case the page is asleep.
            NativeCalls.ended(conversation);
            PendingResult result = goAsync();
            IO.execute(() -> {
                try {
                    IncomingCalls.leave(app, conversation);
                } finally {
                    result.finish();
                }
            });
        }
    }
}
