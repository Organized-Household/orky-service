import { supabase } from "./client";

export type OrkyRun = {
  id: string;
  jira_key: string;
  cursor_state: string;
  cursor_step: string;
  cursor_attempt: number;
  locked_by: string | null;
  lock_expires_at: string | null;
  max_autofix_attempts: number;
  last_error: string | null;
};

export async function createRun(jiraKey: string) {
  const { data, error } = await supabase
    .from("orky_runs")
    .insert({
      jira_key: jiraKey,
      cursor_state: "RECEIVED",
      cursor_step: "INTAKE_START",
      cursor_attempt: 0,
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as OrkyRun;
}

export async function getRun(runId: string) {
  const { data, error } = await supabase
    .from("orky_runs")
    .select("*")
    .eq("id", runId)
    .single();

  if (error) throw error;
  return data as OrkyRun;
}

export async function setRunCursor(runId: string, state: string, step: string, attempt: number) {
  const { data, error } = await supabase
    .from("orky_runs")
    .update({
      cursor_state: state,
      cursor_step: step,
      cursor_attempt: attempt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .select("*")
    .single();

  if (error) throw error;
  return data as OrkyRun;
}

