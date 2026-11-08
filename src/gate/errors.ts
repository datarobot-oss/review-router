/** The App behind the gate's token is not the App that `gate-app-id` names. */
export class GateAppMismatchError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number | undefined
  ) {
    super(
      `gate-app-id is ${expected}, but the check was created by App ${actual ?? "unknown"}. ` +
        "Set gate-app-id to the App behind github-token."
    );
    this.name = "GateAppMismatchError";
  }
}
