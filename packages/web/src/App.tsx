import { useEffect, useState } from "react";
import type { AuthInfo, Me } from "@dendrop/shared";
import { ApiError, getAuthInfo, getMe } from "./api.ts";
import { Login } from "./Login.tsx";
import { Shell } from "./Shell.tsx";

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "signedOut"; info: AuthInfo } | { kind: "signedIn"; me: Me };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = async () => {
    try {
      setState({ kind: "signedIn", me: await getMe() });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        try {
          setState({ kind: "signedOut", info: await getAuthInfo() });
        } catch (e) {
          setState({ kind: "error", message: (e as Error).message });
        }
      } else setState({ kind: "error", message: (err as Error).message });
    }
  };

  useEffect(() => {
    void load();
  }, []);

  switch (state.kind) {
    case "loading":
      return <div className="center muted">Waking up the den…</div>;
    case "error":
      return <div className="center error">Can't reach the Dendrop server: {state.message}</div>;
    case "signedOut":
      return <Login info={state.info} onSignedIn={(me) => setState({ kind: "signedIn", me })} />;
    case "signedIn":
      return <Shell me={state.me} onSignedOut={() => void load()} />;
  }
}
