// Which provider and model a checker runs on, and what a checker that could
// not run says about it. Pure, so the choice and the words can be tested.

/** Where a checker's provider or model came from. */
export type ChosenBy = "given" | "setting" | "inherited" | "default";

export interface CheckerChoice {
  /** Null for bb's default. */
  provider: string | null;
  /** Null for the provider's default model. */
  model: string | null;
  chosen: { provider: ChosenBy; model: ChosenBy };
}

/**
 * The provider and model for a check. In order: what the command gave, cow's
 * settings, then the thread that submitted the brief: it ran on its provider,
 * so that one is known to work here. bb's default comes last, only when none
 * of these says anything. A model goes with its provider: the submitting
 * thread's model is used only on the submitting thread's provider, and a
 * provider given to the command is not paired with a model from the settings.
 */
export function chooseChecker(
  given: { provider?: string | null; model?: string | null },
  settings: { provider: string | null; model: string | null },
  inherited: { provider: string | null; model: string | null },
): CheckerChoice {
  const provider: [string | null, ChosenBy] =
    given.provider !== undefined ? [given.provider, "given"]
    : settings.provider !== null ? [settings.provider, "setting"]
    : inherited.provider !== null ? [inherited.provider, "inherited"]
    : [null, "default"];
  const own: [string | null, ChosenBy] =
    provider[0] !== null && provider[0] === inherited.provider && inherited.model !== null ? [inherited.model, "inherited"] : [null, "default"];
  const model: [string | null, ChosenBy] =
    given.model !== undefined ? [given.model, "given"]
    : provider[1] !== "given" && settings.model !== null ? [settings.model, "setting"]
    : own;
  return { provider: provider[0], model: model[0], chosen: { provider: provider[1], model: model[1] } };
}

/** What bb recorded about a checker's failed turn. Every field may be missing. */
export interface CheckerFailure {
  /** bb's category for a provider error, such as "unauthorized". */
  category: string | null;
  /** What the provider said, as bb recorded it. */
  detail: string | null;
  httpStatus: number | null;
}

const CAUSES: Record<string, string> = {
  unauthorized: "the provider is not signed in",
  billing: "the provider refused it for billing",
  "rate-limit": "the provider's usage limit was reached",
  "budget-exceeded": "the provider's budget is used up",
  overloaded: "the provider is overloaded",
  "connection-failed": "the provider could not be reached",
  "stream-disconnected": "the connection to the provider dropped",
  "context-window-exceeded": "the brief was too long for the model",
  "bad-request": "the provider refused the request",
  policy: "the provider refused it under its usage policy",
  sandbox: "the sandbox stopped it",
};

/** "codex, model gpt-x", "claude-code, its default model", "bb's default provider and model". */
export function checkerOn(provider: string | null, model: string | null): string {
  if (provider === null) return model === null ? "bb's default provider and model" : `bb's default provider, model ${model}`;
  return model === null ? `${provider}, its default model` : `${provider}, model ${model}`;
}

const MAX_DETAIL = 400;
const oneLine = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL - 1)}…` : flat;
};

/** The command that runs the check again elsewhere. */
export const againCommand = (threadId: string) => `bb cow brief check ${threadId} --provider <provider> --model <model>`;

/** The cause in plain words, then what bb said. */
function causeText(failure: CheckerFailure | null): string {
  if (failure === null) return "bb recorded no cause";
  const { category, httpStatus } = failure;
  const plain =
    httpStatus === 401 ? CAUSES.unauthorized
    : category === "bad-request" && httpStatus === 404 ? "the provider does not have that model, or not for this account"
    : category !== null ? (CAUSES[category] ?? `the provider reported an error (${category})`)
    : null;
  const said = failure.detail === null || failure.detail.trim() === "" ? null : `bb said: "${oneLine(failure.detail)}"`;
  if (plain !== null && said !== null) return `${plain} (${said})`;
  return plain ?? said ?? "bb recorded no cause";
}

/** The failures another provider or model could get past: not signed in, no such model, billing, limits, a brief too long for the model. */
const FIXABLE = new Set(["unauthorized", "billing", "rate-limit", "budget-exceeded", "overloaded", "context-window-exceeded"]);

/** Could running the check on another provider fix this failed turn? */
export function providerCouldFix(failure: CheckerFailure | null): boolean {
  if (failure === null) return false;
  if (failure.httpStatus === 401 || failure.httpStatus === 402 || failure.httpStatus === 429) return true;
  if (failure.category === "bad-request" && failure.httpStatus === 404) return true;
  return failure.category !== null && FIXABLE.has(failure.category);
}

/** Could another provider fix a refusal to start? Only when bb's words name the provider, the model, signing in, billing or a limit. */
export function startCouldFix(cause: string): boolean {
  return /\bprovider\b|\bmodel\b|unauthori[sz]ed|\bsign(?:ed)?[ -]?in\b|\blog(?:ged)?[ -]?in\b|\bbilling\b|\bquota\b|rate[ -]?limit|usage limit|\bbudget\b|\bHTTP (?:401|402|429)\b/i.test(cause);
}

const hint = (fixable: boolean, threadId: string) => (fixable ? ` To check it on another provider: ${againCommand(threadId)}` : "");

/** A checker's failed turn, said plainly: where it ran and why it failed, and, when another provider could help, how to run it there. */
export function turnFailedText(args: { provider: string | null; model: string | null; failure: CheckerFailure | null; threadId: string }): string {
  return `the checker's turn failed on ${checkerOn(args.provider, args.model)}: ${causeText(args.failure)}.${hint(providerCouldFix(args.failure), args.threadId)}`;
}

const bare = (cause: string) => oneLine(cause).replace(/[.\s]+$/, "");

/** A checker bb would not start, said the same way. */
export function startFailedText(args: { provider: string | null; model: string | null; cause: string; threadId: string }): string {
  return `the checker could not be started on ${checkerOn(args.provider, args.model)}: ${bare(args.cause)}.${hint(startCouldFix(args.cause), args.threadId)}`;
}

/**
 * A checker that had nowhere to start: bb would make it a personal workspace
 * neither on its primary machine nor on the submitting thread's. The thread's
 * own environment is not used instead, and another provider would not help,
 * so none is suggested.
 */
export function nowhereText(args: { primary: string; machine: string | null; threadId: string }): string {
  const machine = args.machine === null ? "; the thread is on no machine bb knows, so there was no other to try" : `; on the thread's machine: ${bare(args.machine)}`;
  return (
    `the checker could not be started: bb would not make it a personal workspace (on bb's primary machine: ${bare(args.primary)}${machine}). ` +
    `A checker runs only in an empty workspace of its own, never in the thread's checkout. ` +
    `When a machine of yours is connected, check it again: bb cow brief check ${args.threadId}`
  );
}

/** What bb recorded about a failed turn, read from the thread's events, newest first. */
export function failureOf(events: readonly { type: string; data?: unknown }[]): CheckerFailure | null {
  let fromTurn: string | null = null;
  for (const event of events) {
    const data = (typeof event.data === "object" && event.data !== null ? event.data : {}) as Record<string, unknown>;
    if (event.type === "provider/error") {
      const info = (typeof data.errorInfo === "object" && data.errorInfo !== null ? data.errorInfo : {}) as Record<string, unknown>;
      const detail = typeof data.detail === "string" && data.detail.trim() !== "" ? data.detail : typeof data.message === "string" ? data.message : null;
      return {
        category: typeof info.category === "string" ? info.category : null,
        detail: detail ?? fromTurn,
        httpStatus: typeof info.httpStatusCode === "number" ? info.httpStatusCode : null,
      };
    }
    if (event.type === "turn/completed" && fromTurn === null) {
      const error = (typeof data.error === "object" && data.error !== null ? data.error : {}) as Record<string, unknown>;
      if (typeof error.message === "string" && error.message.trim() !== "") fromTurn = error.message;
    }
  }
  return fromTurn === null ? null : { category: null, detail: fromTurn, httpStatus: null };
}
