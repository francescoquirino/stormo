// When an agent's routine is due. Pure logic, tested by test/routine.test.js.
export function dueAt(a, now) {
  const r = a.routine;
  if (!r || r.kind === 'off' || !r.prompt) return null;
  // Where the cycle starts counting from: last run, last routine change, or agent creation.
  // So a routine just set up doesn't trigger by surprise for a time that's already past.
  const base = Math.max(r.lastRun || 0, r.since || 0, a.createdAt || 0) || now;
  if (r.kind === 'every') return base + Math.max(5, +r.minutes || 60) * 60000;
  if (r.kind === 'daily') {
    const [hh, mm] = String(r.at || '09:00').split(':').map((x) => +x || 0);
    const d = new Date(now);
    d.setHours(hh, mm, 0, 0);
    const today = d.getTime();
    return base >= today ? today + 86400000 : today;
  }
  return null;
}
