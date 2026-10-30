export const TOTAL_LAPS = 3;
export const GATE_RADIUS = 28;

// Keep a race-wide record, independent of controllers leaving/rejoining.
export function recordFinish(p, finishOrder, elapsed) {
  if (p.finished || p.lap < TOTAL_LAPS || finishOrder.some(result => result.id === p.id)) return false;
  p.finished = true;
  p.finishTime = Math.max(0, elapsed);
  p.finishRank = finishOrder.length + 1;
  finishOrder.push({
    id: p.id, name: p.name, color: p.color, finished: true,
    finishRank: p.finishRank, finishTime: p.finishTime,
    bestLapTime: p.bestLapTime, topSpeed: p.topSpeed,
  });
  return true;
}

export function allPlayersFinished(players) {
  const entrants = [...players];
  return entrants.length > 0 && entrants.every(p => p.finished);
}

export function advanceGates(p, gates, previousX, previousZ) {
  if (p.finished) return false;
  const gate = p.nextGate % gates.length;
  const { pos: gp, tangent } = gates[gate];
  const dx = p.pos.x - gp.x;
  const dz = p.pos.z - gp.z;
  if (dx * dx + dz * dz >= GATE_RADIUS * GATE_RADIUS) return false;
  const before = (previousX - gp.x) * tangent.x + (previousZ - gp.z) * tangent.z;
  const after = dx * tangent.x + dz * tangent.z;
  if (before >= 0 || after < 0) return false;
  p.gatesPassed++;
  if (gate === 0) p.lap++;
  p.nextGate = (gate + 1) % gates.length;
  return p.lap >= TOTAL_LAPS;
}

export function rankings(players, gates) {
  return [...players].sort((a, b) => {
    if (a.finished && b.finished) return a.finishRank - b.finishRank;
    if (a.finished) return -1;
    if (b.finished) return 1;
    if (b.gatesPassed !== a.gatesPassed) return b.gatesPassed - a.gatesPassed;
    const ga = gates[a.nextGate % gates.length].pos;
    const gb = gates[b.nextGate % gates.length].pos;
    return Math.hypot(a.pos.x - ga.x, a.pos.z - ga.z) - Math.hypot(b.pos.x - gb.x, b.pos.z - gb.z);
  });
}
