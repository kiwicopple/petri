// Player name sanitiser (PLAN.md §11). Pure TS, no platform APIs.

export const MAX_NAME_LENGTH = 16;
export const DEFAULT_NAME = "Cell";

// Deliberately short; matched as substrings of a normalized lowercase form.
const BLOCKLIST: readonly string[] = [
  "nigger",
  "nigga",
  "faggot",
  "retard",
  "cunt",
  "fuck",
  "shit",
  "bitch",
  "whore",
  "slut",
  "rapist",
  "nazi",
  "hitler",
];

const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  "$": "s",
  "!": "i",
};

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[013457@$!]/g, (c) => LEET[c])
    .replace(/[^a-z]/g, "");

export function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_NAME;
  // strip control chars (C0, DEL, C1) and zero-width / bidi formatting chars
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const name = Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join("").trim();
  if (!name) return DEFAULT_NAME;
  const norm = normalize(name);
  if (BLOCKLIST.some((w) => norm.includes(w))) return DEFAULT_NAME;
  return name;
}
