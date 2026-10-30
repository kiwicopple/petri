import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  { realtime: { params: { eventsPerSecond: 50 } } },
);

/** Ensure an anonymous session exists, then hand its JWT to Realtime. */
export async function signIn() {
  const { data } = await supabase.auth.getSession();
  let session = data.session;
  if (!session) {
    const res = await supabase.auth.signInAnonymously();
    if (res.error) throw res.error;
    session = res.data.session;
  }
  await supabase.realtime.setAuth();
  return session;
}
