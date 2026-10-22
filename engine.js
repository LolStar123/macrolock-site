const MIN_COORDINATE = 0;
const MAX_COORDINATE = 100;
const SIGNAL_KINDS = new Set(["wave", "fight", "camp", "urn"]);
const SIGNAL_TEAMS = new Set(["amber", "sapphire", "neutral"]);
const MAP_OBJECTIVE_KINDS = new Set(["guardian", "walker", "shrine", "patron"]);
const MAP_TEAMS = new Set(["amber", "sapphire"]);
const MAP_CAMP_KINDS = new Set(["weak", "medium", "strong", "vault"]);
const MAP_POI_KINDS = new Set(["shop", "teleporter", "urn", "urn-pad"]);
const PLAYER_EFFECTS = new Set(["rejuvenator"]);
const LANE_TEAMS = new Set(["amber", "sapphire"]);
const MAP_LAYER_KEYS = new Set(["surface", "tunnels", "ratTunnels"]);
const RANKED_MATCH_MODES = new Set([4, "Ranked", "ranked"]);
const NORMAL_GAME_MODES = new Set([1, "Normal", "normal"]);
// Exact source-reviewed quarantine, not a general teleport-distance rule.
// Its alive discontinuities have no verified movement mechanic yet.
const QUARANTINED_PRACTICE_ROUNDS = new Set(['recorded-120150009-720-1']);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCoordinate(value) {
  return Number.isFinite(value) && value >= MIN_COORDINATE && value <= MAX_COORDINATE;
}

function assertPoint(point) {
  if (!isRecord(point) || !isCoordinate(point.x) || !isCoordinate(point.y)) {
    throw new RangeError("point must contain finite x and y coordinates from 0 to 100");
  }
}

function assertDateString(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new TypeError("date must be an ISO UTC date in YYYY-MM-DD format");
  }

  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new RangeError("date is not a valid UTC calendar date");
  }
}

function zoneDistanceRatio(zone, point) {
  if (!isRecord(zone) || !isCoordinate(zone.x) || !isCoordinate(zone.y)) {
    throw new RangeError("answer zones must contain finite x and y coordinates from 0 to 100");
  }
  if (!Number.isFinite(zone.radius) || zone.radius <= 0) {
    throw new RangeError("answer zone radius must be a positive finite number");
  }
  if (zone.score !== 1) {
    throw new RangeError("answer zone score must be exactly 1");
  }

  const distance = Math.hypot(point.x - zone.x, point.y - zone.y);
  return distance / zone.radius;
}

/** Score a click against the scenario's single reviewed answer region. */
export function scoreChoice(scenario, point) {
  if (!isRecord(scenario) || !Array.isArray(scenario.answerZones) || scenario.answerZones.length !== 1) {
    throw new TypeError("scenario.answerZones must contain exactly one answer zone");
  }
  assertPoint(point);

  const [zone] = scenario.answerZones;
  if (!isRecord(zone)) throw new TypeError("the answer zone must be an object");
  const ratio = zoneDistanceRatio(zone, point);
  const hasHit = ratio <= 1;

  return {
    score: hasHit ? 1 : 0,
    zoneId: hasHit ? zone.id : null,
    label: hasHit ? (zone.label ?? "") : null,
    explanation: hasHit ? (zone.explanation ?? "") : null,
    bestZone: zone,
  };
}

/** Return a stable unsigned 32-bit seed for a UTC calendar date. */
export function dailySeed(date) {
  assertDateString(date);

  // FNV-1a is small, deterministic across runtimes, and avoids locale/date
  // parsing differences.
  let hash = 0x811c9dc5;
  for (let index = 0; index < date.length; index += 1) {
    hash ^= date.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Select a deterministic, non-repeating daily set without mutating input. */
export function selectPractice(scenarios, date, count = 10) {
  if (!Array.isArray(scenarios)) throw new TypeError("scenarios must be an array");
  assertDateString(date);
  if (!Number.isInteger(count) || count < 0) throw new RangeError("count must be a non-negative integer");
  if (count > scenarios.length) throw new RangeError("count cannot exceed the number of scenarios");

  const shuffled = scenarios.slice();
  const random = seededRandom(dailySeed(date));
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled.slice(0, count);
}

/** A lightweight index names stable rounds; match packs are fetched on demand. */
export function validatePracticeLibrary(library) {
  const errors = [];
  if (!isRecord(library)) return { valid: false, errors: ["library: must be an object"] };
  if (library.version !== 1) errors.push("library.version: must be 1");
  if (!nonEmptyString(library.id)) errors.push("library.id: must be a non-empty string");
  const ids = new Set(), matches = new Set(), paths = new Set(), scenarios = new Set();
  if (!Array.isArray(library.packs) || !library.packs.length) errors.push("library.packs: must contain match packs");
  else library.packs.forEach((pack, index) => {
    const path = `library.packs[${index}]`;
    if (!isRecord(pack)) { errors.push(`${path}: must be an object`); return; }
    if (!nonEmptyString(pack.id) || ids.has(pack.id)) errors.push(`${path}.id: must be unique and non-empty`);
    ids.add(pack.id);
    if (typeof pack.matchId !== "string" || !/^[1-9]\d*$/.test(pack.matchId) || matches.has(pack.matchId)) errors.push(`${path}.matchId: must be a unique positive match id`);
    matches.add(pack.matchId);
    if (typeof pack.path !== "string" || !/^practice\/[a-zA-Z0-9][a-zA-Z0-9_-]*\.json$/.test(pack.path) || paths.has(pack.path)) errors.push(`${path}.path: must be a unique local practice JSON path`);
    paths.add(pack.path);
    if (!Array.isArray(pack.scenarioIds) || !pack.scenarioIds.length || pack.scenarioIds.length > 10) errors.push(`${path}.scenarioIds: must contain between 1 and 10 round ids`);
    else for (const id of pack.scenarioIds) {
      if (!nonEmptyString(id) || scenarios.has(id)) errors.push(`${path}.scenarioIds: round ids must be unique and non-empty`);
      scenarios.add(id);
    }
  });
  if (scenarios.size < 10) errors.push("library: must contain at least 10 rounds");
  return {valid:errors.length === 0, errors};
}

export function practiceReferenceKey(reference) {
  return JSON.stringify([reference.packId, reference.scenarioId]);
}

/** Validate a persisted selection against the current index before fetching. */
export function validatePracticeReferences(library, references, count = 10) {
  if (!validatePracticeLibrary(library).valid || !Array.isArray(references) || references.length !== count) return false;
  const keys = new Set();
  return references.every(reference => {
    if (!isRecord(reference)) return false;
    const pack = library.packs.find(p => p.id === reference.packId);
    const key = practiceReferenceKey(reference);
    if (!pack?.scenarioIds.includes(reference.scenarioId) || keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

/** Prefer distinct, least-seen games, and exhaust unseen rounds before recycling. */
export function selectPracticeReferences(library, previousSeen = [], random = Math.random, count = 10) {
  const validation = validatePracticeLibrary(library);
  if (!validation.valid) throw new TypeError(validation.errors.join("; "));
  const all = library.packs.flatMap(pack => pack.scenarioIds.map(scenarioId => ({packId:pack.id, scenarioId, matchId:pack.matchId})));
  if (!Number.isInteger(count) || count < 1 || count > all.length) throw new RangeError("count must fit the available practice rounds");
  const known = new Set(all.map(practiceReferenceKey));
  let seen = new Set((Array.isArray(previousSeen) ? previousSeen : []).filter(key => known.has(key)));
  const selected = [], selectedKeys = new Set(), matches = new Set();
  const choose = rows => {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError("random must return a number from 0 up to 1");
    return rows[Math.floor(value * rows.length)];
  };
  while (selected.length < count) {
    let available = all.filter(ref => !seen.has(practiceReferenceKey(ref)) && !selectedKeys.has(practiceReferenceKey(ref)));
    if (!available.length) {
      // Preserve this run across a cycle boundary so a round never occurs twice in a set.
      seen = new Set(selectedKeys);
      available = all.filter(ref => !selectedKeys.has(practiceReferenceKey(ref)));
    }
    const distinct = available.filter(ref => !matches.has(ref.matchId));
    if (distinct.length) available = distinct;
    // Visit new games before returning to familiar ones; break equal exposure ties uniformly.
    const seenByMatch = new Map();
    for (const ref of all) if (seen.has(practiceReferenceKey(ref))) seenByMatch.set(ref.matchId, (seenByMatch.get(ref.matchId) || 0) + 1);
    const eligibleMatches = [...new Set(available.map(ref => ref.matchId))];
    const fewestSeen = Math.min(...eligibleMatches.map(matchId => seenByMatch.get(matchId) || 0));
    const matchId = choose(eligibleMatches.filter(matchId => (seenByMatch.get(matchId) || 0) === fewestSeen));
    const chosen = choose(available.filter(ref => ref.matchId === matchId));
    const reference = {packId:chosen.packId, scenarioId:chosen.scenarioId};
    const key = practiceReferenceKey(reference);
    selected.push(reference); selectedKeys.add(key); seen.add(key); matches.add(chosen.matchId);
  }
  return {references:selected, seen:[...seen]};
}

/** Practice requires a complete, continuously living route from T through T+60. */
export function isPracticeRoundEligible(scenario) {
  if (!isRecord(scenario) || !Number.isFinite(scenario.time) || scenario.time <= 360 ||
      !Array.isArray(scenario.players) || !nonEmptyString(scenario.you)) return false;
  if (QUARANTINED_PRACTICE_ROUNDS.has(scenario.id)) return false;

  const tracked = scenario.players.filter(player => isRecord(player) && player.id === scenario.you);
  if (tracked.length !== 1 || tracked[0].alive !== true) return false;

  const player = tracked[0];
  if (player.health !== undefined && (!Number.isFinite(player.health) || player.health <= 0)) return false;
  if (player.respawn !== undefined && player.respawn !== null &&
      (!Number.isFinite(player.respawn) || player.respawn < 0 || player.respawn > 0)) return false;
  const movement = scenario.recordedMove;
  if (!isRecord(movement) || movement.fromSecond !== scenario.time || movement.toSecond !== scenario.time + 60 ||
      !Array.isArray(movement.path) || movement.path.length !== 61) return false;
  return movement.path.every((point, index) => isRecord(point) && point.alive === true &&
    point.second === scenario.time + index && isCoordinate(point.x) && isCoordinate(point.y));
}

/** Remaining limits after replay, FOW and objective evidence has been merged. */
export function practiceReviewWarnings(scenario) {
  const source = scenario.source ?? {};
  const warnings = [];
  if (source.visibilityVerified !== true) warnings.push('Enemy visibility is unverified; enemy positions are omitted.');
  if (source.objectivesVerified !== true || source.objectivesDownVerified !== true) warnings.push('Some objective health or destruction states are unverified.');
  warnings.push('Camp HUD markers do not establish camp life, health or respawn timers.');
  if (source.laneStatesVerified !== true) warnings.push('Recorded lane markers do not establish living wave counts or reviewed lane states.');
  if (scenario.approved !== true) warnings.push('The recorded destination has not been reviewed as the optimal move.');
  if ((scenario.players ?? []).some(player => player.ultCooldown == null)) warnings.push('Some ultimate cooldowns are unknown.');
  return warnings;
}

/** Resolve only selected packs and verify that source identity matches the index. */
export function assemblePracticeSession(library, references, packs, id) {
  if (!validatePracticeReferences(library, references)) throw new TypeError("Practice references are unavailable");
  const scenarios = references.map(reference => {
    const entry = library.packs.find(pack => pack.id === reference.packId);
    const pack = packs.get(reference.packId);
    const validation = validateChallenge(pack);
    if (!validation.valid || pack.kind !== "practice") throw new TypeError(`Practice pack ${entry.id} is invalid`);
    if (pack.scenarios.length !== entry.scenarioIds.length || pack.scenarios.some(s => !entry.scenarioIds.includes(s.id))) throw new TypeError(`Practice pack ${entry.id} has changed`);
    const scenario = pack.scenarios.find(s => s.id === reference.scenarioId);
    if (!scenario || scenario.source?.kind !== "match" || scenario.source.matchId !== entry.matchId) throw new TypeError(`Practice source ${entry.id} does not match its index`);
    if (!isPracticeRoundEligible(scenario)) throw new TypeError(`Practice round ${scenario.id} requires a live tracked player and complete living T+60 route after 6:00`);
    return scenario;
  });
  const challenge = {id, kind:"practice", date:null, title:"Recorded practice", scenarios};
  const validation = validateChallenge(challenge);
  if (!validation.valid) throw new TypeError(validation.errors.join("; "));
  return challenge;
}

/** Sum strict binary result scores. */
export function calculateTotal(results) {
  if (!Array.isArray(results)) throw new TypeError("results must be an array");

  let total = 0;
  for (const result of results) {
    if (!isRecord(result) || typeof result.score !== "number" || !Number.isFinite(result.score) ||
      (result.score !== 0 && result.score !== 1)) {
      throw new RangeError("each result score must be exactly 0 or 1");
    }
    total += result.score;
  }
  return total;
}

function scoreTile(score) {
  if (score === 1) return "🟩";
  if (score === 0) return "⬛";
  throw new RangeError("each result score must be exactly 0 or 1");
}

/** Serialize a compact copyable result line; ten rounds produce ten tiles. */
export function serializeShare({ date, mode, results }) {
  assertDateString(date);
  if (typeof mode !== "string" || mode.trim() === "") throw new TypeError("mode must be a non-empty string");
  if (!Array.isArray(results)) throw new TypeError("results must be an array");

  const score = calculateTotal(results);
  const tiles = results.map((result) => scoreTile(result.score)).join("");

  return `MacroLock | ${date} | ${mode.trim()}\n${score}/10\n${tiles}`;
}

function addError(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function plainText(value) {
  return nonEmptyString(value) && !/[<>]/.test(value);
}

function isSafeMapAsset(value) {
  return typeof value === "string" && /^assets\/(?:game-map|maps)\/[^/\\]+\.png$/.test(value) && !value.includes("..");
}

function validatePlayer(player, path, errors, playerIds, teamCounts) {
  if (!isRecord(player)) {
    addError(errors, path, "must be an object");
    return;
  }

  if (!nonEmptyString(player.id)) addError(errors, `${path}.id`, "must be a non-empty string");
  else if (playerIds.has(player.id)) addError(errors, `${path}.id`, "must be unique within the scenario");
  else playerIds.add(player.id);

  if (!nonEmptyString(player.hero)) addError(errors, `${path}.hero`, "must be a non-empty hero slug");
  if (player.team !== "amber" && player.team !== "sapphire") {
    addError(errors, `${path}.team`, "must be amber or sapphire");
  } else {
    teamCounts[player.team] += 1;
  }

  if (player.x === null && player.y === null) {
    // A hidden or unobserved player can have an explicitly unknown position.
  } else if (player.x === null || player.y === null || typeof player.x !== "number" || typeof player.y !== "number") {
    addError(errors, path, "x and y must be present as finite normalized coordinates or both null for unknown position");
  } else if (!isCoordinate(player.x) || !isCoordinate(player.y)) {
    addError(errors, path, "x and y must be finite normalized coordinates from 0 to 100");
  }

  if (typeof player.alive !== "boolean") addError(errors, `${path}.alive`, "must be boolean");
  if (player.respawn !== null && (!Number.isFinite(player.respawn) || player.respawn < 0)) {
    addError(errors, `${path}.respawn`, "must be null or a non-negative finite number");
  }
  if (!Number.isInteger(player.level) || player.level < 1) addError(errors, `${path}.level`, "must be a positive integer");
  if (!Number.isFinite(player.souls) || player.souls < 0) addError(errors, `${path}.souls`, "must be a non-negative finite number");
  if (!Array.isArray(player.items) || player.items.some((item) => !nonEmptyString(item))) {
    addError(errors, `${path}.items`, "must be a list of non-empty item ids");
  }
  if (player.effects !== undefined && (!Array.isArray(player.effects) || player.effects.some((effect) => !PLAYER_EFFECTS.has(effect)) || new Set(player.effects).size !== player.effects.length)) {
    addError(errors, `${path}.effects`, "must be an array containing only known effects");
  }
  if (player.visible !== undefined && typeof player.visible !== "boolean") {
    addError(errors, `${path}.visible`, "must be boolean when present");
  }
  if (player.health !== undefined && (!Number.isFinite(player.health) || player.health < 0 || player.health > 100)) {
    addError(errors, `${path}.health`, "must be between 0 and 100 when present");
  }
  if (player.ultCooldown !== undefined && player.ultCooldown !== null && (!Number.isFinite(player.ultCooldown) || player.ultCooldown < 0)) {
    addError(errors, `${path}.ultCooldown`, "must be null or a non-negative finite number");
  }
  if (player.itemCooldowns !== undefined) {
    if (!isRecord(player.itemCooldowns)) {
      addError(errors, `${path}.itemCooldowns`, "must be an object keyed by numeric item IDs");
    } else {
      for (const [itemId, remaining] of Object.entries(player.itemCooldowns)) {
        if (!/^[0-9]+$/.test(itemId)) addError(errors, `${path}.itemCooldowns.${itemId}`, "item ID must be numeric");
        if (remaining !== null && (!Number.isFinite(remaining) || remaining < 0)) {
          addError(errors, `${path}.itemCooldowns.${itemId}`, "cooldown must be null or a non-negative finite number");
        }
      }
    }
  }
  if (player.unspentSouls !== undefined && player.unspentSouls !== null && (!Number.isFinite(player.unspentSouls) || player.unspentSouls < 0)) {
    addError(errors, `${path}.unspentSouls`, "must be null or a non-negative finite number");
  }
}

function validateAnswerZones(zones, path, errors) {
  if (!Array.isArray(zones) || zones.length !== 1) {
    addError(errors, path, "must contain exactly one answer zone");
    if (!Array.isArray(zones) || zones.length === 0) return;
  }

  const zoneIds = new Set();
  zones.forEach((zone, index) => {
    const zonePath = `${path}[${index}]`;
    if (!isRecord(zone)) {
      addError(errors, zonePath, "must be an object");
      return;
    }
    if (!nonEmptyString(zone.id)) addError(errors, `${zonePath}.id`, "must be a non-empty string");
    else if (zoneIds.has(zone.id)) addError(errors, `${zonePath}.id`, "must be unique within the scenario");
    else zoneIds.add(zone.id);
    if (!nonEmptyString(zone.label)) addError(errors, `${zonePath}.label`, "must be a non-empty string");
    if (!isCoordinate(zone.x) || !isCoordinate(zone.y)) addError(errors, zonePath, "x and y must be finite normalized coordinates from 0 to 100");
    if (!Number.isFinite(zone.radius) || zone.radius <= 0) addError(errors, `${zonePath}.radius`, "must be a positive finite number");
    if (zone.score !== 1) addError(errors, `${zonePath}.score`, "must be exactly 1");
    if (!nonEmptyString(zone.explanation)) addError(errors, `${zonePath}.explanation`, "must be a non-empty string");
  });
}

function validateSignals(signals, path, errors) {
  if (signals === undefined) return;
  if (!Array.isArray(signals)) {
    addError(errors, path, "must be an array when present");
    return;
  }

  const signalIds = new Set();
  signals.forEach((signal, index) => {
    const signalPath = `${path}[${index}]`;
    if (!isRecord(signal)) {
      addError(errors, signalPath, "must be an object");
      return;
    }
    if (!plainText(signal.id)) addError(errors, `${signalPath}.id`, "must be a non-empty plain string");
    else if (signalIds.has(signal.id)) addError(errors, `${signalPath}.id`, "must be unique within the scenario");
    else signalIds.add(signal.id);
    if (!plainText(signal.label)) addError(errors, `${signalPath}.label`, "must be a non-empty plain string");
    if (!SIGNAL_KINDS.has(signal.kind)) addError(errors, `${signalPath}.kind`, "must be wave, fight, camp, or urn");
    if (!SIGNAL_TEAMS.has(signal.team)) addError(errors, `${signalPath}.team`, "must be amber, sapphire, or neutral");
    if (!isCoordinate(signal.x) || !isCoordinate(signal.y)) addError(errors, signalPath, "x and y must be finite normalized coordinates from 0 to 100");
    if (signal.context !== undefined && !plainText(signal.context)) addError(errors, `${signalPath}.context`, "must be a plain string when present");
    if (signal.health !== undefined && (!Number.isFinite(signal.health) || signal.health < 0 || signal.health > 100)) {
      addError(errors, `${signalPath}.health`, "must be between 0 and 100 when present");
    }
  });
}

function validateMap(map, path, errors) {
  if (map === undefined) return;
  if (!isRecord(map)) {
    addError(errors, path, "must be an object when present");
    return;
  }

  const safeImage = typeof map.image === "string" && /^assets\/maps\/[^/\\]+\.png$/.test(map.image) && !map.image.includes("..");
  if (!safeImage) addError(errors, `${path}.image`, "must be a local assets/maps/<filename>.png path");
  if (!Number.isFinite(map.radius) || map.radius <= 0) addError(errors, `${path}.radius`, "must be a positive finite number");
  if (!Number.isInteger(map.clientVersion) || map.clientVersion < 1) addError(errors, `${path}.clientVersion`, "must be a positive integer");
  for (const frameKey of ["frame", "frameMask"]) {
    if (map[frameKey] !== undefined && !isSafeMapAsset(map[frameKey])) addError(errors, `${path}.${frameKey}`, "must be a local game-map or maps PNG path");
  }
  if (map.layers !== undefined) {
    if (!isRecord(map.layers)) {
      addError(errors, `${path}.layers`, "must be an object when present");
    } else {
      for (const [layerKey, layerPath] of Object.entries(map.layers)) {
        if (!MAP_LAYER_KEYS.has(layerKey)) addError(errors, `${path}.layers.${layerKey}`, "is not an allowed map layer");
        if (!isSafeMapAsset(layerPath)) addError(errors, `${path}.layers.${layerKey}`, "must be a local game-map or maps PNG path");
      }
    }
  }

  if (!Array.isArray(map.objectives) || map.objectives.length === 0) {
    addError(errors, `${path}.objectives`, "must be a non-empty array");
  } else {
    const objectiveIds = new Set();
    map.objectives.forEach((objective, index) => {
      const objectivePath = `${path}.objectives[${index}]`;
      if (!isRecord(objective)) {
        addError(errors, objectivePath, "must be an object");
        return;
      }
      if (!nonEmptyString(objective.id)) addError(errors, `${objectivePath}.id`, "must be a non-empty string");
      else if (objectiveIds.has(objective.id)) addError(errors, `${objectivePath}.id`, "must be unique within the map");
      else objectiveIds.add(objective.id);
      if (!MAP_TEAMS.has(objective.team)) addError(errors, `${objectivePath}.team`, "must be amber or sapphire");
      if (!MAP_OBJECTIVE_KINDS.has(objective.kind)) addError(errors, `${objectivePath}.kind`, "must be guardian, walker, shrine, or patron");
      if (!isCoordinate(objective.x) || !isCoordinate(objective.y)) addError(errors, objectivePath, "x and y must be finite normalized coordinates from 0 to 100");
    });
  }

  if (!Array.isArray(map.camps) || map.camps.length !== 51) {
    addError(errors, `${path}.camps`, "must contain all 51 neutral camps");
  } else {
    const campIds = new Set();
    map.camps.forEach((camp, index) => {
      const campPath = `${path}.camps[${index}]`;
      if (!isRecord(camp)) {
        addError(errors, campPath, "must be an object");
        return;
      }
      if (!plainText(camp.id)) addError(errors, `${campPath}.id`, "must be a non-empty plain string");
      else if (campIds.has(camp.id)) addError(errors, `${campPath}.id`, "must be unique within the map");
      else campIds.add(camp.id);
      if (!plainText(camp.label)) addError(errors, `${campPath}.label`, "must be a non-empty plain string");
      if (!MAP_CAMP_KINDS.has(camp.kind)) addError(errors, `${campPath}.kind`, "must be weak, medium, strong, or vault");
      if (!isCoordinate(camp.x) || !isCoordinate(camp.y)) addError(errors, campPath, "x and y must be finite normalized coordinates from 0 to 100");
      if (typeof camp.icon !== "string" || !/^assets\/game-icons\/[^/\\]+\.png$/.test(camp.icon) || camp.icon.includes("..")) {
        addError(errors, `${campPath}.icon`, "must be a local assets/game-icons/<filename>.png path");
      }
      if (camp.iconSource !== undefined && (typeof camp.iconSource !== "string" || /[<>]/.test(camp.iconSource))) addError(errors, `${campPath}.iconSource`, "must be a plain string when present");
    });
  }

  if (map.pois !== undefined) {
    if (!Array.isArray(map.pois)) {
      addError(errors, `${path}.pois`, "must be an array when present");
    } else {
      const poiIds = new Set();
      map.pois.forEach((poi, index) => {
        const poiPath = `${path}.pois[${index}]`;
        if (!isRecord(poi)) {
          addError(errors, poiPath, "must be an object");
          return;
        }
        if (!plainText(poi.id)) addError(errors, `${poiPath}.id`, "must be a non-empty plain string");
        else if (poiIds.has(poi.id)) addError(errors, `${poiPath}.id`, "must be unique within the map");
        else poiIds.add(poi.id);
        if (!plainText(poi.label)) addError(errors, `${poiPath}.label`, "must be a non-empty plain string");
        if (!MAP_POI_KINDS.has(poi.kind)) addError(errors, `${poiPath}.kind`, "must be shop, teleporter, urn, or urn-pad");
        if (!isCoordinate(poi.x) || !isCoordinate(poi.y)) addError(errors, poiPath, "x and y must be finite normalized coordinates from 0 to 100");
        if (typeof poi.icon !== "string" || !/^assets\/game-icons\/[^/\\]+\.(?:png|svg)$/.test(poi.icon) || poi.icon.includes("..")) {
          addError(errors, `${poiPath}.icon`, "must be a local assets/game-icons image path");
        }
        if (poi.team !== undefined && poi.team !== "amber" && poi.team !== "sapphire") addError(errors, `${poiPath}.team`, "must be amber or sapphire when present");
      });
    }
  }

  if (!Array.isArray(map.lanes) || map.lanes.length === 0) {
    addError(errors, `${path}.lanes`, "must be a non-empty array");
  } else {
    map.lanes.forEach((lane, index) => {
      const lanePath = `${path}.lanes[${index}]`;
      if (!isRecord(lane)) {
        addError(errors, lanePath, "must be an object");
        return;
      }
      if (typeof lane.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(lane.color)) addError(errors, `${lanePath}.color`, "must be a six-digit hex color");
      if (!Array.isArray(lane.points) || lane.points.length < 2) {
        addError(errors, `${lanePath}.points`, "must contain at least two coordinate pairs");
      } else {
        lane.points.forEach((point, pointIndex) => {
          if (!Array.isArray(point) || point.length !== 2 || !isCoordinate(point[0]) || !isCoordinate(point[1])) {
            addError(errors, `${lanePath}.points[${pointIndex}]`, "must be a pair of finite normalized coordinates from 0 to 100");
          }
        });
      }
      if (lane.segments !== undefined) {
        if (!Array.isArray(lane.segments) || lane.segments.length === 0) {
          addError(errors, `${lanePath}.segments`, "must be a non-empty array when present");
        } else {
          lane.segments.forEach((segment, segmentIndex) => {
            const segmentPath = `${lanePath}.segments[${segmentIndex}]`;
            if (!isRecord(segment)) {
              addError(errors, segmentPath, "must be an object with numeric cubic points");
              return;
            }
            for (const pointKey of ["start", "c1", "c2", "end"]) {
              const point = segment[pointKey];
              if (!Array.isArray(point) || point.length !== 2 || point.some((value) => !Number.isFinite(value) || value < -100 || value > 200)) {
                addError(errors, `${segmentPath}.${pointKey}`, "must be a finite coordinate pair within -100..200");
              }
            }
          });
        }
      }
    });
  }
}

function validateLaneStates(laneStates, path, errors) {
  if (laneStates === undefined || laneStates === null) return;
  if (!Array.isArray(laneStates)) {
    addError(errors, path, "must be an array or null when present");
    return;
  }

  const laneIds = new Set();
  const waveIds = new Set();
  laneStates.forEach((lane, laneIndex) => {
    const lanePath = `${path}[${laneIndex}]`;
    if (!isRecord(lane)) {
      addError(errors, lanePath, "must be an object");
      return;
    }
    if (!plainText(lane.id)) addError(errors, `${lanePath}.id`, "must be a non-empty plain string");
    else if (laneIds.has(lane.id)) addError(errors, `${lanePath}.id`, "must be unique within the snapshot");
    else laneIds.add(lane.id);
    if (!plainText(lane.label)) addError(errors, `${lanePath}.label`, "must be a non-empty plain string");
    if (!Array.isArray(lane.waves)) {
      addError(errors, `${lanePath}.waves`, "must be an array");
      return;
    }
    lane.waves.forEach((wave, waveIndex) => {
      const wavePath = `${lanePath}.waves[${waveIndex}]`;
      if (!isRecord(wave)) {
        addError(errors, wavePath, "must be an object");
        return;
      }
      if (!plainText(wave.id)) addError(errors, `${wavePath}.id`, "must be a non-empty plain string");
      else if (waveIds.has(wave.id)) addError(errors, `${wavePath}.id`, "must be unique across the snapshot");
      else waveIds.add(wave.id);
      if (!LANE_TEAMS.has(wave.team)) addError(errors, `${wavePath}.team`, "must be amber or sapphire");
      if (!isCoordinate(wave.x) || !isCoordinate(wave.y)) addError(errors, wavePath, "x and y must be finite normalized coordinates from 0 to 100");
      if (!Number.isInteger(wave.count) || wave.count < 1 || wave.count > 20) addError(errors, `${wavePath}.count`, "must be an integer from 1 to 20");
      if (wave.health !== null && (!Number.isFinite(wave.health) || wave.health < 0 || wave.health > 100)) addError(errors, `${wavePath}.health`, "must be null or a finite value from 0 to 100");
      if (!Number.isFinite(wave.heading) || wave.heading < 0 || wave.heading >= 360) addError(errors, `${wavePath}.heading`, "must be finite and from 0 up to but excluding 360");
    });
  });
}

function validateSnapshotStates(scenario, path, errors) {
  if (scenario.objectiveStates !== undefined && scenario.objectiveStates !== null) {
    if (!isRecord(scenario.objectiveStates)) {
      addError(errors, `${path}.objectiveStates`, "must be an object keyed by objective IDs when present");
    } else {
      for (const [objectiveId, state] of Object.entries(scenario.objectiveStates)) {
        const statePath = `${path}.objectiveStates.${objectiveId}`;
        if (!plainText(objectiveId)) addError(errors, statePath, "objective ID must be a plain string");
        if (!isRecord(state)) {
          addError(errors, statePath, "must be an object");
          continue;
        }
        if (state.active !== undefined && typeof state.active !== "boolean") addError(errors, `${statePath}.active`, "must be boolean when present");
        if (state.phase !== undefined && state.phase !== "patron" && state.phase !== "weakened") addError(errors, `${statePath}.phase`, "must be patron or weakened when present");
        if (!Object.prototype.hasOwnProperty.call(state, "health") ||
          (state.health !== null && (!Number.isFinite(state.health) || state.health < 0 || state.health > 100))) {
          addError(errors, `${statePath}.health`, "must be null or a finite value from 0 to 100");
        }
      }
    }
  }
  if (scenario.campStates !== undefined && scenario.campStates !== null) {
    if (!isRecord(scenario.campStates)) {
      addError(errors, `${path}.campStates`, "must be an object keyed by camp IDs when present");
    } else {
      for (const [campId, state] of Object.entries(scenario.campStates)) {
        const statePath = `${path}.campStates.${campId}`;
        if (!plainText(campId)) addError(errors, statePath, "camp ID must be a plain string");
        if (!isRecord(state)) {
          addError(errors, statePath, "must be an object");
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(state, "alive") || (state.alive !== null && typeof state.alive !== "boolean")) {
          addError(errors, `${statePath}.alive`, "must be null or boolean");
        }
        if (state.visibleOnMap !== undefined && typeof state.visibleOnMap !== "boolean") addError(errors, `${statePath}.visibleOnMap`, "must be boolean when present");
        if (!Object.prototype.hasOwnProperty.call(state, "respawn") ||
          (state.respawn !== null && (!Number.isFinite(state.respawn) || state.respawn < 0))) {
          addError(errors, `${statePath}.respawn`, "must be null or a non-negative finite number");
        }
      }
    }
  }
}

function validateDailyVisibility(scenario, path, errors, source) {
  if (!Array.isArray(scenario.players)) return;
  const me = scenario.players.find((player) => isRecord(player) && player.id === scenario.you);
  if (!me) return;
  scenario.players.forEach((player, index) => {
    if (!isRecord(player)) return;
    const playerPath = `${path}.players[${index}]`;
    if (player.team === me.team) {
      if (!isCoordinate(player.x) || !isCoordinate(player.y)) addError(errors, playerPath, "daily allied positions must be known normalized coordinates");
    } else if (player.visible === true) {
      if (source?.visibilityVerified !== true) addError(errors, `${playerPath}.visible`, "visible enemy positions require verified perspective visibility");
    } else if (player.x !== null || player.y !== null) {
      addError(errors, playerPath, "hidden enemy positions must both be null");
    }
  });
}

function validateSource(source, path, errors, challengeKind, minimumBadge) {
  if (!isRecord(source)) {
    addError(errors, path, "must be an object with kind metadata");
    return;
  }
  if (source.kind !== "practice" && source.kind !== "match") {
    addError(errors, `${path}.kind`, "must be practice or match");
    return;
  }
  if (source.matchId !== undefined && !nonEmptyString(source.matchId)) {
    addError(errors, `${path}.matchId`, "must be a non-empty string when present");
  }
  if (source.clientVersion !== undefined && (!Number.isInteger(source.clientVersion) || source.clientVersion < 1)) {
    addError(errors, `${path}.clientVersion`, "must be a positive integer when present");
  }
  if (source.laneStatesVerified !== undefined && typeof source.laneStatesVerified !== "boolean") {
    addError(errors, `${path}.laneStatesVerified`, "must be boolean when present");
  }
  if (challengeKind === "daily" && source.kind !== "match") {
    addError(errors, path, "daily scenarios must come from match sources");
  }
  if (challengeKind === "daily") {
    if (!/^[1-9][0-9]*$/.test(source.matchId ?? "")) addError(errors, `${path}.matchId`, "must be a positive numeric string for daily matches");
    if (!nonEmptyString(source.clientVersionEvidence)) addError(errors, `${path}.clientVersionEvidence`, "must be provided for daily matches");
    if (typeof source.metadataSha256 !== "string" || !/^[0-9a-f]{64}$/.test(source.metadataSha256)) {
      addError(errors, `${path}.metadataSha256`, "must be a lowercase hexadecimal SHA-256 string");
    }
    if (source.objectivesVerified !== true) addError(errors, `${path}.objectivesVerified`, "must be true for daily matches");
    if (!RANKED_MATCH_MODES.has(source.matchMode)) addError(errors, `${path}.matchMode`, "must identify a ranked match");
    if (!NORMAL_GAME_MODES.has(source.gameMode)) addError(errors, `${path}.gameMode`, "must identify a normal game");
    if (!Number.isFinite(source.averageBadge) || source.averageBadge < minimumBadge) {
      addError(errors, `${path}.averageBadge`, `must be finite and at least ${minimumBadge}`);
    }
  }
}

function validateScenario(scenario, path, errors, challengeKind, scenarioIds, minimumBadge) {
  if (!isRecord(scenario)) {
    addError(errors, path, "must be an object");
    return;
  }

  if (!nonEmptyString(scenario.id)) addError(errors, `${path}.id`, "must be a non-empty string");
  else if (scenarioIds.has(scenario.id)) addError(errors, `${path}.id`, "must be unique within the challenge");
  else scenarioIds.add(scenario.id);

  if (!Number.isFinite(scenario.time) || scenario.time < 0) addError(errors, `${path}.time`, "must be a non-negative time in seconds");
  if (!nonEmptyString(scenario.you)) addError(errors, `${path}.you`, "must be a player id");
  if (scenario.activePois !== undefined && (!Array.isArray(scenario.activePois) || scenario.activePois.some((poi) => !plainText(poi)))) {
    addError(errors, `${path}.activePois`, "must be an array of plain POI ID strings when present");
  }
  if (scenario.mapLayer !== undefined && scenario.mapLayer !== "surface" && scenario.mapLayer !== "tunnels" && scenario.mapLayer !== "ratTunnels") {
    addError(errors, `${path}.mapLayer`, "must be surface, tunnels, or ratTunnels when present");
  }
  if (scenario.context !== undefined && !plainText(scenario.context)) addError(errors, `${path}.context`, "must be a plain string when present");
  validateSignals(scenario.signals, `${path}.signals`, errors);
  const objectivesDownValid = Array.isArray(scenario.objectivesDown) && scenario.objectivesDown.every((id) => plainText(id));
  if (scenario.objectivesDown !== undefined && !objectivesDownValid) {
    addError(errors, `${path}.objectivesDown`, "must be an array of objective id strings when present");
  }
  if (scenario.midbossAlive !== undefined && typeof scenario.midbossAlive !== "boolean") addError(errors, `${path}.midbossAlive`, "must be boolean when present");
  if (scenario.approved !== undefined && typeof scenario.approved !== "boolean") addError(errors, `${path}.approved`, "must be boolean when present");
  validateLaneStates(scenario.laneStates, `${path}.laneStates`, errors);
  if (scenario.minimapTroopers !== undefined) {
    if (!Array.isArray(scenario.minimapTroopers) || scenario.minimapTroopers.length > 192) {
      addError(errors, `${path}.minimapTroopers`, "must be an array of at most 192 troopers");
    } else {
      const ids = new Set();
      scenario.minimapTroopers.forEach((trooper, i) => {
        const itemPath = `${path}.minimapTroopers[${i}]`;
        if (!isRecord(trooper)) { addError(errors, itemPath, "must be an object"); return; }
        if (!plainText(trooper.id) || ids.has(trooper.id)) addError(errors, `${itemPath}.id`, "must be a unique plain string");
        else ids.add(trooper.id);
        if (!isCoordinate(trooper.x) || !isCoordinate(trooper.y)) addError(errors, itemPath, "coordinates must be within 0..100");
        if (!MAP_TEAMS.has(trooper.team)) addError(errors, `${itemPath}.team`, "must be amber or sapphire");
      });
    }
  }

  if (!Array.isArray(scenario.players)) {
    addError(errors, `${path}.players`, "must be an array of 12 players");
  } else {
    if (scenario.players.length !== 12) addError(errors, `${path}.players`, "must contain exactly 12 players");
    const playerIds = new Set();
    const teamCounts = { amber: 0, sapphire: 0 };
    scenario.players.forEach((player, index) => validatePlayer(player, `${path}.players[${index}]`, errors, playerIds, teamCounts));
    if (teamCounts.amber !== 6 || teamCounts.sapphire !== 6) {
      addError(errors, `${path}.players`, "must contain six amber and six sapphire players");
    }
    if (nonEmptyString(scenario.you) && !playerIds.has(scenario.you)) {
      addError(errors, `${path}.you`, "must reference a player in this scenario");
    }
  }

  validateAnswerZones(scenario.answerZones, `${path}.answerZones`, errors);
  validateSnapshotStates(scenario, path, errors);
  validateSource(scenario.source, `${path}.source`, errors, challengeKind, minimumBadge);
  validateMap(scenario.map, `${path}.map`, errors);

  const source = isRecord(scenario.source) ? scenario.source : null;
  if (challengeKind === "daily") {
    if (!objectivesDownValid) addError(errors, `${path}.objectivesDown`, "is required as an array of objective id strings for daily scenarios");
    if (typeof scenario.midbossAlive !== "boolean") addError(errors, `${path}.midbossAlive`, "is required as a boolean for daily scenarios");
    if (scenario.approved !== true) addError(errors, `${path}.approved`, "must be true for daily scenarios");
    if (!source || !Number.isInteger(source.clientVersion) || source.clientVersion < 1) {
      addError(errors, `${path}.source.clientVersion`, "daily scenarios require a positive integer clientVersion");
    }
    for (const flag of ["mapVerified", "rankVerified", "assetDefinitionsVersionVerified"]) {
      if (!source || source[flag] !== true) addError(errors, `${path}.source.${flag}`, "must be true for daily scenarios");
    }
    if (!source || source.laneStatesVerified !== true) addError(errors, `${path}.source.laneStatesVerified`, "must be true for daily scenarios");
    if (!Array.isArray(scenario.laneStates)) addError(errors, `${path}.laneStates`, "reviewed lane states are required for daily scenarios");
    validateDailyVisibility(scenario, path, errors, source);
    if (scenario.map === undefined && (!source || source.clientVersion !== 6795)) {
      addError(errors, `${path}.map`, "is required for daily scenarios unless clientVersion is exactly 6795");
    }
  }
  if (source && source.clientVersion !== undefined && isRecord(scenario.map) && scenario.map.clientVersion !== source.clientVersion) {
    addError(errors, `${path}.map.clientVersion`, "must match source.clientVersion");
  }
}

/** Validate imported challenge data without mutating or normalizing it. */
export function validateChallenge(challenge) {
  const errors = [];
  if (!isRecord(challenge)) return { valid: false, errors: ["challenge: must be an object"] };
  if (!nonEmptyString(challenge.id)) addError(errors, "id", "must be a non-empty string");
  if (!nonEmptyString(challenge.title)) addError(errors, "title", "must be a non-empty string");
  if (challenge.kind !== "practice" && challenge.kind !== "daily") addError(errors, "kind", "must be practice or daily");
  const minimumBadge = challenge.minimumBadge === undefined ? 116 : challenge.minimumBadge;
  if (!Number.isInteger(minimumBadge) || minimumBadge < 111 || minimumBadge > 116) {
    addError(errors, "minimumBadge", "must be an integer from 111 to 116 when present");
  }
  const practiceWithoutDate = challenge.kind === "practice" && (challenge.date === null || challenge.date === undefined);
  if (!practiceWithoutDate && typeof challenge.date !== "string") {
    addError(errors, "date", "must be a UTC date in YYYY-MM-DD format for daily challenges; practice dates may be null");
  } else if (!practiceWithoutDate) {
    try {
      assertDateString(challenge.date);
    } catch (error) {
      addError(errors, "date", error.message);
    }
  }

  if (!Array.isArray(challenge.scenarios)) {
    addError(errors, "scenarios", "must be an array");
  } else {
    if (challenge.kind === "daily" && challenge.scenarios.length !== 10) {
      addError(errors, "scenarios", "daily challenges must contain exactly 10 scenarios");
    }
    if (challenge.kind === "practice" && (challenge.scenarios.length < 1 || challenge.scenarios.length > 10)) {
      addError(errors, "scenarios", "practice challenges must contain between 1 and 10 scenarios");
    }
    const scenarioIds = new Set();
    challenge.scenarios.forEach((scenario, index) => validateScenario(scenario, `scenarios[${index}]`, errors, challenge.kind, scenarioIds, minimumBadge));
  }

  return { valid: errors.length === 0, errors };
}

export default {
  scoreChoice,
  dailySeed,
  selectPractice,
  calculateTotal,
  serializeShare,
  validateChallenge,
};
