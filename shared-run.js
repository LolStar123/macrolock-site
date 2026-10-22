import {scoreChoice} from './engine.js';

const validPoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100;

/** Upgrade legacy runs and recompute their scores from the same immutable locked points. */
export function restoreRun(saved, scenarios, now = new Date().toISOString()) {
  const run = {version:3, revision:0, index:0, results:[], selected:null, finished:false, completedAt:null};
  if (![2, 3].includes(saved?.version) || !Array.isArray(saved.results)) return run;
  for (let i = 0; i < Math.min(scenarios.length, saved.results.length); i++) {
    const result = saved.results[i];
    if (!result || result.scenarioId !== scenarios[i].id || !validPoint(result.point)) break;
    try { run.results.push({...scoreChoice(scenarios[i], result.point), point:{...result.point}, scenarioId:result.scenarioId}); }
    catch { break; }
  }
  run.revision = Number.isSafeInteger(saved.revision) && saved.revision >= 0 ? saved.revision : 0;
  run.finished = saved.finished === true && run.results.length === scenarios.length;
  run.index = Math.max(0, Math.min(scenarios.length - 1, Number.isInteger(saved.index) ? saved.index : run.results.length, run.results.length));
  if (!run.results[run.index] && validPoint(saved.selected)) run.selected = {...saved.selected};
  if (run.finished) run.completedAt = typeof saved.completedAt === 'string' && Number.isFinite(Date.parse(saved.completedAt)) ? saved.completedAt : now;
  return run;
}

/** Called inside one origin-wide transaction. A stale event never targets a newer round. */
export function transitionRun(run, command, scenarios, now = new Date().toISOString()) {
  if (run.finished || command.index !== run.index || command.scenarioId !== scenarios[run.index]?.id) return run;
  const next = {...run, results:[...run.results]};
  if (command.type === 'pin') {
    if (run.results[run.index] || !validPoint(command.point)) return run;
    next.selected = {...command.point};
  } else if (command.type === 'lock') {
    // The first committed locked point wins, even if another tab submits a different score.
    if (run.results[run.index] || !validPoint(command.point)) return run;
    const scenario = scenarios[run.index];
    next.results.push({...scoreChoice(scenario, command.point), point:{...command.point}, scenarioId:scenario.id});
    next.selected = null;
  } else if (command.type === 'next') {
    if (!run.results[run.index]) return run;
    next.selected = null;
    if (run.index === scenarios.length - 1) { next.finished = true; next.completedAt = now; }
    else next.index++;
  } else return run;
  next.revision = run.revision + 1;
  return next;
}

/** Web Locks is preferred. A short IDB readwrite transaction also serializes tabs.
 * The callback must be synchronous, including all shared storage reads and writes.
 * No localStorage check-and-set is treated as atomic.
 */
export function createSharedCoordinator({locks = globalThis.navigator?.locks, indexedDB = globalThis.indexedDB, onUnavailable = () => {}} = {}) {
  const name = 'macrolock:shared-state:v1';
  let database;
  let localQueue = Promise.resolve();
  const idbCoordinate = callback => new Promise((resolve, reject) => {
    let cancelled = false;
    const transact = db => {
      let value;
      const tx = db.transaction('coordination', 'readwrite');
      const store = tx.objectStore('coordination');
      const request = store.get(name);
      request.onsuccess = () => {
        try {
          value = callback();
          if (value?.then) throw new TypeError('Shared transitions must be synchronous');
          store.put(1, name);
        } catch (error) { tx.abort(); reject(error); }
      };
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Shared transaction aborted'));
    };
    if (database) return transact(database);
    if (!indexedDB) return reject(new Error('Shared coordination unavailable'));
    const request = indexedDB.open('macrolock-coordination', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('coordination');
    request.onsuccess = () => { if (cancelled) { request.result.close(); return; } database = request.result; database.onversionchange = () => { database.close(); database = null; }; transact(database); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { cancelled = true; reject(new Error('Shared coordination blocked')); };
  });
  const execute = async callback => {
    let entered = false;
    const invoke = () => { entered = true; return callback(); };
    if (locks?.request) {
      try { return await locks.request(name, invoke); }
      catch (error) { if (entered) throw error; }
    }
    try { return await idbCoordinate(invoke); }
    catch (error) { if (entered) throw error; onUnavailable(); return callback(); }
  };
  return callback => {
    const pending = localQueue.then(() => execute(callback));
    localQueue = pending.catch(() => {});
    return pending;
  };
}
