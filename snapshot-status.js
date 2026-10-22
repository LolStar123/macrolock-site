const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => record(value) && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function localImage(value) {
  return typeof value === 'string' && value.startsWith('assets/') &&
    !value.includes('..') && !/[\\:%?#]/.test(value) ? value : null;
}

function deathIcon(catalog) {
  const icons = own(catalog, 'icons');
  const image = localImage(own(icons, 'deathSkull') || own(icons, 'skull') || own(icons, 'death') || 'assets/game-icons/death.svg');
  return image
    ? `<img class="map-death-symbol" src="${escape(image)}" alt="" aria-hidden="true">`
    : '<svg class="map-death-symbol" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m3 3 6 6M9 3l-6 6"/></svg>';
}

function portrait(player, catalog, relation) {
  const hero = own(own(catalog, 'heroes'), player.hero);
  const name = typeof own(hero, 'name') === 'string' ? hero.name : typeof player.hero === 'string' ? player.hero : 'Hero';
  const image = localImage(own(hero, 'image'));
  const known = Number.isFinite(player.respawn) && player.respawn >= 0;
  const seconds = known ? String(Math.ceil(player.respawn)) : '?';
  const label = `${name}, ${relation}, ${known ? `respawns in ${seconds} seconds` : 'respawn unknown'}`;
  return `<figure class="map-death-card" role="img" aria-label="${escape(label)}" title="${escape(label)}"><div class="map-death-portrait${image ? '' : ' is-unavailable'}">${image ? `<img class="map-death-hero" src="${escape(image)}" alt="" aria-hidden="true" draggable="false">` : ''}${deathIcon(catalog)}</div><figcaption class="map-death-timer" aria-hidden="true">${escape(seconds)}${known ? '<span>s</span>' : ''}</figcaption></figure>`;
}

/** Static snapshot respawns. Insert inside the map stage, outside its mask. */
export function deadHeroStrip(scenario, catalog) {
  if (!record(scenario) || !Array.isArray(scenario.players)) return '';
  const players = scenario.players.filter(record);
  const you = players.find(player => player.id === scenario.you);
  if (!you || !['amber', 'sapphire'].includes(you.team)) return '';
  const dead = players.filter(player => player.alive === false && ['amber', 'sapphire'].includes(player.team));
  if (!dead.length) return '';
  const allies = dead.filter(player => player.team === you.team);
  const enemies = dead.filter(player => player.team !== you.team);
  const group = (rows, side, relation) => rows.length
    ? `<div class="map-deaths-${side}" role="group" aria-label="${relation === 'ally' ? 'Allied' : 'Enemy'} respawns">${rows.map(player => portrait(player, catalog, relation)).join('')}</div>`
    : '';
  return `<div class="map-deaths">${group(allies, 'allies', 'ally')}${group(enemies, 'enemies', 'enemy')}</div>`;
}
