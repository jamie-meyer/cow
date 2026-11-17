// Command rules: reading a command line as plain words, or refusing to.
// Everything here is pure.
//
// cow never runs a shell to find out what a command line means. It reads it
// with the small grammar below, and anything outside that grammar is "not
// plain words": no rule can be made from it, and no prefix rule covers it.
// The grammar is deliberately narrower than a shell's, so that every command
// line it accepts means the same words to sh, bash and zsh.

/** The longest command line read; longer is refused, not truncated. */
export const MAX_COMMAND = 4000;
/** The most words read. */
export const MAX_WORDS = 200;

export type Words = { ok: true; words: string[] } | { ok: false; why: string };

/** What may stand in a word without quotes. Everything a shell expands, joins or redirects with is left out. */
const BARE = /[A-Za-z0-9_@%+=:,./-]/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const named = (char: string): string => {
  if (char === "\n" || char === "\r") return "a line break";
  if (char === "\t") return "a tab";
  if (CONTROL.test(char)) return "a control character";
  return `“${char}”`;
};

/**
 * Split a command line into plain words, or say why it is not one.
 *
 * Accepted:
 * - words of letters, digits and `_ @ % + = : , . / -`, separated by spaces
 *   or tabs;
 * - text in single quotes, taken as it stands;
 * - text in double quotes with no `$`, backtick, backslash or `!` in it;
 * - quoted and unquoted pieces side by side, which make one word.
 *
 * Refused, wherever it stands outside single quotes: `; & | < > ( ) { } [ ]
 * * ? ~ ! # $ ^` and the backtick and backslash, any line break or other
 * control character, an unclosed quote, a first word that is a variable
 * assignment (`NAME=value`), and a word that starts with `=` (zsh expands
 * it). A control character is refused inside quotes too.
 */
export function splitWords(command: unknown): Words {
  if (typeof command !== "string") return { ok: false, why: "it is not text" };
  if (command.length > MAX_COMMAND) return { ok: false, why: `it is over ${MAX_COMMAND} characters` };
  const words: string[] = [];
  let word = "";
  /** A word has begun, even if it is empty so far (`''`). */
  let open = false;
  let quote: "'" | '"' | null = null;
  const end = () => {
    if (open) words.push(word);
    word = "";
    open = false;
  };
  for (const char of command) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (CONTROL.test(char)) return { ok: false, why: `it has ${named(char)} inside quotes` };
      else if (quote === '"' && (char === "$" || char === "`" || char === "\\" || char === "!")) {
        return { ok: false, why: `it has ${named(char)} inside double quotes, which a shell expands` };
      } else word += char;
      continue;
    }
    if (char === " " || char === "\t") {
      end();
    } else if (char === "'" || char === '"') {
      quote = char;
      open = true;
    } else if (BARE.test(char)) {
      if (!open && char === "=") return { ok: false, why: "a word starts with “=”, which zsh expands" };
      open = true;
      word += char;
    } else {
      return { ok: false, why: `it has ${named(char)} in it, which a shell does not take as plain text` };
    }
    if (words.length > MAX_WORDS) return { ok: false, why: `it is over ${MAX_WORDS} words` };
  }
  if (quote !== null) return { ok: false, why: "a quote is not closed" };
  end();
  if (words.length === 0) return { ok: false, why: "it is empty" };
  if (words.length > MAX_WORDS) return { ok: false, why: `it is over ${MAX_WORDS} words` };
  if (words[0] === "") return { ok: false, why: "its first word is empty" };
  // Quoted or not: a first word of this shape is refused, so that no reading of it is an assignment.
  if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(words[0]!)) return { ok: false, why: "it starts with a variable assignment" };
  return { ok: true, words };
}

/**
 * THE LIST of commands a prefix rule may not start with: a shell, or a
 * command whose job is to run another command. `bash -c` as a prefix would
 * cover any command at all. It catches the plain mistake and nothing more:
 * an interpreter such as `python -c` or `node -e` is not on it, and a prefix
 * rule for one covers whatever code follows.
 */
export const RUNNERS: readonly string[] = [
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh",
  "env", "sudo", "doas", "su", "xargs", "eval", "exec", "command", "builtin",
  "nohup", "time", "nice", "timeout", "watch", "script", "caffeinate",
];

/** A word as it would be typed: bare when it can be, otherwise in single quotes, with any single quote of its own in double quotes. */
export function quoteWord(word: string): string {
  if (word !== "" && [...word].every((char) => BARE.test(char)) && !word.startsWith("=")) return word;
  return `'${word.replaceAll("'", `'"'"'`)}'`;
}

/** Words as one command line that `splitWords` reads back as the same words. */
export const joinWords = (words: readonly string[]): string => words.map(quoteWord).join(" ");

export type CommandRuleRead = { ok: true; mode: "exact" | "prefix"; text: string; words: string[] } | { ok: false; why: string };

/**
 * Read a command rule as a person typed it. An exact rule is the command
 * line itself; a prefix rule is its first words. Either must be plain words.
 * A prefix needs at least two words and may not start with a shell or a
 * command runner.
 */
export function readCommandRule(raw: string, mode: "exact" | "prefix"): CommandRuleRead {
  if (typeof raw !== "string") return { ok: false, why: "that command cannot be used: it is not text" };
  // An exact rule is compared character for character, so it is kept as it came, except for spaces at its ends.
  const text = raw.replace(/^[ \t]+|[ \t]+$/g, "");
  const split = splitWords(text);
  if (!split.ok) return { ok: false, why: `that command is refused: ${split.why}. A rule is plain words only: no shell operators or expansions` };
  if (mode === "exact") return { ok: true, mode, text, words: split.words };
  if (split.words.length < 2) return { ok: false, why: "a prefix needs at least two words: one word would cover everything that command can do" };
  const name = split.words[0]!.split("/").pop() ?? "";
  if (RUNNERS.includes(name)) return { ok: false, why: `a prefix may not start with ${name}: it runs other commands, so the rule would cover any command at all` };
  return { ok: true, mode, text: joinWords(split.words), words: split.words };
}
