package io.github.spacegoose02.dendrop.push;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * "Silence" on the incoming call notification. Pushes don't say which call it is, so this only
 * stops this phone ringing; the call goes on ringing for the caller and anyone else invited.
 */
public class CallActionReceiver extends BroadcastReceiver {

    static final String ACTION_SILENCE = "io.github.spacegoose02.dendrop.SILENCE_CALL";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (ACTION_SILENCE.equals(intent.getAction())) Notifier.clearCall(context);
    }
}
