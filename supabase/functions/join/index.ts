// Edge function `join` (PLAN.md §11): authenticate, sanitise, matchmake, spawn.
// verify_jwt is false (see config.toml); the caller is authenticated via auth.getUser().
import { createClient } from "npm:@supabase/supabase-js@2";
import { sanitizeName } from "../_shared/names.ts";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PRESETS = new Set([
  "amoeba", "diatom", "spore", "virus", "paramecium", "algae", "yeast", "tardigrade",
]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

/** Preset name, or `skins/<uid>/<file>` under the caller's own uid; anything else is null. */
function sanitizeSkin(raw: unknown, uid: string): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (PRESETS.has(s)) return s;
  const prefix = `skins/${uid}/`;
  if (s.length > prefix.length && s.length <= 300 && s.startsWith(prefix)) {
    const file = s.slice(prefix.length);
    if (!file.includes("..") && !file.includes("\\") && !/[\u0000-\u001f\u007f]/.test(file)) return s;
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1. Authenticate.
    const authorization = req.headers.get("Authorization");
    if (!authorization) return json({ error: "missing authorization" }, 401);
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    const user = userData?.user;
    if (userError || !user) return json({ error: "unauthorized" }, 401);

    // 2. Validate body.
    let body: { name?: unknown; skin?: unknown } = {};
    try {
      const parsed = await req.json();
      if (parsed && typeof parsed === "object") body = parsed;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const name = sanitizeName(body.name);
    const skin = sanitizeSkin(body.skin, user.id);

    // 3. Matchmaking (service role).
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: rooms, error: roomsError } = await admin.from("room_list").select("id,name,max_players,player_count");
    if (roomsError) return json({ error: `room lookup failed: ${roomsError.message}` }, 500);
    const open = (rooms ?? [])
      .filter((r) => Number(r.player_count) < r.max_players)
      .sort((a, b) => Number(b.player_count) - Number(a.player_count));
    let roomId: string | undefined = open[0]?.id;
    if (!roomId) {
      const total = rooms?.length ?? 0;
      const label = total < 26 ? String.fromCharCode(65 + total) : String(total + 1);
      const { data: created, error: createError } = await admin
        .from("rooms")
        .insert({ name: `Dish ${label}` })
        .select("id")
        .single();
      if (createError || !created) return json({ error: `room creation failed: ${createError?.message}` }, 500);
      roomId = created.id as string;
    }

    // 4. Spawn.
    const { data: spawn, error: spawnError } = await admin.rpc("spawn_player", {
      p_user: user.id,
      p_room: roomId,
      p_name: name,
      p_skin: skin,
    });
    if (spawnError) return json({ error: spawnError.message }, 500);
    return json(spawn);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
