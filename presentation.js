/** Presentation follows the snapshot perspective without altering replay evidence. */
export function presentPlayer(player, viewer) {
  const enemy = player.team !== viewer?.team;
  const healthKnown = !enemy || player.visible === true;
  const presented = {...player, health:healthKnown && Number.isFinite(player.health) ? Math.max(0, Math.min(100, player.health)) : null};
  if (enemy) {
    // The shared lobby HUD exposes ultimate readiness, not verified remaining enemy seconds.
    presented.ultimateReadiness = player.ultCooldown === 0 ? 'ready' : Number.isFinite(player.ultCooldown) && player.ultCooldown > 0 ? 'cooldown' : 'unknown';
    presented.ultCooldown = player.ultCooldown === 0 ? 0 : null;
    presented.itemCooldowns = Object.fromEntries(Object.keys(player.itemCooldowns || {}).map(id => [id, null]));
  }
  return presented;
}

export function ultimateState(player) {
  const trained = player.ultimateTrained !== false;
  const ready = player.alive === true && trained && player.ultCooldown === 0;
  let label = '?';
  if (!trained) label = 'Locked';
  else if (player.alive === false && (player.ultimateReadiness || player.ultCooldown === 0)) label = 'Dead';
  else if (player.ultimateReadiness === 'cooldown') label = 'CD';
  else if (Number.isFinite(player.ultCooldown)) label = player.ultCooldown === 0 ? 'Ready' : `${Math.ceil(player.ultCooldown)}s`;
  const description = label === 'CD' ? 'not ready; remaining cooldown unknown' : label === '?' ? 'cooldown unknown' : label;
  return {ready, label, description};
}

export function healthLabel(health) {
  return Number.isFinite(health) ? `${Math.round(Math.max(0, Math.min(100, health)))}% HP` : 'HP unknown';
}

/** Static teleporter geometry is known even when this snapshot has no activation evidence. */
export function teleporterTargets(map, scenario) {
  const team = Array.isArray(scenario?.players) ? scenario.players.find(player => player.id === scenario.you)?.team : undefined;
  return (map.pois || []).filter(poi => poi.kind === 'teleporter').map(poi => {
    const measured = scenario.poiStates?.[poi.id]?.active;
    const state = typeof measured === 'boolean' ? measured ? 'available' : 'unavailable' : Array.isArray(scenario.activePois) && scenario.activePois.includes(poi.id) ? 'available' : 'unknown';
    // Player-facing names follow the viewer's screen, like camps; compass names remain when no viewer is known.
    const location = team === 'amber' || team === 'sapphire'
      ? `${(poi.y > 50) === (team === 'amber') ? 'Your side' : 'Enemy side'}, ${screenLane(poi.x, team)}`
      : `${poi.y < 50 ? 'North' : 'South'} ${poi.x < 50 ? 'west' : 'east'}`;
    const status = state === 'unknown' ? 'Availability unknown' : state === 'available' ? 'Available' : 'Unavailable';
    return {...poi, state, name:`Teleporter \u00b7 ${location}`, status, label:`Teleporter \u00b7 ${location} \u00b7 ${status}`};
  });
}

export function modeURL(href, mode) {
  const url = new URL(href);
  if (mode === 'daily') url.searchParams.set('mode', 'daily');
  else url.searchParams.delete('mode');
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Sapphire's HUD uses Valve's invert_map rotation, keeping each viewer's base at the bottom. */
export function isMapInverted(yourTeam) { return yourTeam === 'sapphire'; }

/** Lane names follow the screen the viewer sees, not the raw world axis. */
export function screenLane(x, yourTeam) {
  const screenX = isMapInverted(yourTeam) ? 100 - x : x;
  return screenX < 34 ? 'left' : screenX > 66 ? 'right' : 'mid';
}

/** Player-facing camp names. Duplicates are numbered from the viewer's base outward. */
export function namedCampTargets(camps, yourTeam) {
  const described = camps.map(camp => {
    const side = camp.y >= 45 && camp.y <= 55 ? 'River' : (camp.y > 50) === (yourTeam === 'amber') ? 'Your side' : 'Enemy side';
    return {...camp, label:`${camp.label} · ${side}, ${screenLane(camp.x, yourTeam)}`};
  });
  const groups = new Map();
  for (const camp of described) groups.set(camp.label, [...(groups.get(camp.label) || []), camp]);
  const baseY = yourTeam === 'amber' ? 100 : 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => Math.abs(a.y - baseY) - Math.abs(b.y - baseY) || a.x - b.x);
    group.forEach((camp, i) => { camp.label = camp.label.replace(' · ', ` ${i + 1} · `); });
  }
  return described;
}

export function recordedTargetSecond(scenario) {
  if (scenario.source?.kind !== 'match') return null;
  const value = scenario.source?.roundEvidence?.answerSampleSecond ?? scenario.recordedMove?.toSecond;
  return Number.isFinite(value) && value > scenario.time ? value : null;
}

/** Per-second recorded samples inside the minute after the snapshot, for the route scrubber. */
export function routeTimeline(scenario) {
  const move = scenario?.recordedMove;
  if (!move || !Array.isArray(move.path) || !Number.isFinite(move.fromSecond)) return [];
  const coordinate = value => Number.isFinite(value) && value >= 0 && value <= 100;
  return move.path
    .filter(sample => sample && Number.isFinite(sample.second) && sample.second >= move.fromSecond && sample.second <= move.fromSecond + 60)
    .map(sample => ({second:sample.second, x:coordinate(sample.x) && coordinate(sample.y) ? sample.x : null, y:coordinate(sample.x) && coordinate(sample.y) ? sample.y : null, alive:sample.alive !== false}))
    .sort((a, b) => a.second - b.second);
}

/** Interpolated position at an absolute second, or null while the player is dead or unrecorded. */
export function routePositionAt(timeline, second) {
  if (!timeline.length) return null;
  const known = sample => sample.alive && sample.x !== null;
  let before = null, after = null;
  for (const sample of timeline) {
    if (sample.second <= second) before = sample;
    if (sample.second >= second) { after = sample; break; }
  }
  if (!before || !known(before)) return null;
  if (!after || after === before || !known(after)) return {x:before.x, y:before.y};
  const t = (second - before.second) / (after.second - before.second);
  if (Math.hypot(after.x - before.x, after.y - before.y) > 10) return t < .5 ? {x:before.x, y:before.y} : {x:after.x, y:after.y};
  return {x:before.x + (after.x - before.x) * t, y:before.y + (after.y - before.y) * t};
}

/** Named places along the scored window: the first, the last and the longest-held places between them. */
export function routeStops(timeline, startSecond, nameOf, limit = 3) {
  const stops = [];
  for (const sample of timeline) {
    if (sample.second < startSecond || !sample.alive || sample.x === null) continue;
    const name = nameOf(sample);
    if (!name) continue;
    if (!stops.length || stops[stops.length - 1].name !== name) stops.push({second:sample.second, name, dwell:0});
  }
  const end = timeline.length ? timeline[timeline.length - 1].second : startSecond;
  stops.forEach((stop, i) => { stop.dwell = (stops[i + 1]?.second ?? end + 1) - stop.second; });
  // Dropping a brief detour can leave the same place twice in a row; keep the earlier visit.
  const merged = list => list.filter((stop, i) => i === 0 || stop.name !== list[i - 1].name).map(({second, name}) => ({second, name}));
  if (stops.length <= limit) return merged(stops);
  const middle = stops.slice(1, -1).filter(stop => stop.dwell >= 3).sort((a, b) => b.dwell - a.dwell).slice(0, Math.max(0, limit - 2));
  return merged([stops[0], ...middle, stops[stops.length - 1]].sort((a, b) => a.second - b.second));
}

/** The scored sample closest to a point, so a different move can be named in time as well as place. */
export function nearestRouteSample(timeline, startSecond, point) {
  let best = null;
  for (const sample of timeline) {
    if (sample.second < startSecond || !sample.alive || sample.x === null) continue;
    const distance = Math.hypot(sample.x - point.x, sample.y - point.y);
    if (!best || distance < best.distance) best = {...sample, distance};
  }
  return best;
}

/** Match phase buckets used by progress statistics. */
export function gamePhase(seconds) {
  return seconds < 900 ? 'early' : seconds < 1800 ? 'mid' : 'late';
}

/** Completed sets roll over on a later UTC day; unfinished runs remain resumable. */
export function isCompletedRunStale(run, utcDate) {
  if (run?.finished !== true || !Array.isArray(run.results) || run.results.length !== 10 || typeof run.completedAt !== 'string') return false;
  const completed = new Date(run.completedAt);
  if (!Number.isFinite(completed.getTime())) return false;
  return completed.toISOString().slice(0, 10) < utcDate;
}
