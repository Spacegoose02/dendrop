package io.github.spacegoose02.dendrop.call;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import io.github.spacegoose02.dendrop.MainActivity;

/**
 * "Answer" on the incoming call notification. It's declared to show over the lock screen, so
 * Android doesn't ask to unlock first; it passes the answer on and opens the app over the lock
 * screen, where the page joins the call. It has no screen of its own.
 */
public class CallAnswerActivity extends Activity {

    public static final String EXTRA_CONVERSATION = "conversationId";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent in = getIntent();
        Integer cid = in.hasExtra(EXTRA_CONVERSATION) ? in.getIntExtra(EXTRA_CONVERSATION, 0) : IncomingCalls.ringingConversation();
        IncomingCalls.stop(this);
        // Answers with the camera off, like Answer on the in-app call screen; it can be turned on in the call.
        NativeCalls.answered(cid, false);
        startActivity(
            new Intent(this, MainActivity.class)
                .setAction(MainActivity.ACTION_ANSWER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
        );
        finish();
    }
}
