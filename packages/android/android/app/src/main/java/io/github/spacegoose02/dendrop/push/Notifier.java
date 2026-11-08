package io.github.spacegoose02.dendrop.push;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import io.github.spacegoose02.dendrop.MainActivity;
import io.github.spacegoose02.dendrop.R;

/**
 * Shows Dendrop's notifications. They never contain message text, sender names or anything else
 * from the chat: only that something happened. Opening the app shows the rest.
 */
public final class Notifier {

    public static final String CHANNEL_MESSAGES = "messages";
    public static final String CHANNEL_CALLS = "calls";

    private static final int ID_MESSAGES = 1;
    private static final int ID_CALL = 2;
    private static final int ID_EVENT = 3;

    private Notifier() {}

    public static void createChannels(Context context) {
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        NotificationChannel messages = new NotificationChannel(
            CHANNEL_MESSAGES,
            context.getString(R.string.channel_messages),
            NotificationManager.IMPORTANCE_HIGH
        );
        messages.setDescription(context.getString(R.string.channel_messages_description));
        messages.setLockscreenVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        NotificationChannel calls = new NotificationChannel(
            CHANNEL_CALLS,
            context.getString(R.string.channel_calls),
            NotificationManager.IMPORTANCE_HIGH
        );
        calls.setDescription(context.getString(R.string.channel_calls_description));
        nm.createNotificationChannel(messages);
        nm.createNotificationChannel(calls);
    }

    /** "You have a new message", with no content. Repeats update one notification. */
    static void showMessage(Context context) {
        show(
            context,
            ID_MESSAGES,
            new NotificationCompat.Builder(context, CHANNEL_MESSAGES)
                .setContentTitle(context.getString(R.string.notify_message_title))
                .setContentText(context.getString(R.string.notify_message_text))
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
        );
    }

    /** "An event you're going to starts soon", with no name or server. */
    static void showEvent(Context context) {
        show(
            context,
            ID_EVENT,
            new NotificationCompat.Builder(context, CHANNEL_MESSAGES)
                .setContentTitle(context.getString(R.string.notify_event_title))
                .setContentText(context.getString(R.string.notify_event_text))
                .setCategory(NotificationCompat.CATEGORY_EVENT)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setTimeoutAfter(60 * 60_000)
        );
    }

    /**
     * A heads-up "Incoming call". The full-screen incoming call screen comes with voice calls
     * (see the README); this is the placeholder until then.
     */
    static void showCall(Context context) {
        show(
            context,
            ID_CALL,
            new NotificationCompat.Builder(context, CHANNEL_CALLS)
                .setContentTitle(context.getString(R.string.notify_call_title))
                .setContentText(context.getString(R.string.notify_call_text))
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setTimeoutAfter(45_000)
        );
    }

    /** Clears the content-free notifications, for when the app is opened. */
    public static void clear(Context context) {
        NotificationManagerCompat.from(context).cancel(ID_MESSAGES);
    }

    private static void show(Context context, int id, NotificationCompat.Builder builder) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(context);
        if (!nm.areNotificationsEnabled()) return;
        Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(context, id, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        builder
            .setSmallIcon(R.drawable.ic_stat_dendrop)
            .setColor(context.getColor(R.color.dd_accent))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        try {
            nm.notify(id, builder.build());
        } catch (SecurityException e) {
            // Notification permission was revoked between the check and the call.
        }
    }
}
