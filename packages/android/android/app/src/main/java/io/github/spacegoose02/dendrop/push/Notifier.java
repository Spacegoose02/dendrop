package io.github.spacegoose02.dendrop.push;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.app.Notification;
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
    /** Rings like a phone call. (The first "calls" channel was a plain heads-up; channels can't change sound once made.) */
    public static final String CHANNEL_CALLS = "calls_ringing";
    private static final String OLD_CHANNEL_CALLS = "calls";
    public static final String CHANNEL_BUBBLES = "bubbles";
    /** Opens the app on the incoming call screen (over the lock screen). */
    public static final String ACTION_CALL = "io.github.spacegoose02.dendrop.CALL";

    private static final int ID_MESSAGES = 1;
    private static final int ID_CALL = 2;
    private static final int ID_EVENT = 3;
    private static final int ID_MENTION = 4;
    /** Bubbles are 1000 + the conversation id, one per chat. */
    public static final int ID_BUBBLE_BASE = 1000;

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
        calls.setSound(
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
            new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        );
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] { 0, 800, 600, 800, 600 });
        calls.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        NotificationChannel bubbles = new NotificationChannel(
            CHANNEL_BUBBLES,
            context.getString(R.string.channel_bubbles),
            NotificationManager.IMPORTANCE_HIGH
        );
        bubbles.setDescription(context.getString(R.string.channel_bubbles_description));
        bubbles.setSound(null, null);
        if (android.os.Build.VERSION.SDK_INT >= 29) bubbles.setAllowBubbles(true);
        nm.deleteNotificationChannel(OLD_CHANNEL_CALLS);
        nm.createNotificationChannel(messages);
        nm.createNotificationChannel(calls);
        nm.createNotificationChannel(bubbles);
    }

    /**
     * "You have a new message", or "Someone mentioned you", with no content. Repeats update one
     * notification of each, so a mention isn't hidden by the chatter after it.
     */
    static void showMessage(Context context, boolean mention) {
        show(
            context,
            mention ? ID_MENTION : ID_MESSAGES,
            new NotificationCompat.Builder(context, CHANNEL_MESSAGES)
                .setContentTitle(context.getString(R.string.notify_message_title))
                .setContentText(context.getString(mention ? R.string.notify_mention_text : R.string.notify_message_text))
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
     * The incoming call screen: rings like a phone call and, on a locked or idle phone, opens the
     * app full screen over the lock screen (where the app's own ringer lets you answer). Still
     * content-free: it never says who is calling. Stops after 45 seconds, like the call.
     */
    static void showCall(Context context) {
        NotificationManagerCompat nm = NotificationManagerCompat.from(context);
        if (!nm.areNotificationsEnabled()) return;
        Intent answer = new Intent(context, MainActivity.class)
            .setAction(ACTION_CALL)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent open = PendingIntent.getActivity(context, ID_CALL, answer, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent silence = new Intent(context, CallActionReceiver.class).setAction(CallActionReceiver.ACTION_SILENCE);
        PendingIntent dismiss = PendingIntent.getBroadcast(context, ID_CALL, silence, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_stat_dendrop)
            .setColor(context.getColor(R.color.dd_accent))
            .setContentTitle(context.getString(R.string.notify_call_title))
            .setContentText(context.getString(R.string.notify_call_text))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(open)
            .setFullScreenIntent(open, true)
            .setOngoing(true)
            .setAutoCancel(true)
            .setTimeoutAfter(45_000)
            .addAction(0, context.getString(R.string.notify_call_answer), open)
            .addAction(0, context.getString(R.string.notify_call_silence), dismiss);
        Notification n = builder.build();
        // Keep ringing until answered, silenced or timed out, like a phone.
        n.flags |= Notification.FLAG_INSISTENT;
        try {
            nm.notify(ID_CALL, n);
        } catch (SecurityException e) {
            // Notification permission was revoked between the check and the call.
        }
    }

    /** Stops the incoming call ringing on this phone. */
    public static void clearCall(Context context) {
        NotificationManagerCompat.from(context).cancel(ID_CALL);
    }

    /** Clears the content-free notifications, for when the app is opened. */
    public static void clear(Context context) {
        NotificationManagerCompat.from(context).cancel(ID_MESSAGES);
        NotificationManagerCompat.from(context).cancel(ID_MENTION);
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
