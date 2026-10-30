// Main menu: name, skin picker + upload, room list, live high scores (PLAN.md §13). Browser-only.

import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { MAX_NAME_LENGTH } from "@shared/names.ts";
import { PRESET_SKINS, SKIN_BUCKET, customSkinObjectPath, customSkinValue, skinUrl } from "../skins.ts";
import type { RoomListRow, TopScoreRow } from "../types.ts";
import { el, injectStyles } from "./style.ts";

const LS_NAME = "petri.name";
const LS_SKIN = "petri.skin";
const ROOM_REFRESH_MS = 3000;
const MAX_UPLOAD_BYTES = 512 * 1024;
const UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp"];

export interface MenuOptions {
  client: SupabaseClient;
  supabaseUrl: string;
  /** Called with the chosen name/skin when the player hits Play. */
  onPlay: (name: string, skin: string | null) => void;
}

const fmtTime = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

export class Menu {
  readonly root: HTMLDivElement;
  private nameInput: HTMLInputElement;
  private skinGrid: HTMLDivElement;
  private playBtn: HTMLButtonElement;
  private errEl: HTMLDivElement;
  private roomList: HTMLUListElement;
  private scoreList: HTMLUListElement;
  private fileInput: HTMLInputElement;
  private uploadNote: HTMLDivElement;

  private skin: string | null;
  private customSkins: string[] = []; // join values (skins/<uid>/<file>)
  private uid: string | null = null;
  private roomTimer: ReturnType<typeof setInterval> | null = null;
  private scoresChannel: RealtimeChannel | null = null;
  private scoresRefetch: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: MenuOptions) {
    injectStyles();
    this.skin = localStorage.getItem(LS_SKIN) || null;

    this.nameInput = el("input", { class: "pt-input", placeholder: "Your cell's name", maxlength: String(MAX_NAME_LENGTH), autocomplete: "off" });
    this.nameInput.value = localStorage.getItem(LS_NAME) ?? "";
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.play();
    });

    this.skinGrid = el("div", { class: "pt-skins" });
    this.fileInput = el("input", { type: "file", accept: UPLOAD_TYPES.join(","), hidden: "" });
    this.fileInput.addEventListener("change", () => void this.upload());
    this.uploadNote = el("div", { class: "pt-note" }, "PNG/JPEG/WebP up to 512 KB");

    this.playBtn = el("button", { class: "pt-btn" }, "Play");
    this.playBtn.addEventListener("click", () => this.play());
    this.errEl = el("div", { class: "pt-err" });

    this.roomList = el("ul", { class: "pt-list" });
    this.scoreList = el("ul", { class: "pt-list" });

    const main = el(
      "div",
      { class: "pt-card" },
      el("h1", { class: "pt-title" }, "Petri"),
      el("p", { class: "pt-sub" }, "Grow. Divide. Consume. Mouse to steer · Space to split · W to eject"),
      el("div", { class: "pt-label" }, "Name"),
      this.nameInput,
      el("div", { class: "pt-label" }, "Skin"),
      this.skinGrid,
      this.uploadNote,
      this.fileInput,
      this.playBtn,
      this.errEl,
    );
    const side = el(
      "div",
      { class: "pt-side" },
      el("div", { class: "pt-card pt-panel" }, el("h3", {}, "Dishes"), this.roomList),
      el("div", { class: "pt-card pt-panel pt-scores" }, el("h3", {}, "All-time top 20"), this.scoreList),
    );
    this.root = el("div", { class: "pt-overlay", hidden: "" }, el("div", { class: "pt-menu" }, main, side));
    document.body.appendChild(this.root);
    this.renderSkins();
  }

  /** Set the signed-in user id (enables upload + lists their uploads). */
  setUser(uid: string | null): void {
    this.uid = uid;
    void this.loadCustomSkins();
  }

  show(): void {
    this.root.hidden = false;
    this.setBusy(false);
    void this.refreshRooms();
    void this.refreshScores();
    if (!this.roomTimer) this.roomTimer = setInterval(() => void this.refreshRooms(), ROOM_REFRESH_MS);
    if (!this.scoresChannel) {
      this.scoresChannel = this.opts.client
        .channel("menu:scores")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "scores" }, () => this.scheduleScores())
        .subscribe();
    }
    setTimeout(() => this.nameInput.focus(), 0);
  }

  hide(): void {
    this.root.hidden = true;
    if (this.roomTimer) clearInterval(this.roomTimer);
    this.roomTimer = null;
    if (this.scoresChannel) void this.opts.client.removeChannel(this.scoresChannel);
    this.scoresChannel = null;
  }

  setBusy(busy: boolean): void {
    this.playBtn.disabled = busy;
    this.playBtn.textContent = busy ? "Joining…" : "Play";
  }

  setError(msg: string): void {
    this.errEl.textContent = msg;
  }

  private play(): void {
    if (this.playBtn.disabled) return;
    const name = this.nameInput.value.trim().slice(0, MAX_NAME_LENGTH);
    localStorage.setItem(LS_NAME, name);
    this.setError("");
    this.opts.onPlay(name, this.skin);
  }

  private select(skin: string | null): void {
    this.skin = skin;
    if (skin) localStorage.setItem(LS_SKIN, skin);
    else localStorage.removeItem(LS_SKIN);
    this.renderSkins();
  }

  private renderSkins(): void {
    const tiles: HTMLElement[] = [];
    const tile = (value: string | null, label: string) => {
      const b = el("button", { class: `pt-skin${this.skin === value ? " sel" : ""}`, title: label, type: "button" });
      const url = skinUrl(this.opts.supabaseUrl, value);
      if (url) {
        const img = el("img", { src: url, alt: label, loading: "lazy" });
        img.addEventListener("error", () => img.replaceWith(label.slice(0, 6))); // missing preset: text fallback
        b.append(img);
      } else {
        b.append(label);
      }
      b.addEventListener("click", () => this.select(value));
      tiles.push(b);
    };
    tile(null, "none");
    for (const p of PRESET_SKINS) tile(p, p);
    for (const c of this.customSkins) tile(c, "yours");
    const up = el("button", { class: "pt-skin", title: "Upload a skin", type: "button" }, "＋ upload");
    up.addEventListener("click", () => {
      if (!this.uid) {
        this.uploadNote.textContent = "Sign-in not ready yet";
        return;
      }
      this.fileInput.click();
    });
    tiles.push(up);
    this.skinGrid.replaceChildren(...tiles);
  }

  private async loadCustomSkins(): Promise<void> {
    if (!this.uid) return;
    const { data, error } = await this.opts.client.storage
      .from(SKIN_BUCKET)
      .list(this.uid, { limit: 8, sortBy: { column: "created_at", order: "desc" } });
    if (error || !data) return;
    const uid = this.uid;
    this.customSkins = data.filter((f) => f.name && !f.name.startsWith(".")).map((f) => customSkinValue(uid, f.name));
    this.renderSkins();
  }

  private async upload(): Promise<void> {
    const file = this.fileInput.files?.[0];
    this.fileInput.value = "";
    if (!file || !this.uid) return;
    if (!UPLOAD_TYPES.includes(file.type)) {
      this.uploadNote.textContent = "Only PNG, JPEG or WebP";
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      this.uploadNote.textContent = "File is larger than 512 KB";
      return;
    }
    try {
      (await createImageBitmap(file)).close(); // storage trusts the MIME type; make sure it really decodes
    } catch {
      this.uploadNote.textContent = "That file isn't a valid image";
      return;
    }
    const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const fname = `${Date.now().toString(36)}.${ext}`;
    this.uploadNote.textContent = "Uploading…";
    const { error } = await this.opts.client.storage
      .from(SKIN_BUCKET)
      .upload(customSkinObjectPath(this.uid, fname), file, { contentType: file.type, upsert: false });
    if (error) {
      this.uploadNote.textContent = `Upload failed: ${error.message}`;
      return;
    }
    this.uploadNote.textContent = "Uploaded!";
    const value = customSkinValue(this.uid, fname);
    this.customSkins = [value, ...this.customSkins.filter((s) => s !== value)];
    this.select(value);
  }

  private async refreshRooms(): Promise<void> {
    const { data, error } = await this.opts.client.from("room_list").select("id,name,max_players,player_count").order("name");
    if (error) {
      this.roomList.replaceChildren(el("li", { class: "dim" }, el("span", {}, "rooms unavailable")));
      return;
    }
    const rows = (data ?? []) as RoomListRow[];
    if (rows.length === 0) {
      this.roomList.replaceChildren(el("li", { class: "dim" }, el("span", {}, "No dishes yet — one is created when you play")));
      return;
    }
    this.roomList.replaceChildren(
      ...rows.map((r) =>
        el("li", {}, el("span", {}, r.name), el("span", { class: "dim" }, `${r.player_count}/${r.max_players}`)),
      ),
    );
  }

  private scheduleScores(): void {
    if (this.scoresRefetch) return;
    this.scoresRefetch = setTimeout(() => {
      this.scoresRefetch = null;
      void this.refreshScores();
    }, 250);
  }

  private async refreshScores(): Promise<void> {
    const { data, error } = await this.opts.client.from("top_scores").select("name,peak_mass,kills,survived_seconds,created_at");
    if (error) {
      this.scoreList.replaceChildren(el("li", { class: "dim" }, el("span", {}, "scores unavailable")));
      return;
    }
    const rows = (data ?? []) as TopScoreRow[];
    if (rows.length === 0) {
      this.scoreList.replaceChildren(el("li", { class: "dim" }, el("span", {}, "No scores yet")));
      return;
    }
    this.scoreList.replaceChildren(
      ...rows.slice(0, 20).map((r, i) =>
        el(
          "li",
          { title: `${r.kills} kills · survived ${fmtTime(r.survived_seconds)}` },
          el("span", {}, `${i + 1}. ${r.name}`),
          el("span", { class: "dim" }, `${Math.round(r.peak_mass)}`),
        ),
      ),
    );
  }
}
