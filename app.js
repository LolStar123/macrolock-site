import { calculateTotal, serializeShare, recordedRouteSections, nearestScoredRoutePoint, ROUTE_SCORING_START, validateChallenge, validatePracticeLibrary, validatePracticeReferences, selectPracticeReferences, assemblePracticeSession, isPracticeRoundEligible } from './engine.js';
import { deadHeroStrip } from './snapshot-status.js';
import { presentPlayer, ultimateState, healthLabel, namedCampTargets, recordedTargetSecond, isCompletedRunStale, teleporterTargets, modeURL, isMapInverted, screenLane } from './presentation.js';
import {restoreRun, transitionRun, createSharedCoordinator} from './shared-run.js';

const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');
const dialog = $('#dialog');
const today = new Date().toISOString().slice(0, 10);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const souls = (value) => Number.isFinite(value) ? `${(value / 1000).toFixed(1)}k` : '?';
const clamp = (v) => Math.max(0, Math.min(100, v));
const fmt = (value) => Number(value).toFixed(1);
const youIn = (scenario) => scenario.players.find(p => p.id === scenario.you);
// Valve's invert_map is a 180 degree turn, so the same flip maps screen to plane and back.
const viewPoint = (point, scenario) => isMapInverted(youIn(scenario).team) ? {x:100 - point.x, y:100 - point.y} : {x:point.x, y:point.y};
let catalog, practice, challenge, daily, mode = 'practice', index = 0, results = [], selected = null, review = false, finished = false, completedAt = null, dialogOpener = null, toastTimer;
let storageAvailable = true;
const memoryStorage = new Map();
const coordinate = createSharedCoordinator({onUnavailable:() => { storageAvailable = false; }});
let disposeMapInspection = () => {};
let practiceLibrary = null, practiceFallback = null, practiceLoading = null, modeRequest = 0;
const practicePacks = new Map();
const practiceSessionKey = 'macrolock:practice-session:v1';
const practiceSeenKey = 'macrolock:practice-seen:v1';

function gameIcon(kind, extraClass = '') {
  const path = catalog.icons?.[kind] || (kind === 'ping' ? catalog.icons?.destination : null);
  return path ? `<img class="game-icon ${extraClass}" src="${escape(path)}" alt="" draggable="false">` : '';
}

function readStorage(key, fallback) {
  if (!storageAvailable) return memoryStorage.get(key) ?? fallback;
  try { const value = JSON.parse(localStorage.getItem(key)) ?? fallback; memoryStorage.set(key, value); return value; }
  catch { storageAvailable = false; return memoryStorage.get(key) ?? fallback; }
}
function writeStorage(key, value) {
  memoryStorage.set(key, value);
  if (!storageAvailable) return;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { storageAvailable = false; }
}
function getHistory() {
  const rows = readStorage('macrolock:history:binary-v1', []);
  return Array.isArray(rows) ? rows.filter(r => r && typeof r === 'object' && typeof r.id === 'string' && Number.isFinite(r.score) && r.score >= 0 && r.score <= 10) : [];
}
function key() { return `macrolock:run:binary-v1:${mode}:${challenge.id}:${challenge.date || 'v1'}`; }
let appliedRunKey = null, appliedRevision = -1;
function applyRun(run) {
  const identity = key();
  if (identity === appliedRunKey && run.revision < appliedRevision) return false;
  appliedRunKey = identity; appliedRevision = run.revision;
  ({index, results, selected, finished, completedAt} = run); review = false;
  return true;
}
function displayedRun() { return {index, results, selected, finished, completedAt}; }
function currentPracticeSession() { return readStorage(practiceSessionKey, null); }
function currentSessionMatches(id = challenge?.id) { return mode !== 'practice' || currentPracticeSession()?.id === id; }
function showCurrentRun({reveal = false, focus = false} = {}) {
  if (finished) { renderResults(); if (focus) scrollTop(); }
  else {
    renderRound({reveal});
    if (focus) { scrollTop(); focusContent(results[index] ? '#next-button' : '#map-input'); }
  }
}
async function mutateRun(command) {
  const source = challenge, sourceMode = mode;
  const outcome = await coordinate(() => {
    if (challenge !== source || mode !== sourceMode || !currentSessionMatches(source.id)) return null;
    const before = restoreRun(readStorage(key(), null), source.scenarios);
    const after = transitionRun(before, command, source.scenarios);
    if (after !== before) writeStorage(key(), after);
    return {run:after, accepted:after !== before};
  });
  if (challenge !== source || mode !== sourceMode) return false;
  if (!outcome) { await setMode('practice'); toast('Practice updated in another tab.'); return false; }
  const changed = JSON.stringify(displayedRun()) !== JSON.stringify({index:outcome.run.index,results:outcome.run.results,selected:outcome.run.selected,finished:outcome.run.finished,completedAt:outcome.run.completedAt});
  if (!applyRun(outcome.run)) return false;
  if (outcome.run.finished) recordCompletion();
  if (command.type !== 'pin' || changed) showCurrentRun({reveal:command.type === 'lock' && outcome.accepted, focus:command.type !== 'pin' || !outcome.accepted});
  return outcome.accepted;
}
function heroData(player) { return Object.hasOwn(catalog.heroes,player.hero) ? catalog.heroes[player.hero] : { name: String(player.hero), image: null }; }
function itemData(id) { return Object.hasOwn(catalog.items,id) ? catalog.items[id] : {name:`Item ${id}`,type:'unknown'}; }
function mapFor(scenario) { return scenario.map || catalog.map; }
function portrait(player, className = 'portrait') {
  const hero = heroData(player);
  return hero.image ? `<img class="${className}" src="${escape(hero.image)}" alt="${escape(hero.name)}" width="33" height="33">` : `<span class="${className} portrait-fallback" role="img" aria-label="${escape(hero.name)}">${escape(hero.name.slice(0, 2))}</span>`;
}
function cooldownLabel(seconds) { return Number.isFinite(seconds) ? seconds === 0 ? 'Ready' : `${Math.ceil(seconds)}s` : '?'; }
function ultimateStatus(player) {
  const ability = heroData(player).ultimate;
  const status = ultimateState(player);
  return `<span class="ultimate-status ${status.ready ? 'ready' : ''}" title="${escape(ability?.name || 'Ultimate')} · ${status.description}" aria-label="Ultimate: ${escape(ability?.name || '')}, ${status.description}">${ability?.image ? `<img src="${escape(ability.image)}" alt="" width="20" height="20">` : '<span class="ult-label">ULT</span>'}<span>${status.label}</span></span>`;
}
function outcomeMark(score) {
  return `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="${score === 1 ? 'm3.5 8 3 3 6-6' : 'M4.5 8h7'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function lobbyGlance(scenario, you) {
  const group = (players, relation) => `<div class="glance-team ${relation}" role="group" aria-label="${relation === 'allies' ? 'Your team' : 'Enemy team'} snapshot">${players.map(rawPlayer => {
    const player = presentPlayer(rawPlayer, you);
    const hero = heroData(player), ult = ultimateState(player);
    const hp = Number.isFinite(player.health) ? clamp(player.health) : null;
    const healthState = hp === null ? 'unknown' : hp > 60 ? 'healthy' : hp >= 30 ? 'hurt' : 'critical';
    const life = player.alive ? `${hp === null ? 'unknown' : Math.round(hp) + ' percent'} health` : `dead, respawns in ${Number.isFinite(player.respawn) ? Math.ceil(player.respawn) + ' seconds' : 'unknown time'}`;
    return `<button class="glance-player ${player.id === you.id ? 'you' : ''} ${player.alive ? '' : 'dead'}" data-player="${escape(player.id)}" aria-label="${escape(hero.name)}${player.id === you.id ? ', you' : ''}. ${escape(life)}. ${escape(souls(player.souls))} souls. Ultimate ${escape(ult.description)}. Inspect items."><span class="glance-portrait">${portrait(player)}${player.alive ? '' : `${gameIcon('deathSkull','glance-skull')}<span class="glance-respawn">${Number.isFinite(player.respawn) ? Math.ceil(player.respawn) + 's' : '?'}</span>`}</span><span class="glance-health ${healthState}" role="img" aria-label="${hp === null ? 'Health unknown' : Math.round(hp) + '% health'}"><span style="width:${player.alive && hp !== null ? hp : 0}%"></span></span><span class="glance-souls">${souls(player.souls)}</span><span class="glance-ultimate ${ult.ready ? 'ready' : ''}" title="Ultimate ${escape(ult.description)}">${hero.ultimate?.image ? `<img src="${escape(hero.ultimate.image)}" alt="" width="12" height="12">` : ''}<span>${escape(ult.label)}</span></span></button>`;
  }).join('')}</div>`;
  return `<div class="lobby-glance">${group(scenario.players.filter(p => p.team === you.team).sort((a, b) => (b.id === you.id) - (a.id === you.id)), 'allies')}${group(scenario.players.filter(p => p.team !== you.team), 'enemies')}</div>`;
}
function heldItem(id, player) {
  const item = itemData(id);
  const cooldown = player.itemCooldowns?.[id];
  const unknown = cooldown === null || (item.active === true && !Number.isFinite(cooldown));
  const cooldownText = unknown ? 'Cooldown unknown' : Number.isFinite(cooldown) ? cooldownLabel(cooldown) : '';
  return `<span class="item ${escape(item.type)} ${cooldown > 0 ? 'on-cooldown' : ''}" title="${escape(item.name)}${cooldownText ? ` · ${cooldownText}` : ''}" role="img" aria-label="${escape(item.name)}${cooldownText ? `, ${cooldownText}` : ''}">${item.image ? `<img src="${escape(item.image)}" alt="" loading="lazy" width="22" height="22">` : `<span aria-hidden="true">${escape(item.name.slice(0, 2))}</span>`}${unknown ? '<span class="item-cooldown">?</span>' : cooldown > 0 ? `<span class="item-cooldown">${Math.ceil(cooldown)}</span>` : ''}</span>`;
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 2600);
}
function showDialog(title, content) {
  dialogOpener = document.activeElement;
  $('#dialog-title').textContent = title;
  $('#dialog-content').innerHTML = content;
  dialog.showModal();
}
function closeDialog() { dialog.close(); }
$('#close-dialog').addEventListener('click', closeDialog);
dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDialog(); } });
dialog.addEventListener('close', () => { if (dialogOpener?.isConnected) dialogOpener.focus(); });

$('#help-button').addEventListener('click', () => showDialog('Read the room.', `<div class="dialog-body"><div class="how-step"><span>1</span><div><strong>Read the snapshot.</strong>You're the hero marked YOU. Check positions, respawns, souls and items.</div></div><div class="how-step"><span>2</span><div><strong>Place your pin.</strong>Pin anywhere the player went between 15 and 60 seconds later, shown by the target clock. No timer.</div></div><div class="how-step"><span>3</span><div><strong>Compare the move.</strong>One point if your pin touches that stretch of their recorded route. It is not a claim of the uniquely optimal play.</div></div><p class="dialog-note">Only revealed enemies appear. Tap a hero for items. Hold a map marker to inspect it. On the map, arrows move your pin (Shift for bigger steps) and Enter places or locks it. Tab to Choose a location for a named list.</p></div><button class="primary dialog-action" id="got-it">Got it<span class="button-arrow">→</span></button>`));
$('#dialog-content').addEventListener('click', e => { if (e.target.closest('#got-it')) closeDialog(); });
$('#about-button').addEventListener('click', () => showDialog('MacroLock.', `<div class="dialog-body"><p>Recorded practice compares your pin with the route the player took from 15 to 60 seconds after the snapshot. The target clock shows that window. Touching the route earns one point; the recorded play is not necessarily optimal.</p><p>Missing replay fields stay unknown. Daily sets require reviewed ranked replay snapshots.</p><p class="dialog-note">Game artwork © Valve. Assets delivered by <a href="https://deadlock-api.com" target="_blank" rel="noopener noreferrer">Deadlock API</a>. Unaffiliated fan project. Results stay in this browser.</p></div>`));
$('#stats-button').addEventListener('click', () => {
  const scores = getHistory();
  showDialog('Your bigger picture.', `<div class="dialog-body"><div class="stats-grid"><div><strong>${scores.length}</strong><span>Sets played</span></div><div><strong>${scores.length ? `${fmt(scores.reduce((a, r) => a + r.score, 0) / scores.length)}<small>/10</small>` : '—'}</strong><span>Average</span></div><div><strong>${scores.length ? `${Math.max(...scores.map(r => r.score))}<small>/10</small>` : '—'}</strong><span>Best</span></div></div><p class="dialog-note">Practice and daily results on this browser. Replays of the same set count once.</p></div>`);
});

function teamPanel(scenario, team) {
  // The tracked hero always leads its roster, so it never falls below the fold.
  const players = scenario.players.filter(p => p.team === team).sort((a, b) => (b.id === scenario.you) - (a.id === scenario.you));
  const isYours = scenario.players.find(p => p.id === scenario.you).team === team;
  return `<aside class="team-panel ${team}-panel ${isYours ? 'your-panel' : 'enemy-panel'}" aria-label="${isYours ? 'Your' : 'Enemy'} team"><div class="team-heading"><div class="team-name ${team}"><span class="team-dot"></span>${isYours ? 'Your team' : 'Enemy team'}</div><span class="team-total" title="Team net worth">${players.every(p => Number.isFinite(p.souls)) ? souls(players.reduce((a, p) => a + p.souls, 0)) : '?'}</span></div>${players.map(p => playerCard(p, scenario)).join('')}</aside>`;
}
function playerHealth(p) {
  if (p.alive === false) return '';
  const hp = Number.isFinite(p.health) ? clamp(p.health) : null;
  const state = hp === null ? 'unknown' : hp > 60 ? 'healthy' : hp >= 30 ? 'hurt' : 'critical';
  return `<div class="player-health-row"><div class="player-health ${state}" role="img" aria-label="${hp === null ? 'Health unknown' : `${Math.round(hp)}% health`}" title="${hp === null ? 'Health unknown' : `${Math.round(hp)}% HP`}">${hp === null ? '' : `<span class="player-health-fill" style="width:${hp}%"></span>`}</div><span class="player-health-value" aria-hidden="true">${hp === null ? '?' : `${Math.round(hp)}%`}</span></div>`;
}
function soulDifference(scenario, you) {
  const ours = scenario.players.filter(p => p.team === you.team);
  const theirs = scenario.players.filter(p => p.team !== you.team);
  const known = scenario.players.every(p => Number.isFinite(p.souls));
  const difference = known ? ours.reduce((sum,p)=>sum+p.souls,0)-theirs.reduce((sum,p)=>sum+p.souls,0) : null;
  const label = difference === null ? 'Team soul difference unknown' : difference === 0 ? 'Teams are equal in souls' : `Your team is ${difference > 0 ? 'ahead' : 'behind'} by ${Math.abs(difference).toLocaleString('en-GB')} souls`;
  return `<span class="soul-difference ${difference > 0 ? 'ahead' : difference < 0 ? 'behind' : 'even'}" title="${escape(label)}" role="img" aria-label="${escape(label)}">${gameIcon('souls')}<strong>${difference === null ? '?' : `${difference > 0 ? '+' : difference < 0 ? '−' : ''}${souls(Math.abs(difference))}`}</strong></span>`;
}
function playerCard(p, scenario) {
  p = presentPlayer(p, scenario.players.find(player => player.id === scenario.you));
  const hero = heroData(p);
  const inventory = p.items || [];
  const slots = Number.isInteger(catalog.inventorySlots) && catalog.inventorySlots <= 24 ? Math.max(inventory.length, catalog.inventorySlots) : inventory.length;
  const effect = (p.effects || []).includes('rejuvenator') ? `<span class="hero-effect" title="Rejuvenator" aria-label="Rejuvenator">${gameIcon('rejuvenator')}</span>` : '';
  const carrier = scenario.urn?.carrier === p.id ? `<span class="hero-effect" title="Carrying the Soul Urn" aria-label="Carrying the Soul Urn">${gameIcon('urn')}</span>` : '';
  const life = p.alive === false ? `Dead, ${Number.isFinite(p.respawn) ? `respawns in ${Math.ceil(p.respawn)} seconds` : 'respawn unknown'}` : Number.isFinite(p.health) ? `${Math.round(p.health)} percent health` : 'health unknown';
  const wealth = Number.isFinite(p.souls) ? `${p.souls.toLocaleString('en-GB')} souls` : 'souls unknown';
  const ult = ultimateState(p);
  const description = `${hero.name}${p.id === scenario.you ? ', you' : ''}. ${wealth}. ${life}. Ultimate ${ult.description}. Inspect ${inventory.length} held items.`;
  return `<div role="button" tabindex="0" data-player="${escape(p.id)}" aria-label="${escape(description)}" class="player ${p.id === scenario.you ? 'you' : ''} ${p.alive === false ? 'dead' : ''}">
    <div class="player-top">
      <div class="portrait-wrap">${portrait(p)}${p.alive === false ? `<img class="roster-death-icon" src="${escape(catalog.icons?.deathSkull || 'assets/game-icons/death.svg')}" alt="" aria-hidden="true">` : ''}</div>
      <div class="hero-identity">
        <div class="hero-name">${escape(hero.name)}${p.id === scenario.you ? '<span class="you-tag">YOU</span>' : ''}${effect}${carrier}</div>
        ${p.alive === false ? `<div class="hero-subline"><span class="respawn" aria-label="${Number.isFinite(p.respawn) ? `Respawns in ${p.respawn} seconds` : 'Respawn unknown'}">${Number.isFinite(p.respawn) ? `${p.respawn}s` : 'Dead'}</span></div>` : ''}
      </div>
      <div class="hero-meta"><span class="hero-souls" title="Net worth">${souls(p.souls)}</span>${ultimateStatus(p)}</div>
    </div>
    ${playerHealth(p)}<div class="items" aria-label="${escape(hero.name)} inventory" data-count="${inventory.length}">${inventory.map(id => heldItem(id, p)).join('')}${Array.from({length: Math.max(0, slots - inventory.length)}, () => '<span class="item empty-item" aria-hidden="true"></span>').join('')}</div>
    ${p.id === scenario.you && Number.isFinite(p.unspentSouls) ? `<div class="snapshot-wallet">${gameIcon('souls')}<span>${p.unspentSouls.toLocaleString('en-GB')} unspent</span></div>` : ''}
  </div>`;
}

function objectiveName(o, scenario) {
  const phase = scenario.objectiveStates?.[o.id]?.phase;
  return phase === 'patron' ? 'Patron' : phase === 'weakened' ? 'Weakened Patron' : o.kind;
}
function staticTargets(scenario) {
  const team = youIn(scenario).team;
  const targets = mapFor(scenario).objectives.filter(o => !(scenario.objectivesDown || []).includes(o.id) && scenario.objectiveStates?.[o.id]?.active !== false).map(o => {
    const name = objectiveName(o, scenario);
    return { id: o.id, x: o.x, y: o.y, label: `${o.team === team ? 'Your' : 'Enemy'} ${name.toLowerCase()}${o.kind === 'walker' || o.kind === 'guardian' ? ` · ${screenLane(o.x, team)}` : ''} · ${healthLabel(scenario.objectiveStates?.[o.id]?.health)}` };
  });
  if (scenario.midbossAlive === true) targets.push({ id: 'midboss', x: 50, y: 50, label: 'Mid Boss' });
  targets.push(...namedCampTargets(mapFor(scenario).camps || [], team));
  targets.push(...waveTargets(scenario));
  targets.push(...teleporterTargets(mapFor(scenario), scenario));
  targets.push(...(scenario.signals || []).map(s => ({ ...s, label: s.label })));
  return targets;
}
function inspectionTargets(scenario, stage) {
  const you = scenario.players.find(p => p.id === scenario.you);
  const map = mapFor(scenario);
  const relation = team => team === you.team ? 'Your team' : 'Enemy team';
  const healthMeta = value => Number.isFinite(value) ? `${Math.round(value)}% HP` : 'HP unknown';
  const targets = [];
  for (const node of stage.querySelectorAll('[data-map-player]')) {
    const rawPlayer = scenario.players.find(p => p.id === node.dataset.mapPlayer);
    if (!rawPlayer || !rawPlayer.alive || (rawPlayer.team !== you.team && rawPlayer.visible !== true)) continue;
    const player = presentPlayer(rawPlayer, you);
    const hero = heroData(player);
    const ultimate = ultimateState(player);
    targets.push({ id:player.id, element:node, x:player.x, y:player.y, name:hero.name, image:hero.image, health:player.health,
      meta:[player.id === you.id ? 'You' : relation(player.team), healthMeta(player.health), `${souls(player.souls)} souls`, `Ult ${ultimate.description}`].join(' · ') });
  }
  for (const node of stage.querySelectorAll('[data-objective]')) {
    const objective = map.objectives.find(o => o.id === node.dataset.objective);
    if (!objective) continue;
    const kind = objectiveName(objective, scenario);
    const imageKey = {guardian:'guardianMap',walker:'walkerMap',patron:'patronMap',Patron:'patronMap','Weakened Patron':'patronStage2',shrine:'guardianMap'}[kind];
    const health = scenario.objectiveStates?.[objective.id]?.health;
    targets.push({id:objective.id,named:true,element:node,x:objective.x,y:objective.y,name:kind.charAt(0).toUpperCase()+kind.slice(1),image:catalog.icons?.[imageKey],health,meta:`${relation(objective.team)} · ${healthMeta(health)}`});
  }
  for (const node of stage.querySelectorAll('[data-camp]')) {
    const camp = (map.camps || []).find(c => c.id === node.dataset.camp);
    if (!camp) continue;
    const state = scenario.campStates?.[camp.id];
    targets.push({id:camp.id,named:true,element:node,x:camp.x,y:camp.y,name:camp.label,image:camp.icon || catalog.campIcons?.[camp.kind],meta:state?.alive === true ? 'Available' : 'Status unknown'});
  }
  const boss = stage.querySelector('[data-map-boss]');
  if (boss) targets.push({id:'midboss',named:true,element:boss,x:50,y:50,name:'Mid Boss',image:catalog.icons?.midboss,meta:'Available'});
  for (const node of stage.querySelectorAll('[data-map-poi]')) {
    const poi = (map.pois || []).find(p => p.id === node.dataset.mapPoi);
    const teleporter = teleporterTargets(map, scenario).find(target => target.id === poi?.id);
    if (poi) targets.push({id:poi.id,named:true,element:node,x:poi.x,y:poi.y,name:teleporter?.name || poi.label || poi.kind,image:poi.icon,meta:teleporter?.status || (poi.team ? relation(poi.team) : '')});
  }
  return targets.filter(t => Number.isFinite(t.x) && Number.isFinite(t.y));
}
function inspectionHTML(target) {
  const hp = Number.isFinite(target.health) ? clamp(target.health) : null;
  const state = hp === null ? '' : hp > 60 ? 'healthy' : hp >= 30 ? 'hurt' : 'critical';
  return `<div class="map-inspect-row">${target.image ? `<img class="map-inspect-image" src="${escape(target.image)}" alt="">` : ''}<div class="map-inspect-copy"><strong class="map-inspect-name">${escape(target.name)}</strong><span class="map-inspect-meta">${escape(target.meta)}</span>${hp === null ? '' : `<div class="map-inspect-health ${state}" aria-hidden="true"><span style="width:${hp}%"></span></div>`}</div></div>`;
}
function attachMapInspection(map, scenario) {
  const stage = map.closest('.native-map-stage');
  const card = $('#map-inspect-card', stage);
  const announcement = $('#map-inspect-status', stage);
  const targets = inspectionTargets(scenario, stage);
  let timer = null, press = null, suppressClick = false, suppressContextUntil = 0, heldOpen = false, disposed = false;
  const listeners = [];
  const listen = (element, name, callback, options) => {
    element.addEventListener(name, callback, options);
    listeners.push(() => element.removeEventListener(name, callback, options));
  };
  const cancelPress = () => { clearTimeout(timer); timer = null; press = null; };
  const dismiss = () => {
    heldOpen = false; card.hidden = true; card.setAttribute('aria-hidden', 'true');
    announcement.textContent = ''; map.removeAttribute('aria-describedby');
  };
  const pointFromEvent = event => {
    const rect = map.getBoundingClientRect();
    return viewPoint({x:(event.clientX-rect.left)/rect.width*100,y:(event.clientY-rect.top)/rect.height*100}, scenario);
  };
  const nearest = point => {
    const rect = map.getBoundingClientRect();
    const screen = viewPoint(point, scenario);
    const clientX = rect.left + screen.x / 100 * rect.width;
    const clientY = rect.top + screen.y / 100 * rect.height;
    let target = null, distance = Infinity;
    for (const candidate of targets) {
      const d = Math.hypot(candidate.x-point.x,candidate.y-point.y);
      // Keep hit areas aligned after responsive resizing. Center distance wins
      // when sprite bounds overlap, so a large objective cannot outrank a
      // nearer hero merely because its PNG has transparent padding.
      const bounds = candidate.element.getBoundingClientRect();
      const inside = bounds.width > 0 && bounds.height > 0 && clientX >= bounds.left && clientX <= bounds.right && clientY >= bounds.top && clientY <= bounds.bottom;
      if ((d < 3 || inside) && d < distance) { target = candidate; distance = d; }
    }
    return target;
  };
  const anchor = target => {
    // Anchor beside the marker, flipping below when the top edge has no room.
    const stageRect = stage.getBoundingClientRect(), mark = target.element.getBoundingClientRect();
    const x = mark.left + mark.width / 2 - stageRect.left, top = mark.top - stageRect.top, bottom = mark.bottom - stageRect.top;
    const half = card.offsetWidth / 2, gap = 8;
    card.style.left = `${Math.max(half + 4, Math.min(stageRect.width - half - 4, x))}px`;
    const above = top - card.offsetHeight - gap >= 0;
    card.style.top = `${above ? top - card.offsetHeight - gap : Math.min(stageRect.height - card.offsetHeight, bottom + gap)}px`;
  };
  const show = (target, explicit = false) => {
    if (disposed || !map.isConnected) return;
    if (!target) { dismiss(); return; }
    // Heroes stacked in a fight are listed together instead of hiding under the top token.
    const group = target.named ? [target] : [target, ...targets.filter(t => !t.named && t !== target && Math.hypot(t.x-target.x,t.y-target.y) < 4)];
    card.innerHTML = group.map(inspectionHTML).join(''); card.hidden = false;
    card.classList.toggle('stack', group.length > 1);
    anchor(target);
    card.setAttribute('aria-hidden', explicit ? 'false' : 'true');
    if (explicit) {
      announcement.textContent = group.map(t => `${t.name}. ${t.meta}`).join(' ');
      map.setAttribute('aria-describedby', 'map-inspect-card');
    } else { announcement.textContent = ''; map.removeAttribute('aria-describedby'); }
  };
  const inspect = (point, explicit = true) => { heldOpen = false; show(nearest(point), explicit); };
  const inspectTarget = id => { heldOpen = false; show(targets.find(target => target.named === true && target.id === id), true); };
  listen(map, 'pointerdown', event => {
    if (event.isPrimary === false) { cancelPress(); return; }
    cancelPress(); suppressClick = false; suppressContextUntil = 0; dismiss();
    if (!['touch','pen'].includes(event.pointerType) || event.button !== 0) return;
    const target = nearest(pointFromEvent(event));
    if (!target) return;
    press = {pointerId:event.pointerId,x:event.clientX,y:event.clientY};
    timer = setTimeout(() => {
      if (!press || disposed || !map.isConnected) return;
      timer = null; suppressClick = true; suppressContextUntil = Date.now()+1500;
      show(target, true); heldOpen = true;
    }, 450);
  });
  listen(map, 'pointermove', event => {
    if (press && event.pointerId === press.pointerId && Math.hypot(event.clientX-press.x,event.clientY-press.y) > 8) cancelPress();
    if (event.pointerType === 'touch' || event.pointerType === 'pen' || heldOpen) return;
    show(nearest(pointFromEvent(event)));
  });
  listen(map, 'pointerup', cancelPress);
  listen(map, 'pointercancel', cancelPress);
  listen(map, 'pointerleave', () => { cancelPress(); if (!heldOpen) dismiss(); });
  listen(map, 'contextmenu', event => { if (Date.now() < suppressContextUntil) event.preventDefault(); });
  // Only keyboard focus inspects the pin; a tap focuses the map too and must not pin a card open.
  listen(map, 'focus', () => { if (selected && map.matches(':focus-visible')) inspect(selected); });
  listen(map, 'blur', () => { cancelPress(); if (!heldOpen) dismiss(); });
  listen(document, 'pointerdown', event => { if (!stage.contains(event.target)) { cancelPress(); dismiss(); } });
  listen(document, 'keydown', event => { if (event.key === 'Escape') { cancelPress(); dismiss(); } });
  const dispose = () => {
    disposed = true; cancelPress(); listeners.forEach(remove => remove());
  };
  return {inspect,inspectTarget,dismiss,dispose,consumeClick(event) {
    cancelPress();
    if (!suppressClick) return false;
    suppressClick = false; event.preventDefault(); event.stopPropagation(); return true;
  }};
}
function nativeTintFilters() {
  const colors = {enemy:'#DC4C2F',friendly:'#FFEFD7',yellow:'#FFDF40',blue:'#2EC7E6',green:'#6BB247'};
  return `<svg class="native-filters" width="0" height="0" aria-hidden="true"><defs>${Object.entries(colors).map(([name,color]) => {
    const [r,g,b] = [1,3,5].map(i => parseInt(color.slice(i,i+2),16)/255);
    return `<filter id="native-${name}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${r} 0 0 0 0 0 ${g} 0 0 0 0 0 ${b} 0 0 0 0 0 1 0"/></filter>`;
  }).join('')}</defs></svg>`;
}
function nativeObjective(o, scenario, you) {
  const state = scenario.objectiveStates?.[o.id];
  if ((scenario.objectivesDown || []).includes(o.id) || state?.active === false) return '';
  const kind = state?.phase === 'patron' ? 'patron' : state?.phase === 'weakened' ? 'weakened' : o.kind;
  const keys = {guardian:['guardianMap','guardianHealth'],walker:['walkerMap','walkerHealth'],patron:['patronMap','patronHealth'],weakened:['patronStage2','patronStage2Health'],shrine:['guardianMap','guardianHealth']};
  const [base,fill] = keys[kind] || keys.guardian;
  const value = scenario.objectiveStates?.[o.id]?.health;
  const health = Number.isFinite(value) ? value : null;
  // Valve's textures include transparent margins. Clip the visible artwork,
  // not the full canvas, so low HP still leaves a proportional visible fill.
  // Bounds are the alpha extents of the pinned official health-fill PNGs.
  const [top, bottom, size] = kind === 'patron' ? [17,63,128] : kind === 'weakened' ? [49,80,128] : kind === 'walker' ? [36,92,128] : [18,46,64];
  const cut = health === null ? null : (bottom - (bottom-top)*health/100)/size*100;
  const laneColor = o.x < 34 ? 'yellow' : o.x > 65 ? 'green' : 'blue';
  const tint = o.team !== you.team ? 'enemy' : (kind === 'patron' || kind === 'weakened' || kind === 'shrine') ? 'friendly' : laneColor;
  const rotation = kind === 'patron' && o.team === you.team ? 'rotate(180deg)' : 'none';
  return `<div class="map-marker native-objective ${escape(kind === 'weakened' ? 'patron' : kind)}" style="left:${o.x}%;top:${o.y}%;--native-tint:url(#native-${tint});--objective-rotation:${rotation}" title="${escape(kind)} · ${healthLabel(health)}" aria-label="${escape(kind)}, ${healthLabel(health)}" data-objective="${escape(o.id)}" data-health="${health === null ? 'unknown' : health}">${gameIcon(base,'native-health-bg')}${health === null ? '' : `<span class="native-health-clip" style="clip-path:inset(${cut}% 0 0 0)">${gameIcon(fill,'native-health-fill')}</span>`}</div>`;
}
function waveTargets(scenario) {
  return (scenario.laneStates || []).flatMap(lane => lane.waves.map(wave => ({...wave,label:`${lane.label} · ${wave.count} ${wave.team} troopers`,kind:'wave'})));
}
function nativeWaves(scenario, you) {
  if (Array.isArray(scenario.minimapTroopers)) return `<div class="raw-trooper-feed" aria-hidden="true">${scenario.minimapTroopers.map(t => `<div class="native-trooper ${t.team === you.team ? 'friend' : 'enemy'}" style="left:${t.x}%;top:${t.y}%" data-wave="${escape(t.id)}" title="${t.team === you.team ? 'Friendly' : 'Enemy'} trooper">${gameIcon(t.team === you.team ? 'waveFriendly' : 'wave')}</div>`).join('')}</div>`;
  return (scenario.laneStates || []).map(lane => lane.waves.map(wave => {
    // The snapshot pack is frozen at its recorded anchor and bearing. Each dot
    // uses Valve's actual trooper texture; counts are never inferred from heroes.
    const radians = wave.heading * Math.PI / 180;
    return Array.from({length:wave.count},(_,i) => {
      const row = Math.floor(i/2), side = wave.count === 1 ? 0 : i%2 === 0 ? -.48 : .48;
      const along = -row*.85;
      const x = clamp(wave.x + Math.sin(radians)*along + Math.cos(radians)*side);
      const y = clamp(wave.y - Math.cos(radians)*along + Math.sin(radians)*side);
      return `<div class="native-trooper ${wave.team === you.team ? 'friend' : 'enemy'}" style="left:${x}%;top:${y}%" data-wave="${escape(wave.id)}" title="${escape(lane.label)} · ${wave.count} troopers">${gameIcon(wave.team === you.team ? 'waveFriendly' : 'wave')}</div>`;
    }).join('');
  }).join('')).join('');
}
function nativeMapStage(scenario, result) {
  const map = mapFor(scenario);
  const frame = map.frame || (map.clientVersion === catalog.map.clientVersion ? catalog.map.frame : null);
  const mask = map.frameMask || (map.clientVersion === catalog.map.clientVersion ? catalog.map.frameMask : null);
  return `<div class="native-map-stage ${isMapInverted(youIn(scenario).team) ? 'inverted' : ''}">${frame ? `<img class="native-compass-frame" src="${escape(frame)}" alt="" draggable="false">` : ''}<div class="native-map-mask" ${mask ? `style="mask-image:url('${escape(mask)}');-webkit-mask-image:url('${escape(mask)}')"` : ''}><div class="map-viewport native-map-plane" id="map-viewport">${mapContent(scenario,result)}</div></div>${deadHeroStrip(scenario,catalog)}<div class="map-inspect-card" id="map-inspect-card" hidden aria-hidden="true"></div><span class="visually-hidden" id="map-inspect-status" role="status" aria-live="polite" aria-atomic="true"></span></div>`;
}
function mapContent(scenario, result) {
  const you = scenario.players.find(p => p.id === scenario.you);
  const map = mapFor(scenario);
  const paths = `<defs><clipPath id="native-north"><rect x="0" y="0" width="100" height="50"/></clipPath><clipPath id="native-south"><rect x="0" y="50" width="100" height="50"/></clipPath></defs>` + map.lanes.map(l => {
    const points = l.points.map(p => p.join(',')).join(' ');
    const curve = Array.isArray(l.segments) && l.segments.length ? `M ${l.segments[0].start.join(' ')} ` + l.segments.map(p => `C ${p.c1.join(' ')} ${p.c2.join(' ')} ${p.end.join(' ')}`).join(' ') : null;
    const geometry = curve ? `path d="${curve}"` : `polyline points="${points}"`;
    const friendSide = you.team === 'amber' ? 'south' : 'north';
    const enemySide = you.team === 'amber' ? 'north' : 'south';
    return `<${geometry} fill="none" stroke="${escape(l.color)}" stroke-width=".4" stroke-linecap="round" stroke-linejoin="round" clip-path="url(#native-${friendSide})"/><${geometry} fill="none" stroke="#DC4C2F" stroke-width=".4" stroke-linecap="round" stroke-linejoin="round" clip-path="url(#native-${enemySide})"/>`;
  }).join('');
  // The reveal shows what counted: a thick band along the route from T+15 to T+60, drawn with
  // the answer radius as its pen, after a thin unscored opening. Scoring itself stays binary.
  const zone = scenario.answerZones[0];
  const sections = result ? recordedRouteSections(scenario) : {early: [], scored: []};
  const line = points => points.length > 1 ? 'M ' + points.map(p => p.x + ' ' + p.y).join(' L ') : '';
  const hasRoute = sections.scored.length > 0;
  const band = hasRoute ? sections.scored.map(points => points.length > 1 ? '<path class="route-band ' + (result.score === 1 ? 'hit' : '') + '" d="' + line(points) + '" stroke-width="' + zone.radius * 2 + '"/>' : '<circle class="route-band-dot ' + (result.score === 1 ? 'hit' : '') + '" cx="' + points[0].x + '" cy="' + points[0].y + '" r="' + zone.radius + '"/>').join('') : '';
  const nearest = result && result.score !== 1 ? hasRoute ? nearestScoredRoutePoint(scenario, result.point) : zone : null;
  const gap = nearest ? '<line class="miss-gap" x1="' + result.point.x + '" y1="' + result.point.y + '" x2="' + nearest.x + '" y2="' + nearest.y + '"/>' : '';
  const zones = result ? gap + scenario.answerZones.map(z => (hasRoute ? '' : '<circle class="answer-region ' + (result.score === 1 ? 'hit' : '') + '" cx="' + z.x + '" cy="' + z.y + '" r="' + z.radius + '"/>') + '<circle class="recorded-destination-halo" cx="' + z.x + '" cy="' + z.y + '" r="1.7"/><circle class="recorded-destination-dot" cx="' + z.x + '" cy="' + z.y + '" r=".7"/>').join('') : '';
  const early = sections.early.map(line).filter(Boolean).map(d => '<path class="recorded-route-early" d="' + d + '"/>').join('');
  const scored = sections.scored.map(line).filter(Boolean).join(' ');
  const route = hasRoute || early ? band + early + (scored ? '<path class="recorded-route-casing" d="' + scored + '"/><path class="recorded-route" d="' + scored + '" pathLength="1"/>' : '') : !scenario.recordedMove && result && you.x != null ? '<line x1="' + you.x + '" y1="' + you.y + '" x2="' + result.point.x + '" y2="' + result.point.y + '" stroke="#e9e5da" stroke-width=".3" stroke-opacity=".65" stroke-dasharray=".8 1"/>' : '';
  const objectives = map.objectives.map(o => nativeObjective(o,scenario,you)).join('');
  const camps = (map.camps || []).map(c => {
    const state = scenario.campStates?.[c.id];
    // Replay HUD visibility is independent of a camp's unknown life state.
    // Authored imports without a visibility field retain their alive-state display.
    if (state?.visibleOnMap === false || (state?.visibleOnMap === undefined && state?.alive === false)) return '';
    const known = state?.visibleOnMap === true || state?.alive === true;
    const image = c.icon || catalog.campIcons?.[c.kind];
    return `<div class="map-camp native-camp ${escape(c.kind)} ${known ? '' : 'unknown'}" data-camp="${escape(c.id)}" style="left:${c.x}%;top:${c.y}%" title="${escape(c.label)}${known ? '' : ' · unknown'}">${image ? `<img src="${escape(image)}" alt="${escape(c.label)}" draggable="false">` : ''}</div>`;
  }).join('');
  const activePois = new Set(Array.isArray(scenario.activePois) ? scenario.activePois : []);
  const teleporters = teleporterTargets(map, scenario);
  const pois = (map.pois || []).filter(p => p.kind === 'teleporter' || (p.kind === 'shop' ? (!p.team || p.team === you.team) : activePois.has(p.id))).map(p => {
    const teleporter = teleporters.find(target => target.id === p.id);
    const label = teleporter?.label || p.label || p.kind;
    return `<div class="map-poi native-poi ${escape(p.kind)} ${teleporter?.state || ''}" data-map-poi="${escape(p.id)}" style="left:${p.x}%;top:${p.y}%" title="${escape(label)}">${p.icon ? `<img src="${escape(p.icon)}" alt="${escape(label)}" draggable="false">` : ''}</div>`;
  }).join('');
  const boss = scenario.midbossAlive === true ? `<div class="map-marker native-midboss" data-map-boss="midboss" style="left:50%;top:50%" title="Mid Boss">${gameIcon('midboss')}</div>` : '';
  const markers = scenario.players.filter(p => p.alive && p.x != null && p.y != null && (p.team === you.team || p.visible === true)).map(p => {
    const hero = heroData(p);
    const local = p.id === scenario.you;
    const image = local ? catalog.icons.playerSelf : hero.minimapImage;
    return `<div class="map-hero native-player ${p.team !== you.team ? 'enemy' : 'friend'} ${local ? 'is-you' : ''}" data-map-player="${escape(p.id)}" style="left:${p.x}%;top:${p.y}%" title="${escape(hero.name)}" aria-label="${escape(hero.name)}${local ? ', you' : ''}">${image ? `<img class="native-player-image" src="${escape(image)}" alt="" draggable="false">` : ''}${local ? gameIcon('playerSelfHighlight','native-self-highlight') : ''}</div>`;
  }).join('');
  const signals = (scenario.signals || []).filter(p => p.kind !== 'camp' && p.kind !== 'wave').map(p => `<div class="map-signal native-signal ${escape(p.kind)} ${p.team !== you.team ? 'enemy' : ''}" style="left:${p.x}%;top:${p.y}%" title="${escape(p.label)}">${gameIcon(p.kind === 'fight' ? 'attack' : p.kind)}</div>`).join('');
  const point = result?.point || selected;
  const pinState = result ? result.score === 1 ? 'locked hit' : 'locked miss' : '';
  const layer = scenario.mapLayer === 'tunnels' ? 'tunnels' : scenario.mapLayer === 'ratTunnels' ? 'ratTunnels' : 'surface';
  const image = map.layers?.[layer] || map.image;
  return `${nativeTintFilters()}<img class="map-image native-surface" src="${escape(image)}" alt="Deadlock minimap" draggable="false" width="1024" height="1024"><svg class="map-overlay native-lines" viewBox="0 0 100 100" aria-hidden="true">${paths}</svg>${pois}${camps}${nativeWaves(scenario,you)}${objectives}${boss}${signals}${markers}<svg class="map-overlay answer-overlay" viewBox="0 0 100 100" aria-hidden="true">${route}${zones}</svg><button class="map-input ${result ? 'locked' : ''}" id="map-input" aria-label="${result ? 'Your choice and scored answer regions' : 'Choose your next destination on the minimap. Click, or use arrow keys and Enter.'}" ${result ? 'tabindex="-1"' : ''}></button><div class="target-pin ${pinState}" id="target-pin" style="${point ? `left:${point.x}%;top:${point.y}%` : 'display:none'}">${gameIcon('ping')}<span class="selection-center"></span></div>`;
}

function renderRound({reveal = false} = {}) {
  disposeMapInspection();
  const s = challenge.scenarios[index];
  const you = s.players.find(p => p.id === s.you);
  const result = results[index];
  const yours = s.players.filter(p => p.team === you.team && p.alive).length;
  const theirs = s.players.filter(p => p.team !== you.team && p.alive).length;
  const recorded = s.source?.kind === 'match';
  const dailyDate = new Date(`${challenge.date || today}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  $('#source-label').textContent = mode === 'daily' ? `Ranked · ${dailyDate}` : 'Authored practice';
  if (recorded) $('#source-label').textContent = `${s.source.playerName || 'Match'} · ${s.source.matchId}`;
  if (recorded && (result || review) && /^[1-9]\d*$/.test(s.source.matchId)) {
    const link = document.createElement('a');
    link.href = `https://statlocker.gg/match/${s.source.matchId}`;
    link.textContent = `${s.source.playerName || 'Match'} · ${s.source.matchId}`;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    $('#source-label').replaceChildren(link);
  }
  const targetSecond = recordedTargetSecond(s);
  const matchClock = `<span class="match-clock" role="img" aria-label="Match time ${clock(s.time)}${targetSecond === null ? '' : `, scored route from ${clock(s.time + ROUTE_SCORING_START)} to ${clock(targetSecond)}`}">${clock(s.time)}${targetSecond === null ? '' : `<span class="target-clock" aria-hidden="true"> &rarr; ${clock(s.time + ROUTE_SCORING_START)}–${clock(targetSecond)}</span>`}</span>`;
  const heading = result ? result.score === 1 ? 'Matched.' : 'Different move.' : 'Where will you go next?';
  app.innerHTML = `<section class="intro"><span class="round-counter" aria-label="Round ${index + 1} of 10">${String(index + 1).padStart(2, '0')}<span>/10</span></span><h1 id="round-title" tabindex="-1">${heading}</h1><div class="round-progress" role="img" aria-label="Round ${index + 1} of 10; ${calculateTotal(results)} recorded move${calculateTotal(results) === 1 ? '' : 's'} matched">${challenge.scenarios.map((_, i) => `<span class="progress-pip ${i === index ? 'current ' : ''}${results[i] ? `done ${results[i].score === 1 ? 'correct' : 'wrong'}` : ''}" aria-hidden="true">${results[i] ? outcomeMark(results[i].score) : ''}</span>`).join('')}</div></section>
  <section class="play-table ${reveal ? 'is-revealing' : ''}" style="--ally:#ffefd7;--enemy:#ef9886">${teamPanel(s, you.team)}<div class="map-column"><div class="map-frame ${result ? 'has-result' : ''}"><div class="match-bar"><button class="match-perspective" id="locate-you" aria-label="Locate ${escape(heroData(you).name)}, you, on the map">${portrait(you, 'mini-portrait')}<span><span class="perspective-label">You are</span><strong>${escape(heroData(you).name)}</strong></span></button><div class="match-state">${matchClock}</div><div class="match-economy">${soulDifference(s,you)}<div class="alive-summary" role="img" aria-label="${yours} allies alive, ${theirs} enemies alive"><span class="alive-ally">${yours}</span><span class="alive-divider">v</span><span class="alive-enemy">${theirs}</span><span class="alive-word">alive</span></div></div></div>${lobbyGlance(s, you)}${nativeMapStage(s, result)}</div><div id="decision-area" aria-live="polite">${result ? feedbackHTML(s, result) : decisionHTML()}</div>${result ? '' : `<details class="accessible-targets"><summary>Choose a location</summary><div class="target-options">${staticTargets(s).map(t => `<button data-target="${escape(t.id)}">${escape(t.label)}</button>`).join('')}</div></details>`}${review ? `<div class="review-nav"><button id="prev-review" ${index === 0 ? 'disabled' : ''}>&larr; Previous</button><span>${index + 1} / 10</span><button id="next-review" ${index === 9 ? 'disabled' : ''}>Next &rarr;</button><button class="back-results" id="back-results">Results</button></div>` : ''}${!storageAvailable ? '<p class="storage-warning">Browser storage is unavailable. This run will not survive a refresh.</p>' : ''}</div>${teamPanel(s, you.team === 'amber' ? 'sapphire' : 'amber')}</section>`;
  attachRound();
}
function decisionHTML() {
  return `<div class="decision-row ${selected ? 'has-choice' : ''}"><div class="selection-caption" id="selection-caption">${selected ? `<span class="selection-icon" aria-hidden="true">${gameIcon('ping')}</span><strong>${escape(locationName(selected))}</strong>` : ''}</div><button class="primary" id="lock-button" ${selected ? '' : 'disabled'}>Lock in<span class="button-arrow">↗</span></button></div>`;
}
function feedbackHTML(s, result) {
  const best = result.bestZone;
  const answerSecond = s.source?.roundEvidence?.answerSampleSecond ?? s.recordedMove?.toSecond;
  const recorded = s.source?.kind === 'match' && Number.isFinite(answerSecond) && answerSecond >= s.time;
  const zone = s.answerZones[0];
  // Name where the tracked hero actually ended up; the generic replay sentence added nothing.
  const title = recorded ? `${clock(answerSecond)} · ${zone ? locationName(zone) : best.label}` : best.label;
  const explanation = recorded ? '' : result.score > 0 && result.explanation ? result.explanation : best.explanation;
  return `<div class="feedback ${result.score === 1 ? 'matched' : 'different'}"><div class="feedback-copy"><span class="feedback-score ${result.score === 0 ? 'low' : ''}" data-score="${result.score}">${result.score === 1 ? '<span class="plus" aria-hidden="true">+</span>' : ''}${result.score}<span class="visually-hidden"> point${result.score === 1 ? '' : 's'}</span></span><span class="feedback-title"><span class="feedback-kicker">${recorded ? 'Recorded move' : 'Answer'}</span><span class="feedback-place">${escape(title)}</span></span>${explanation ? `<details class="replay-details"><summary>Answer details</summary><p class="feedback-explanation">${escape(explanation)}</p></details>` : ''}</div>${!review ? `<button class="primary" id="next-button">${index === 9 ? 'See score' : 'Next'}<span class="button-arrow">&rarr;</span></button>` : ''}</div>`;
}
function locationName(point) {
  const s = challenge.scenarios[index];
  let nearest = null;
  for (const t of staticTargets(s)) {
    const d = Math.hypot(t.x - point.x, t.y - point.y);
    if (d < 7 && (!nearest || d < nearest.distance)) nearest = { ...t, distance: d };
  }
  if (nearest) return nearest.label.replace(/ · (\d+% HP|HP unknown)$/, '');
  const you = youIn(s);
  const lane = screenLane(point.x, you.team);
  const x = lane.charAt(0).toUpperCase() + lane.slice(1);
  const yourSide = you.team === 'amber' ? point.y > 65 : point.y < 35;
  if (point.y > 88 || point.y < 12) return yourSide ? 'Your base' : 'Enemy base';
  const y = point.y > 65 || point.y < 35 ? yourSide ? 'your side' : 'enemy side' : 'river';
  return `${x} · ${y}`;
}
function place(point, announce = true) {
  if (results[index] || review || finished) return;
  selected = { x: clamp(point.x), y: clamp(point.y) };
  const pin = $('#target-pin');
  pin.style.display = 'block'; pin.style.left = `${selected.x}%`; pin.style.top = `${selected.y}%`;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    pin.getAnimations().forEach(animation => animation.cancel());
    pin.animate([{opacity:.55, scale:'.85'}, {opacity:1, scale:'1'}], {duration:150, easing:'cubic-bezier(0.2, 0, 0, 1)'});
  }
  $('#decision-area').innerHTML = decisionHTML();
  $('#lock-button').addEventListener('click', lock);
  if (announce) $('#map-input').setAttribute('aria-label', `${locationName(selected)} selected. Arrow keys move the pin. Enter locks your choice.`);
  void mutateRun({type:'pin', index, scenarioId:challenge.scenarios[index].id, point:{...selected}});
}
function attachRound() {
  const map = $('#map-input');
  const scenario = challenge.scenarios[index];
  const you = youIn(scenario);
  $('#locate-you').addEventListener('click', () => {
    const marker = $('.native-player.is-you');
    if (marker) {
      // A visible ring, not a faint opacity blink; reduced motion keeps a static highlight.
      marker.classList.remove('locating'); void marker.offsetWidth; marker.classList.add('locating');
      setTimeout(() => marker.classList.remove('locating'), 1400);
    }
    map.focus({preventScroll:true});
  });
  const inspection = attachMapInspection(map, scenario);
  disposeMapInspection = inspection.dispose;
  map.addEventListener('click', e => {
    if (inspection.consumeClick(e)) return;
    inspection.dismiss();
    if (results[index] || review) return;
    const rect = map.getBoundingClientRect();
    place(viewPoint({ x: (e.clientX - rect.left) / rect.width * 100, y: (e.clientY - rect.top) / rect.height * 100 }, scenario));
  });
  map.addEventListener('keydown', e => {
    if (results[index] || review) return;
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
      e.preventDefault();
      // Keyboard pins start on your own hero; arrows move in screen directions on an inverted map.
      const p = selected || (Number.isFinite(you.x) && Number.isFinite(you.y) ? {x:you.x, y:you.y} : { x: 50, y: 75 });
      const step = (e.shiftKey ? 5 : 1) * (isMapInverted(you.team) ? -1 : 1);
      place({ x: p.x + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0), y: p.y + (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0) });
      inspection.inspect(selected);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); if (selected) lock(); else { place(Number.isFinite(you.x) && Number.isFinite(you.y) ? {x:you.x, y:you.y} : { x: 50, y: 50 }); inspection.inspect(selected); }
    }
  });
  $('#lock-button')?.addEventListener('click', lock);
  $('#next-button')?.addEventListener('click', next);
  $('#prev-review')?.addEventListener('click', () => { index--; renderRound(); focusContent('#prev-review'); });
  $('#next-review')?.addEventListener('click', () => { index++; renderRound(); focusContent('#next-review'); });
  $('#back-results')?.addEventListener('click', renderResults);
  $('.target-options')?.addEventListener('click', e => {
    const button = e.target.closest('[data-target]'); if (!button) return;
    const t = staticTargets(challenge.scenarios[index]).find(t => t.id === button.dataset.target);
    if (t) { place(t); inspection.inspectTarget(t.id); $('#lock-button')?.focus(); }
  });
}
function lock() {
  if (!selected || results[index] || review || finished) return;
  void mutateRun({type:'lock', index, scenarioId:challenge.scenarios[index].id, point:{...selected}});
}
function next() {
  if (!results[index] || review) return;
  void mutateRun({type:'next', index, scenarioId:challenge.scenarios[index].id});
}
function scrollTop() { window.scrollTo({ top: 0, behavior: 'instant' }); }
function focusContent(selector = 'h1') {
  const requested = $(selector, app);
  const target = requested && !requested.disabled ? requested : $('h1', app) || app;
  if (!target.matches('button, a, input, textarea, select, [tabindex]')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}
function recordCompletion() {
  if (results.length !== 10) return;
  const history = getHistory();
  const id = `${mode}:${challenge.id}:${challenge.date || 'v1'}`;
  const existing = history.find(r => r.id === id);
  if (!existing) history.push({ id, mode, date: today, score: calculateTotal(results) });
  else if (mode === 'practice') existing.score = Math.max(existing.score, calculateTotal(results));
  writeStorage('macrolock:history:binary-v1', history.slice(-365));
}
function renderResults() {
  disposeMapInspection();
  review = false;
  $('#source-label').textContent = mode === 'daily' ? 'Daily results' : 'Recorded practice';
  const total = calculateTotal(results);
  app.innerHTML = `<section class="results"><h1 id="results-title" tabindex="-1">${mode === 'daily' ? 'Daily' : 'Practice'} complete</h1><div class="final-score" role="img" aria-label="${total} out of 10">${total}<span class="denominator" aria-hidden="true">/10</span></div><div class="result-grid" aria-label="Round scores">${results.map((r, i) => {
    const s = challenge.scenarios[i], player = s.players.find(p => p.id === s.you);
    return `<button class="result-tile ${r.score === 0 ? 'low' : ''}" data-review="${i}" aria-label="Review round ${i + 1}, ${escape(heroData(player).name)}, ${r.score === 1 ? 'matched' : 'different move'}, score ${r.score}, at ${clock(s.time)}"><span class="result-round">${String(i + 1).padStart(2, '0')}</span><span class="result-portrait">${portrait(player)}<span class="result-outcome">${outcomeMark(r.score)}</span></span><small>${clock(s.time)}</small></button>`;
  }).join('')}</div><div class="results-actions"><button class="primary" id="replay-button">${mode === 'daily' ? 'Play practice' : 'Keep playing'}<span class="button-arrow">&rarr;</span></button><button class="secondary" id="share-button">Share score<span class="button-arrow">&rarr;</span></button></div></section>`;
  $('#share-button').addEventListener('click', share);
  $('#replay-button').addEventListener('click', () => {
    if (mode === 'daily') return setMode('practice');
    return setMode('practice', {fresh:true});
  });
  app.querySelectorAll('[data-review]').forEach(b => b.addEventListener('click', () => { index = Number(b.dataset.review); review = true; renderRound(); scrollTop(); focusContent(); }));
  focusContent('#results-title');
}
async function share() {
  const text = serializeShare({ date: challenge.date || today, mode: mode === 'daily' ? 'Daily' : 'Practice', results });
  try { await navigator.clipboard.writeText(text); toast('Score copied.'); }
  catch {
    showDialog('Share your score.', `<div class="dialog-body">Select and copy your result.<textarea class="copy-fallback" readonly aria-label="Score to copy">${escape(text)}</textarea></div>`);
    $('.copy-fallback').focus(); $('.copy-fallback').select();
  }
}
async function loadRun() {
  const source = challenge, sourceMode = mode, sourceKey = key();
  const run = await coordinate(() => {
    const saved = readStorage(sourceKey, null);
    const restored = restoreRun(saved, source.scenarios);
    writeStorage(sourceKey, restored);
    return restored;
  });
  if (source === challenge && sourceMode === mode) applyRun(run);
}
function newSessionId() { return `practice-session-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`; }
async function preparePracticeSession(fresh = false) {
  const selection = await coordinate(() => {
    let saved = fresh ? null : currentPracticeSession();
    if (saved?.id && isCompletedRunStale(readStorage(`macrolock:run:binary-v1:practice:${saved.id}:v1`, null), new Date().toISOString().slice(0,10))) saved = null;
    const validId = typeof saved?.id === 'string' && /^practice-session-[a-zA-Z0-9-]+$/.test(saved.id);
    if (validId && (saved.kind === 'fallback' || (practiceLibrary && validatePracticeReferences(practiceLibrary, saved.references)))) return saved;
    if (saved) toast('Practice refreshed. Your previous set is unavailable.');
    const picked = practiceLibrary ? selectPracticeReferences(practiceLibrary, readStorage(practiceSeenKey, [])) : null;
    const session = picked ? {id:newSessionId(), references:picked.references} : {id:newSessionId(), kind:'fallback'};
    if (!fresh && !saved && session.kind === 'fallback') {
      const legacy = readStorage(`macrolock:run:binary-v1:practice:${practiceFallback.id}:${practiceFallback.date || 'v1'}`, null);
      if (legacy && !isCompletedRunStale(legacy, new Date().toISOString().slice(0,10))) writeStorage(`macrolock:run:binary-v1:practice:${session.id}:v1`, restoreRun(legacy, practiceFallback.scenarios));
    }
    writeStorage(practiceSessionKey, session);
    if (picked) writeStorage(practiceSeenKey, picked.seen);
    return session;
  });
  if (selection.kind === 'fallback') return {...practiceFallback, id:selection.id};
  const entries = [...new Set(selection.references.map(ref => ref.packId))].map(packId => practiceLibrary.packs.find(pack => pack.id === packId));
  try {
    await Promise.all(entries.map(async entry => {
      if (!practicePacks.has(entry.id)) practicePacks.set(entry.id, await getJSON(entry.path));
    }));
    const candidate = assemblePracticeSession(practiceLibrary, selection.references, practicePacks, selection.id);
    // Another tab may have started a fresh set while these packs were loading.
    if (currentPracticeSession()?.id !== selection.id) return preparePracticeSession();
    return candidate;
  } catch (error) {
    entries.forEach(entry => practicePacks.delete(entry.id));
    console.warn('Practice library unavailable:', error.message);
    toast('More games could not load. Showing the backup set.');
    // A backup has its own shared identity, never different scenarios under a library run ID.
    await coordinate(() => {
      if (currentPracticeSession()?.id === selection.id) writeStorage(practiceSessionKey, {id:newSessionId(),kind:'fallback'});
    });
    return preparePracticeSession();
  }
}
function loadPracticeSession(fresh = false) {
  // Switching tabs during a fetch shares one selection instead of reserving unseen rounds twice.
  if (!practiceLoading) practiceLoading = preparePracticeSession(fresh).finally(() => { practiceLoading = null; });
  return practiceLoading;
}
async function setMode(newMode, {fresh = false} = {}) {
  if (!practice) return;
  const request = ++modeRequest;
  mode = newMode;
  challenge = null;
  history.replaceState(history.state, '', modeURL(location.href, mode));
  $('#practice-tab').classList.toggle('active', mode === 'practice');
  $('#daily-tab').classList.toggle('active', mode === 'daily');
  $('#practice-tab').setAttribute('aria-current', mode === 'practice' ? 'page' : 'false');
  $('#daily-tab').setAttribute('aria-current', mode === 'daily' ? 'page' : 'false');
  if (mode === 'daily' && !daily) {
    disposeMapInspection();
    $('#source-label').textContent = 'Daily · UTC';
    app.innerHTML = `<section class="empty-state"><div class="eyebrow">${escape(today)} · Daily</div><svg class="empty-icon" viewBox="0 0 60 60" fill="none" aria-hidden="true"><path d="M16 13h28v36H16zM22 9v8m16-8v8M16 23h28" stroke="currentColor" stroke-width="1.5"/><path d="m24 35 4 4 9-10" stroke="currentColor" stroke-width="1.5"/></svg><h1>No daily yet.</h1><button class="primary" id="daily-practice">Play practice<span class="button-arrow">→</span></button></section>`;
    $('#daily-practice').addEventListener('click', () => setMode('practice')); scrollTop(); focusContent(); return;
  }
  if (mode === 'practice') {
    disposeMapInspection();
    app.innerHTML = '<div class="loading" role="status">Loading practice<span class="loading-dot">.</span></div>';
    const candidate = await loadPracticeSession(fresh);
    if (request !== modeRequest) return;
    practice = candidate;
  }
  challenge = mode === 'daily' ? daily : practice;
  await loadRun();
  if (request !== modeRequest) return;
  if (finished) renderResults(); else renderRound(); scrollTop(); focusContent();
}
$('#practice-tab').addEventListener('click', () => setMode('practice'));
$('#daily-tab').addEventListener('click', () => setMode('daily'));

let reconciliation = Promise.resolve();
window.addEventListener('storage', event => {
  if (!challenge || !storageAvailable || (event.key !== practiceSessionKey && event.key !== key())) return;
  reconciliation = reconciliation.then(async () => {
    if (mode === 'practice' && !currentSessionMatches()) {
      await setMode('practice');
      toast('Practice updated in another tab.');
      return;
    }
    const source = challenge;
    const run = await coordinate(() => restoreRun(readStorage(key(), null), source.scenarios));
    if (source !== challenge || review) return;
    const after = JSON.stringify({index:run.index,results:run.results,selected:run.selected,finished:run.finished,completedAt:run.completedAt});
    if (JSON.stringify(displayedRun()) !== after && applyRun(run)) showCurrentRun({focus:true});
  }).catch(error => { console.warn('Practice synchronization unavailable:', error.message); });
});

function inspectPlayer(id) {
  const scenario = challenge?.scenarios[index];
  const rawPlayer = scenario?.players.find(p => p.id === id);
  if (!rawPlayer) return;
  const player = presentPlayer(rawPlayer, scenario.players.find(p => p.id === scenario.you));
  const ability = heroData(player).ultimate;
  const status = ultimateState(player);
  showDialog(heroData(player).name, `<div class="snapshot-ultimate">${ability?.image ? `<img src="${escape(ability.image)}" alt="" width="40" height="40">` : ''}<div><span>Ultimate</span><strong>${escape(ability?.name || 'Unknown ability')}</strong></div><span class="snapshot-cooldown ${status.ready ? 'ready' : ''}" title="${escape(status.description)}" aria-label="Ultimate ${escape(status.description)}">${status.label}</span></div><div class="inventory-detail">${(player.items || []).map(id => {
    const item = itemData(id);
    const cooldown = player.itemCooldowns?.[id];
    const showCooldown = item.active === true || cooldown === null || Number.isFinite(cooldown);
    return `<div class="inventory-detail-row">${heldItem(id, player)}<div><strong>${escape(item.name)}</strong><span>${escape(item.type)}${item.cost ? ` · ${item.cost.toLocaleString('en-GB')} souls` : ''}</span>${showCooldown ? `<span class="detail-item-cooldown ${cooldown === 0 ? 'ready' : ''}">${Number.isFinite(cooldown) ? cooldownLabel(cooldown) : 'Cooldown unknown'}</span>` : ''}</div></div>`;
  }).join('') || '<p class="dialog-body">No held items recorded.</p>'}</div>`);
}
app.addEventListener('click', e => {
  const player = e.target.closest('[data-player]');
  if (player) inspectPlayer(player.dataset.player);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && review && !dialog.open && !e.defaultPrevented) { renderResults(); scrollTop(); }
});
app.addEventListener('keydown', e => {
  const player = e.target.closest('[data-player]');
  if (player && ['Enter', ' '].includes(e.key)) { e.preventDefault(); inspectPlayer(player.dataset.player); }
});

async function getJSON(url, optional = false) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { cache: 'no-cache', signal:controller.signal });
    if (!response.ok) { if (optional && response.status === 404) return null; throw new Error(`Could not load ${url} (${response.status})`); }
    return await response.json();
  } finally { clearTimeout(deadline); }
}
async function init() {
  try {
    [catalog, practice] = await Promise.all([getJSON('assets/catalog.json'), getJSON('practice-fallback.json')]);
    const validation = validateChallenge(practice);
    if (!validation.valid || practice.scenarios.length !== 10 || !practice.scenarios.every(isPracticeRoundEligible)) throw new Error(`Practice set is invalid or includes an opening round: ${validation.errors.join('; ')}`);
    practiceFallback = practice;
    try {
      const candidate = await getJSON('practice/index.json', true);
      if (candidate && validatePracticeLibrary(candidate).valid) practiceLibrary = candidate;
      else if (candidate) console.warn('Practice library index is invalid. Using the backup set.');
    } catch (error) { console.warn('Practice library unavailable:', error.message); }
    // The availability index avoids treating a missing daily file as a failed asset load.
    try {
      const manifest = await getJSON('daily/index.json');
      if (Array.isArray(manifest.dates) && manifest.dates.includes(today)) {
        const candidate = await getJSON(`daily/${today}.json`);
        if (candidate.kind === 'daily' && candidate.date === today && validateChallenge(candidate).valid) { daily = candidate; $('.daily-dot').hidden = false; }
      }
    } catch (error) { console.warn('Daily challenge unavailable:', error.message); }
    $('#daily-tab').hidden = !daily;
    $('.mode-nav').hidden = !daily;
    await setMode(new URLSearchParams(location.search).get('mode') === 'daily' ? 'daily' : 'practice');
  } catch (error) {
    console.error(error);
    disposeMapInspection();
    app.innerHTML = `<section class="empty-state"><h1>The map didn't load.</h1><p>Refresh to try again.</p><button class="primary" id="retry">Reload<span class="button-arrow">↻</span></button></section>`;
    $('#retry').addEventListener('click', () => location.reload());
    focusContent();
  }
}
init();
