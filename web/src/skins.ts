// Skin naming + URL resolution (PLAN.md §12). DOM-free.

/** Preset skins; PNGs live at storage `skins/presets/<name>.png`. */
export const PRESET_SKINS = [
  "amoeba",
  "diatom",
  "spore",
  "virus",
  "paramecium",
  "algae",
  "yeast",
  "tardigrade",
] as const;
export type PresetSkin = (typeof PRESET_SKINS)[number];

export const SKIN_BUCKET = "skins";

/** Object path (inside the `skins` bucket) for a user upload. */
export const customSkinObjectPath = (uid: string, file: string): string => `${uid}/${file}`;

/**
 * Value sent to `join` as `skin` for an uploaded skin.
 * PLAN §11: "a path under `skins/<uid>/`" — we include the bucket prefix.
 */
export const customSkinValue = (uid: string, file: string): string =>
  `${SKIN_BUCKET}/${customSkinObjectPath(uid, file)}`;

export const isPreset = (s: string): s is PresetSkin =>
  (PRESET_SKINS as readonly string[]).includes(s);

/**
 * Resolve a stored skin value to a public URL. Accepts a preset name, `presets/x.png`,
 * `<uid>/<file>`, `skins/<uid>/<file>` or a full URL. Returns null for empty values.
 */
export function skinUrl(supabaseUrl: string, skin: string | null | undefined): string | null {
  if (!skin) return null;
  const s = skin.trim();
  if (!s) return null;
  if (/^https?:\/\//.test(s)) return s;
  const base = `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/public/${SKIN_BUCKET}/`;
  if (isPreset(s)) return `${base}presets/${s}.png`;
  const path = s.startsWith(`${SKIN_BUCKET}/`) ? s.slice(SKIN_BUCKET.length + 1) : s;
  return base + path.split("/").map(encodeURIComponent).join("/");
}
