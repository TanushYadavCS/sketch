export interface ShellExecutableToken {
  raw: string;
  value: string;
}

const SHELL_WHITESPACE = /\s/;
const SHELL_OPERATOR_CHARS = new Set([";", "&", "|", "<", ">", "(", ")"]);
const SHELL_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_VARIABLE_NAME_PATTERN = /[A-Za-z_]/;

export const SHELL_PATH_EXPANSION_DENY_MESSAGE =
  "Access denied: Bash commands must use literal paths within the workspace; shell expansion like $(), backticks, $VAR, or ~ is not permitted here.";

function readShellWord(command: string, start: number): ShellExecutableToken & { end: number } {
  let index = start;
  let raw = "";
  let value = "";

  while (index < command.length) {
    const char = command[index];
    if (SHELL_WHITESPACE.test(char) || SHELL_OPERATOR_CHARS.has(char)) break;

    if (char === "'") {
      raw += char;
      index += 1;
      while (index < command.length) {
        const quoted = command[index];
        raw += quoted;
        index += 1;
        if (quoted === "'") break;
        value += quoted;
      }
      continue;
    }

    if (char === '"') {
      raw += char;
      index += 1;
      while (index < command.length) {
        const quoted = command[index];
        raw += quoted;
        index += 1;
        if (quoted === '"') break;
        if (quoted === "\\" && index < command.length) {
          const escaped = command[index];
          raw += escaped;
          value += escaped;
          index += 1;
          continue;
        }
        value += quoted;
      }
      continue;
    }

    if (char === "\\" && index + 1 < command.length) {
      raw += char + command[index + 1];
      value += command[index + 1];
      index += 2;
      continue;
    }

    raw += char;
    value += char;
    index += 1;
  }

  return { raw, value, end: index };
}

function skipWhitespace(command: string, start: number): number {
  let index = start;
  while (index < command.length && SHELL_WHITESPACE.test(command[index])) {
    index += 1;
  }
  return index;
}

function isShellAssignmentWord(token: ShellExecutableToken): boolean {
  return SHELL_ASSIGNMENT_PATTERN.test(token.raw);
}

function firstExecutableToken(command: string): ShellExecutableToken | null {
  let index = skipWhitespace(command, 0);

  while (index < command.length) {
    const token = readShellWord(command, index);
    if (!token.raw) return null;
    if (!isShellAssignmentWord(token)) return { raw: token.raw, value: token.value };
    index = skipWhitespace(command, token.end);
  }

  return null;
}

/**
 * Checks only the first simple-command executable after leading env assignments.
 * Quote-aware scanning of chained commands after a real Canvas CLI invocation is
 * a deferred limitation until this guard moves to a structured shell parser.
 */
export function isCanvasCliFirstExecutableToken(command: string, envVarName = "CANVAS_CLI"): boolean {
  const token = firstExecutableToken(command);
  if (!token) return false;

  return (
    token.raw === envVarName ||
    token.raw === `$${envVarName}` ||
    token.raw === `\${${envVarName}}` ||
    token.raw === `"$${envVarName}"` ||
    token.raw === `"\${${envVarName}}"`
  );
}

/**
 * Best-effort lexical containment for Bash path checks pending an OS-level
 * sandbox. The path guards only reason about literal paths, so shell syntax
 * that can construct a path at runtime is denied before the command reaches
 * `/bin/sh -lc`.
 */
export function containsShellPathExpansion(command: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let atWordStart = true;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (char === "\\" && !inSingleQuote) {
      index += 1;
      atWordStart = false;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      atWordStart = false;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      atWordStart = false;
      continue;
    }

    if (inSingleQuote) {
      atWordStart = false;
      continue;
    }

    if (char === "`") return true;
    if ((char === "<" || char === ">") && next === "(") return true;

    if (char === "$") {
      if (next === "(" || next === "{") return true;
      if (next && SHELL_VARIABLE_NAME_PATTERN.test(next)) return true;
    }

    if (char === "~" && atWordStart && (next === undefined || next === "/" || SHELL_WHITESPACE.test(next))) {
      return true;
    }

    if (SHELL_WHITESPACE.test(char) || SHELL_OPERATOR_CHARS.has(char)) {
      atWordStart = true;
      continue;
    }

    atWordStart = false;
  }

  return false;
}
