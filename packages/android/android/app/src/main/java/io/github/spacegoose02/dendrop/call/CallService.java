package io.github.spacegoose02.dendrop.call;

import android.Manifest;
import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import io.github.spacegoose02.dendrop.MainActivity;
import io.github.spacegoose02.dendrop.R;
import io.github.spacegoose02.dendrop.push.CallActionReceiver;
import io.github.spacegoose02.dendrop.push.Notifier;

/**
 * Keeps a call going with the screen off or the app in the background: a foreground service
 * (Android lets a foreground service keep using the microphone) that also holds the CPU and
 * Wi-Fi awake. It shows the "Call in progress" notification, with Hang up. Started and stopped
 * by the web page when it joins and leaves a call.
 */
public class CallService extends Service {

    private static final String EXTRA_CONVERSATION = "conversationId";
    private static final String TAG = "dendrop:call";

    @Nullable
    private PowerManager.WakeLock cpu;
    @Nullable
    private WifiManager.WifiLock wifi;

    /** True when Android will let the service use the microphone (it needs the permission first). */
    static boolean canStart(Context context) {
        return ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    /** Starts (or updates) the service for a call. Returns false when Android didn't allow it yet. */
    public static boolean start(Context context, int conversationId) {
        if (!canStart(context)) return false;
        Intent intent = new Intent(context, CallService.class).putExtra(EXTRA_CONVERSATION, conversationId);
        try {
            ContextCompat.startForegroundService(context, intent);
            return true;
        } catch (RuntimeException e) {
            // Started from the background (not allowed on Android 12 and newer).
            return false;
        }
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, CallService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        int cid = intent == null ? 0 : intent.getIntExtra(EXTRA_CONVERSATION, 0);
        Notifier.createChannels(this);
        int type = Build.VERSION.SDK_INT >= 30 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0;
        try {
            ServiceCompat.startForeground(this, Notifier.ID_ONGOING_CALL, notification(cid), type);
        } catch (RuntimeException e) {
            // The microphone permission was taken away, or the app is in the background.
            stopSelf();
            return START_NOT_STICKY;
        }
        holdLocks();
        return START_NOT_STICKY;
    }

    private Notification notification(int cid) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, Notifier.ID_ONGOING_CALL, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent hangUp = new Intent(this, CallActionReceiver.class)
            .setAction(CallActionReceiver.ACTION_HANG_UP)
            .putExtra(CallActionReceiver.EXTRA_CONVERSATION, cid);
        PendingIntent end = PendingIntent.getBroadcast(this, Notifier.ID_ONGOING_CALL, hangUp, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, Notifier.CHANNEL_ONGOING_CALL)
            .setSmallIcon(R.drawable.ic_stat_dendrop)
            .setColor(getColor(R.color.dd_accent))
            .setContentTitle(getString(R.string.notify_ongoing_title))
            .setContentText(getString(R.string.notify_ongoing_text))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setUsesChronometer(true)
            .setWhen(System.currentTimeMillis())
            .setContentIntent(tap)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, getString(R.string.notify_call_hang_up), end)
            .build();
    }

    private void holdLocks() {
        if (cpu == null) {
            PowerManager pm = getSystemService(PowerManager.class);
            cpu = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, TAG);
            cpu.setReferenceCounted(false);
            // A safety net: a call left running for hours lets the phone sleep again.
            cpu.acquire(4 * 60 * 60_000L);
        }
        if (wifi == null) {
            WifiManager wm = getApplicationContext().getSystemService(WifiManager.class);
            if (wm != null) {
                int mode = Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifi = wm.createWifiLock(mode, TAG);
                wifi.setReferenceCounted(false);
                wifi.acquire();
            }
        }
    }

    @Override
    public void onDestroy() {
        if (cpu != null && cpu.isHeld()) cpu.release();
        if (wifi != null && wifi.isHeld()) wifi.release();
        cpu = null;
        wifi = null;
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
