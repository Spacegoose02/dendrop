package io.github.spacegoose02.dendrop.push;

import android.util.Log;
import androidx.annotation.NonNull;
import io.github.spacegoose02.dendrop.MainActivity;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PublicKeySet;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

/**
 * Gets pushes from the UnifiedPush distributor.
 *
 * A push is only a wake-up: the most it carries is a kind ("message", "call" or "event"). The text of a
 * message never goes through the push service, so neither ntfy nor anyone between can read it.
 */
public class DendropPushService extends PushService {

    private static final String TAG = "DendropPush";

    @Override
    public void onNewEndpoint(@NonNull PushEndpoint endpoint, @NonNull String instance) {
        PublicKeySet keys = endpoint.getPubKeySet();
        PushRegistrar.saveEndpoint(this, endpoint.getUrl(), keys == null ? null : keys.getPubKey(), keys == null ? null : keys.getAuth());
        PushRegistrar.sync(this);
    }

    @Override
    public void onMessage(@NonNull PushMessage message, @NonNull String instance) {
        String kind = kindOf(message.getContent());
        if ("call".equals(kind)) {
            Notifier.showCall(this);
        } else if ("event".equals(kind)) {
            if (!MainActivity.isInForeground()) Notifier.showEvent(this);
        } else if (!MainActivity.isInForeground()) {
            // The open app already shows new messages, so only notify when it's in the background.
            Notifier.showMessage(this);
        }
    }

    @Override
    public void onRegistrationFailed(@NonNull FailedReason reason, @NonNull String instance) {
        Log.w(TAG, "Push registration failed: " + reason);
    }

    @Override
    public void onUnregistered(@NonNull String instance) {
        PushRegistrar.clearEndpoint(this);
    }

    /** Reads {"type": "..."} from the push, ignoring anything else in it. */
    static String kindOf(byte[] content) {
        try {
            String type = new JSONObject(new String(content, StandardCharsets.UTF_8)).optString("type", "message");
            return type.isEmpty() ? "message" : type;
        } catch (Exception e) {
            return "message";
        }
    }
}
