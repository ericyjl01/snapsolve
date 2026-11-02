// Hold to talk on the mic buttons (task 096, SPEC Amendment 27): the main button pressed on a mic, or Space / Enter on a
// focused one, holds; it is let go when the pointer comes up anywhere in the window (the composer's mic is hidden by
// the listening bar while held), the pointer is cancelled, the key comes up, or the window loses focus. Letting go
// sends what was heard; main decides whether a hold was too short.

/** Binds `buttons`; `onHold(true)` once per hold, `onHold(false)` once when it is let go. */
export function bindHold(buttons: readonly HTMLElement[], win: Window, onHold: (held: boolean) => void): void {
  let held = false;
  const down = (event: Event) => {
    event.preventDefault();
    if (held) return;
    held = true;
    onHold(true);
  };
  const up = () => {
    if (!held) return;
    held = false;
    onHold(false);
  };
  const holdKey = (event: KeyboardEvent) => event.key === " " || event.key === "Enter";
  for (const button of buttons) {
    button.addEventListener("pointerdown", (event) => {
      if ((event as MouseEvent).button === 0) down(event);
    });
    button.addEventListener("keydown", (event) => {
      if (!holdKey(event)) return;
      event.preventDefault();
      if (!event.repeat) down(event);
    });
    button.addEventListener("keyup", (event) => {
      if (holdKey(event)) up();
    });
  }
  // Capture phase: the up counts wherever it lands.
  win.addEventListener("pointerup", (event) => {
    if ((event as MouseEvent).button === 0) up();
  }, true);
  win.addEventListener("pointercancel", up, true);
  win.addEventListener("blur", up);
}
