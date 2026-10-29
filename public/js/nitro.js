export const NITRO = {
  duration: 2,
  extraAccel: 22,
  maxSpeed: 64,
  coastDecel: 12,
  respawn: 8,
  radius: 2.8,
  lookAhead: 148, // Two seconds at boost speed, plus room before the next bend.
  maxTurn: 0.65,
  spacing: 240,
};

// Choose the gentlest upcoming stretches. Keep the starting grid clear and
// leave enough road ahead to use the boost before a tight corner.
export function createNitroPickups(track) {
  const { samples, tangents } = track;
  const count = samples.length;
  const lengths = samples.map((a, i) => {
    const b = samples[(i + 1) % count];
    return Math.hypot(b.x - a.x, b.z - a.z);
  });
  const distances = [0];
  for (const length of lengths) distances.push(distances.at(-1) + length);
  const total = distances[count];
  const candidates = [];
  for (let i = 0; i < count; i++) {
    if (distances[i] < 35 || total - distances[i] < 100) continue;
    let distance = 0, turn = 0, j = i;
    while (distance < NITRO.lookAhead && distance < total) {
      const next = (j + 1) % count;
      const a = tangents[j], b = tangents[next];
      turn += Math.abs(Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z));
      distance += lengths[j];
      j = next;
    }
    if (distance >= NITRO.lookAhead && turn <= NITRO.maxTurn) candidates.push({ index: i, turn });
  }
  const stations = [];
  for (const candidate of candidates.sort((a, b) => a.turn - b.turn)) {
    const separated = stations.every(({ index }) => {
      const gap = Math.abs(distances[index] - distances[candidate.index]);
      return Math.min(gap, total - gap) >= NITRO.spacing;
    });
    if (separated) stations.push(candidate);
    if (stations.length === 3) break;
  }
  stations.sort((a, b) => a.index - b.index);
  return stations.flatMap(({ index }, station) => {
    const center = samples[index], tangent = tangents[index];
    const lane = Math.min(8, track.halfWidth * 0.4);
    return [-lane, 0, lane].map((offset, slot) => ({
      id: `${station}-${slot}`, index,
      pos: { x: center.x + tangent.z * offset, y: center.y, z: center.z - tangent.x * offset },
      heading: Math.atan2(tangent.x, tangent.z),
      cooldown: 0,
    }));
  });
}

export function resetNitroPickups(pickups) {
  for (const pickup of pickups) pickup.cooldown = 0;
}

// Entry time along this physics step, so fast cars cannot skip a bottle.
function entryTime(previous, current, center) {
  const dx = current.x - previous.x, dz = current.z - previous.z;
  const ox = previous.x - center.x, oz = previous.z - center.z;
  const c = ox * ox + oz * oz - NITRO.radius * NITRO.radius;
  if (c <= 0) return 0;
  const a = dx * dx + dz * dz;
  if (a === 0) return Infinity;
  const b = ox * dx + oz * dz;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return Infinity;
  const time = (-b - Math.sqrt(discriminant)) / a;
  return time >= 0 && time <= 1 ? time : Infinity;
}

export function updateNitroPickups(pickups, players, dt, onCollect = () => {}) {
  const racers = Array.from(players);
  for (const pickup of pickups) {
    if (pickup.cooldown > 0) {
      pickup.cooldown = Math.max(0, pickup.cooldown - dt);
      continue;
    }
    let collector = null, earliest = Infinity;
    for (const p of racers) {
      if (p.finished || p.speed <= 0 || p.input.brake > 0.02) continue;
      if (Math.cos(p.heading - pickup.heading) < 0.5) continue;
      const time = entryTime(p.previousPose, p.pos, pickup.pos);
      if (time < earliest || (collector && time === earliest && p.slot < collector.slot)) {
        collector = p;
        earliest = time;
      }
    }
    if (!collector) continue;
    collector.nitroTime = NITRO.duration; // Refresh, never stack unlimited boosts.
    pickup.cooldown = NITRO.respawn;
    onCollect(collector, pickup);
  }
}
