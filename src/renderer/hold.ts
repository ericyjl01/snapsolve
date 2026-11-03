// Hold to talk on the mic buttons (task 096, SPEC Amendment 27): the main button pressed on a mic, or Space / Enter on a
// focused one, holds. A pointer hold is let go when the pointer comes up anywhere in the window or is cancelled; a key
// hold when that key comes up anywhere (the composer's mic is hidden by the listening bar while held, so focus has left
// it); either when the window loses focus. Letting go sends what was heard; main decides whether a hold was too short.

/** Binds `buttons`; `onHold(true)` once per hold, `onHold(false)` once when it is let go. */
export function bindHold(buttons: readonly HTMLElement[], win: Window, onHold: (held: boolean) => void): void {
  /** What holds the mic now, or null. */
  let by: "pointer" | "key" | null = null;
  const down = (source: "pointer" | "key", event: Event) => {
    event.preventDefault();
    if (by) return;
    by = source;
    onHold(true);
  };
  const up = (source?: "pointer" | "key") => {
    if (!by || (source && by !== source)) return;
    by = null;
    onHold(false);
  };
  const holdKey = (event: KeyboardEvent) => event.key === " " || event.key === "Enter";
  for (const button of buttons) {
    button.addEventListener("pointerdown", (event) => {
      if ((event as MouseEvent).button === 0) down("pointer", event);
    });
    button.addEventListener("keydown", (event) => {
      if (!holdKey(event)) return;
      event.preventDefault();
      if (!event.repeat) down("key", event);
    });
  }
  // Capture phase on the window: the up counts wherever it lands.
  win.addEventListener(
    "pointerup",
    (event) => {
      if ((event as MouseEvent).button === 0) up("pointer");
    },
    true,
  );
  win.addEventListener("pointercancel", () => up("pointer"), true);
  win.addEventListener(
    "keyup",
    (event) => {
      if (holdKey(event as KeyboardEvent)) up("key");
    },
    true,
  );
  win.addEventListener("blur", () => up());
}
