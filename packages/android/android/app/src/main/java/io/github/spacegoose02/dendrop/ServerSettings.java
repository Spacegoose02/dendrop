package io.github.spacegoose02.dendrop;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import androidx.annotation.Nullable;

/** The Dendrop server this app talks to, kept in the app's private preferences. */
public final class ServerSettings {

    private static final String PREFS = "dendrop";
    private static final String KEY_SERVER_URL = "serverUrl";

    private ServerSettings() {}

    static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** The saved server origin, such as https://chat.example.com, or null before setup. */
    @Nullable
    public static String getServerUrl(Context context) {
        return prefs(context).getString(KEY_SERVER_URL, null);
    }

    static void setServerUrl(Context context, @Nullable String url) {
        prefs(context).edit().putString(KEY_SERVER_URL, url).apply();
    }

    /**
     * Turns what someone typed into a server origin: adds https:// when no scheme was given and
     * drops any path, since the web client is always served from the root.
     * Returns null when it isn't a usable http(s) address.
     */
    @Nullable
    static String normalize(@Nullable String input) {
        if (input == null) return null;
        String s = input.trim();
        if (s.isEmpty()) return null;
        if (!s.contains("://")) s = "https://" + s;
        Uri uri = Uri.parse(s);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if (!scheme.equals("https") && !scheme.equals("http")) return null;
        String host = uri.getHost();
        if (host == null || host.isEmpty()) return null;
        int port = uri.getPort();
        return scheme + "://" + host.toLowerCase() + (port > 0 ? ":" + port : "");
    }
}
