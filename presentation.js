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
  return (map.pois || []).filter(poi => poi.kind === 'teleporter').map(poi => {
    const measured = scenario.poiStates?.[poi.id]?.active;
    const state = typeof measured === 'boolean' ? measured ? 'available' : 'unavailable' : Array.isArray(scenario.activePois) && scenario.activePois.includes(poi.id) ? 'available' : 'unknown';
    const location = `${poi.y < 50 ? 'North' : 'South'} ${poi.x < 50 ? 'west' : 'east'}`;
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

/** Camp IDs carry the authored map location, making otherwise identical names distinct. */
export function namedCampTargets(camps, yourTeam) {
  return camps.map(camp => {
    const side = camp.y >= 45 && camp.y <= 55 ? 'River' : (camp.y > 50) === (yourTeam === 'amber') ? 'Your side' : 'Enemy side';
    const lane = camp.x < 34 ? 'left' : camp.x > 66 ? 'right' : 'mid';
    const location = String(camp.id).replace(/[_-]+/g, ' ').replace(/\bcamp\b/gi, '').replace(/\s+/g, ' ').trim();
    return {...camp, label:`${camp.label} · ${side}, ${lane}${location ? ` · ${location}` : ''}`};
  });
}

export function recordedTargetSecond(scenario) {
  if (scenario.source?.kind !== 'match') return null;
  const value = scenario.source?.roundEvidence?.answerSampleSecond ?? scenario.recordedMove?.toSecond;
  return Number.isFinite(value) && value > scenario.time ? value : null;
}

/** Completed sets roll over on a later UTC day; unfinished runs remain resumable. */
export function isCompletedRunStale(run, utcDate) {
  if (run?.finished !== true || !Array.isArray(run.results) || run.results.length !== 10 || typeof run.completedAt !== 'string') return false;
  const completed = new Date(run.completedAt);
  if (!Number.isFinite(completed.getTime())) return false;
  return completed.toISOString().slice(0, 10) < utcDate;
}
