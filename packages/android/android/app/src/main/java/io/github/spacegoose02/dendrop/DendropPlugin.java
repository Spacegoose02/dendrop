package io.github.spacegoose02.dendrop;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;
import io.github.spacegoose02.dendrop.push.Notifier;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import io.github.spacegoose02.dendrop.push.PushRegistrar;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import kotlin.Unit;
import org.json.JSONObject;
import org.unifiedpush.android.connector.UnifiedPush;

/**
 * The native side of the app's own setup page (www/index.html): choosing the server and turning
 * on notifications. The Dendrop web client itself doesn't need this plugin.
 */
@CapacitorPlugin(
    name = "Dendrop",
    permissions = { @Permission(alias = DendropPlugin.NOTIFICATIONS, strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class DendropPlugin extends Plugin {

    static final String NOTIFICATIONS = "notifications";
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    /** Everything the setup page shows. */
    @PluginMethod
    public void getState(PluginCall call) {
        Context ctx = getContext();
        JSObject push = new JSObject();
        push.put("enabled", PushRegistrar.isEnabled(ctx));
        push.put("notificationsAllowed", NotificationManagerCompat.from(ctx).areNotificationsEnabled());
        push.put("distributor", UnifiedPush.getAckDistributor(ctx));
        push.put("distributors", new JSArray(UnifiedPush.getDistributors(ctx)));
        push.put("hasEndpoint", PushRegistrar.getEndpoint(ctx) != null);
        push.put("serverStatus", PushRegistrar.getStatus(ctx));
        JSObject result = new JSObject();
        result.put("serverUrl", ServerSettings.getServerUrl(ctx));
        result.put("appVersion", BuildConfig.VERSION_NAME);
        result.put("push", push);
        call.resolve(result);
    }

    /**
     * Checks that a Dendrop server answers at the address, saves it and opens it.
     * Rejects with a message the page can show when it doesn't.
     */
    @PluginMethod
    public void setServer(PluginCall call) {
        String url = ServerSettings.normalize(call.getString("url"));
        if (url == null) {
            call.reject("That doesn't look like a web address. Try something like chat.example.com.");
            return;
        }
        io.execute(() -> {
            String problem = checkServer(url);
            if (problem != null) {
                call.reject(problem);
                return;
            }
            boolean changed = !url.equals(ServerSettings.getServerUrl(getContext()));
            ServerSettings.setServerUrl(getContext(), url);
            if (changed) PushRegistrar.sync(getContext());
            JSObject result = new JSObject();
            result.put("serverUrl", url);
            call.resolve(result);
        });
    }

    /** Restarts the app on the saved server. Call after setServer, when the page is done. */
    @PluginMethod
    public void openServer(PluginCall call) {
        call.resolve();
        Activity activity = getActivity();
        activity.runOnUiThread(() -> MainActivity.restart(activity));
    }

    /** Asks for notification permission, picks a UnifiedPush distributor and registers with it. */
    @PluginMethod
    public void enablePush(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState(NOTIFICATIONS) != PermissionState.GRANTED) {
            requestPermissionForAlias(NOTIFICATIONS, call, "afterNotificationPermission");
            return;
        }
        registerPush(call);
    }

    @PermissionCallback
    private void afterNotificationPermission(PluginCall call) {
        if (getPermissionState(NOTIFICATIONS) != PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("ok", false);
            result.put("reason", "permission-denied");
            call.resolve(result);
            return;
        }
        registerPush(call);
    }

    private void registerPush(PluginCall call) {
        Activity activity = getActivity();
        List<String> distributors = UnifiedPush.getDistributors(activity);
        if (distributors.isEmpty()) {
            JSObject result = new JSObject();
            result.put("ok", false);
            result.put("reason", "no-distributor");
            call.resolve(result);
            return;
        }
        // Uses the distributor already chosen, the system default, or asks when there are several.
        UnifiedPush.tryUseCurrentOrDefaultDistributor(activity, (Boolean ok) -> {
            if (!ok) {
                JSObject result = new JSObject();
                result.put("ok", false);
                result.put("reason", "no-distributor-chosen");
                call.resolve(result);
                return Unit.INSTANCE;
            }
            io.execute(() -> {
                String server = ServerSettings.getServerUrl(activity);
                String vapid = server == null ? null : PushRegistrar.fetchVapidKey(server);
                PushRegistrar.setEnabled(activity, true);
                UnifiedPush.register(activity, "default", "Dendrop notifications", vapid);
                JSObject result = new JSObject();
                result.put("ok", true);
                call.resolve(result);
            });
            return Unit.INSTANCE;
        });
    }

    /** Turns notifications off: unregisters from the distributor and the server. */
    @PluginMethod
    public void disablePush(PluginCall call) {
        PushRegistrar.setEnabled(getContext(), false);
        UnifiedPush.unregister(getContext(), "default");
        PushRegistrar.clearEndpoint(getContext());
        call.resolve();
    }

    /**
     * Opens a chat in a bubble that floats over other apps (Android 11 and up). The web client
     * calls this when someone pops a chat out; the title comes from the page, never from a push.
     * Resolves { ok: false, reason } when bubbles can't show: "unsupported" (older Android),
     * "notifications-off", or "bubbles-off" (turned off for the app in Android's settings).
     */
    @PluginMethod
    public void bubble(PluginCall call) {
        Context ctx = getContext();
        Long cidValue = call.getLong("conversationId");
        String title = call.getString("title", "Dendrop");
        JSObject result = new JSObject();
        if (cidValue == null || cidValue <= 0) {
            call.reject("conversationId is required");
            return;
        }
        long cid = cidValue;
        if (Build.VERSION.SDK_INT < 30) {
            result.put("ok", false);
            result.put("reason", "unsupported");
            call.resolve(result);
            return;
        }
        NotificationManagerCompat nmc = NotificationManagerCompat.from(ctx);
        if (!nmc.areNotificationsEnabled()) {
            result.put("ok", false);
            result.put("reason", "notifications-off");
            call.resolve(result);
            return;
        }
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 31 && nm.getBubblePreference() == NotificationManager.BUBBLE_PREFERENCE_NONE) {
            result.put("ok", false);
            result.put("reason", "bubbles-off");
            call.resolve(result);
            return;
        }
        Notifier.createChannels(ctx);
        String name = title == null || title.trim().isEmpty() ? "Dendrop" : title.trim();
        if (name.length() > 60) name = name.substring(0, 60);
        IconCompat icon = IconCompat.createWithResource(ctx, R.mipmap.ic_launcher_round);
        Person chat = new Person.Builder().setName(name).setIcon(icon).setKey("chat-" + cid).build();
        Person me = new Person.Builder().setName("You").build();
        // Bubbles belong to a conversation shortcut.
        String shortcutId = "chat-" + cid;
        Intent openApp = new Intent(ctx, MainActivity.class).setAction(Intent.ACTION_VIEW);
        ShortcutInfoCompat shortcut = new ShortcutInfoCompat.Builder(ctx, shortcutId)
            .setLongLived(true)
            .setShortLabel(name)
            .setIcon(icon)
            .setPerson(chat)
            .setIntent(openApp)
            .build();
        ShortcutManagerCompat.pushDynamicShortcut(ctx, shortcut);

        Intent target = new Intent(ctx, BubbleActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .setData(android.net.Uri.parse("dendrop-chat://" + cid))
            .putExtra(BubbleActivity.EXTRA_CONVERSATION, cid);
        // Bubbles need a mutable intent.
        PendingIntent bubbleIntent = PendingIntent.getActivity(ctx, (int) (cid % 100000), target, PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.BubbleMetadata bubble = new NotificationCompat.BubbleMetadata.Builder(bubbleIntent, icon)
            .setDesiredHeight(600)
            .setAutoExpandBubble(true)
            .setSuppressNotification(true)
            .build();
        NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, Notifier.CHANNEL_BUBBLES)
            .setSmallIcon(R.drawable.ic_stat_dendrop)
            .setColor(ctx.getColor(R.color.dd_accent))
            .setContentTitle(name)
            .setContentText(ctx.getString(R.string.bubble_text))
            .setContentIntent(bubbleIntent)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setShortcutId(shortcutId)
            .setBubbleMetadata(bubble)
            .setStyle(new NotificationCompat.MessagingStyle(me).setConversationTitle(name).addMessage(ctx.getString(R.string.bubble_text), System.currentTimeMillis(), chat))
            .setOnlyAlertOnce(true);
        try {
            nmc.notify(Notifier.ID_BUBBLE_BASE + (int) (cid % 1_000_000), builder.build());
        } catch (SecurityException e) {
            result.put("ok", false);
            result.put("reason", "notifications-off");
            call.resolve(result);
            return;
        }
        result.put("ok", true);
        call.resolve(result);
    }

    /** Returns null when a Dendrop server answers at url, or what went wrong. */
    private static String checkServer(String url) {
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(url + "/api/auth/info").openConnection();
            conn.setConnectTimeout(10_000);
            conn.setReadTimeout(10_000);
            int code = conn.getResponseCode();
            if (code != 200) return "Something answered at " + url + ", but it isn't a Dendrop server (HTTP " + code + ").";
            try (InputStream in = conn.getInputStream()) {
                JSONObject info = new JSONObject(new String(PushRegistrar.readAll(in), StandardCharsets.UTF_8));
                if (!info.has("localLogin") && !info.has("oidc")) return "Something answered at " + url + ", but it isn't a Dendrop server.";
            }
            return null;
        } catch (javax.net.ssl.SSLException e) {
            return "Couldn't make a secure connection to " + url + ". Check its HTTPS certificate.";
        } catch (java.net.UnknownHostException e) {
            return "Couldn't find " + url + ". Check the address, and that you're on the right network.";
        } catch (Exception e) {
            return "Couldn't reach " + url + " (" + e.getClass().getSimpleName() + ").";
        }
    }
}
