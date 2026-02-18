import { createClient } from "@supabase/supabase-js";

const url = process.env.ORKY_SUPABASE_URL;
const key = process.env.ORKY_SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error("Missing ORKY_SUPABASE_URL or ORKY_SUPABASE_SERVICE_ROLE_KEY");
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false },
});
