package io.github.spacegoose02.dendrop;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AlertDialog;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Tells people when a newer Dendrop app is out. The chat itself comes from their server and is
 * always current, but this app (setup page, notifications, calls) only changes when a new APK is
 * installed. It looks at the latest GitHub release at most twice a day and offers to download the
 * APK of the same kind (debug or release) as this one. Android itself asks before installing it.
 */
final class UpdateChecker {

    static final String RELEASE_REPO = "Spacegoose02/dendrop";
    private static final String LATEST = "https://api.github.com/repos/" + RELEASE_REPO + "/releases/latest";
    private static final long CHECK_EVERY_MS = 12L * 3600_000;
    private static final long REMIND_AFTER_MS = 24L * 3600_000;

    private static final String KEY_LAST_CHECK = "updateLastCheck";
    private static final String KEY_SNOOZED_UNTIL = "updateSnoozedUntil";
    private static final String KEY_SKIPPED = "updateSkippedVersion";

    private static final ExecutorService executor = Executors.newSingleThreadExecutor();
    private static boolean running = false;
    private static boolean showing = false;

    private UpdateChecker() {}

    /** A newer app build: its version and where to get it. */
    static final class Update {
        final String version;
        final String url;

        Update(String version, String url) {
            this.version = version;
            this.url = url;
        }
    }

    /** Checks in the background when it's time, and asks on the activity if there's an update. */
    static void maybeCheck(Activity activity) {
        SharedPreferences prefs = ServerSettings.prefs(activity);
        long now = System.currentTimeMillis();
        if (running || showing) return;
        if (now - prefs.getLong(KEY_LAST_CHECK, 0) < CHECK_EVERY_MS) return;
        if (now < prefs.getLong(KEY_SNOOZED_UNTIL, 0)) return;
        running = true;
        String current = BuildConfig.VERSION_NAME;
        boolean debug = BuildConfig.BUILD_TYPE.equals("debug");
        Handler main = new Handler(Looper.getMainLooper());
        executor.execute(() -> {
            Update found = null;
            boolean checked = false;
            try {
                found = pick(new JSONObject(get(LATEST)), current, debug);
                checked = true;
            } catch (Exception ignored) {
                // Offline or GitHub is busy: try again next time the app comes to the front.
            }
            Update update = found;
            boolean ok = checked;
            main.post(() -> {
                running = false;
                if (ok) prefs.edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply();
                if (update == null || update.version.equals(prefs.getString(KEY_SKIPPED, null))) return;
                if (activity.isFinishing() || activity.isDestroyed()) return;
                ask(activity, prefs, update);
            });
        });
    }

    private static void ask(Activity activity, SharedPreferences prefs, Update update) {
        showing = true;
        new AlertDialog.Builder(activity)
            .setTitle("Dendrop " + update.version + " is out")
            .setMessage(
                "You have " + BuildConfig.VERSION_NAME.replace("-debug", "") + ". Download the new app, then open it to install. " +
                "Android may ask you to allow installs from your browser first."
            )
            .setPositiveButton("Download", (d, w) -> {
                try {
                    activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(update.url)));
                } catch (ActivityNotFoundException ignored) {
                    // No browser to hand the download to.
                }
            })
            .setNeutralButton("Skip this version", (d, w) -> prefs.edit().putString(KEY_SKIPPED, update.version).apply())
            .setNegativeButton("Not now", (d, w) -> prefs.edit().putLong(KEY_SNOOZED_UNTIL, System.currentTimeMillis() + REMIND_AFTER_MS).apply())
            .setOnDismissListener((d) -> showing = false)
            .show();
    }

    /**
     * The update in a GitHub release, when it's newer than current. Prefers the APK of the same
     * kind as this build (Dendrop-X-android-debug.apk or Dendrop-X-android.apk); without one, the
     * release page.
     */
    @Nullable
    static Update pick(JSONObject release, String current, boolean debug) {
        String tag = release.optString("tag_name", "");
        String version = tag.startsWith("v") ? tag.substring(1) : tag;
        if (version.isEmpty() || compareVersions(version, current) <= 0) return null;
        String suffix = debug ? "-android-debug.apk" : "-android.apk";
        String url = release.optString("html_url", "https://github.com/" + RELEASE_REPO + "/releases/latest");
        JSONArray assets = release.optJSONArray("assets");
        if (assets != null) {
            for (int i = 0; i < assets.length(); i++) {
                JSONObject a = assets.optJSONObject(i);
                if (a == null) continue;
                String name = a.optString("name", "");
                String download = a.optString("browser_download_url", "");
                if (name.endsWith(suffix) && download.startsWith("https://github.com/")) {
                    url = download;
                    break;
                }
            }
        }
        return new Update(version, url);
    }

    /** -1, 0 or 1 for dotted versions ("0.10.0" > "0.9.3"); "-debug" and such count as nothing. */
    static int compareVersions(String a, String b) {
        String[] x = a.split("[.-]");
        String[] y = b.split("[.-]");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int d = Integer.compare(number(x, i), number(y, i));
            if (d != 0) return d > 0 ? 1 : -1;
        }
        return 0;
    }

    private static int number(String[] parts, int i) {
        if (i >= parts.length) return 0;
        try {
            return Integer.parseInt(parts[i]);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(15_000);
        c.setRequestProperty("Accept", "application/vnd.github+json");
        c.setRequestProperty("User-Agent", "Dendrop-android");
        try {
            if (c.getResponseCode() != 200) throw new Exception("GitHub answered " + c.getResponseCode());
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return out.toString(StandardCharsets.UTF_8.name());
            }
        } finally {
            c.disconnect();
        }
    }
}
