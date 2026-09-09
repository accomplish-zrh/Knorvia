'use strict';

// Pure pet animation state machine (B19). Maps real task states onto sprite
// rows, computes the visible frame from wall-clock ticks, and never decides
// task completion from an animation — the mapping is one-way. Reducing motion
// pins a single frame; a hidden surface yields no frame at all so hosts can
// stop decoding entirely.

// Task-level inputs are coarse; the pet layer only ever refines presentation.
const STATE_ROWS = {
  idle: 0,          // no active work
  working: 7,       // official running = focused work, not foot-running
  waiting: 6,       // needs user input / approval
  succeeded: 3,     // last visible outcome, briefly, then back to idle
  failed: 5, review: 8, 'running-right': 1, 'running-left': 2,
};
const { DURATIONS } = require('./pet-atlas');

function createPetRuntime({ layout, fps = 8, reducedMotion = false, outcomeHoldMs = 4000 } = {}) {
  if (!layout || !layout.columns || !layout.rows) throw new Error('pet runtime needs a sprite layout');
  let state = 'idle';
  let stateSince = 0; // ms timestamp of the last state change
  const api = {
    get state() { return state; },
    // Hosts report facts; nothing here ever reports back as fact.
    setState(next, now = Date.now()) {
      if (!(next in STATE_ROWS)) return false;
      if (next === state) return false;
      state = next;
      stateSince = now;
      return true;
    },
    // Returns null when nothing should be drawn (hidden surface), otherwise
    // the sprite cell to render for this tick.
    frame(now = Date.now(), { visible = true } = {}) {
      if (!visible) return null;
      // Brief outcome states hold one frame, then the pet settles back idle.
      if ((state === 'succeeded' || state === 'failed') && now - stateSince > outcomeHoldMs) {
        state = 'idle';
        stateSince = now;
      }
      const row = STATE_ROWS[state];
      let index;
      if (reducedMotion || state === 'succeeded' || state === 'failed') {
        // Reduced motion and outcomes pin a representative frame instead of
        // looping the full animation.
        index = row * layout.columns;
      } else {
        const timings = DURATIONS[row]; let phase = Math.max(0, now - stateSince) % timings.reduce((sum, time) => sum + time, 0), column = 0;
        while (column < timings.length - 1 && phase >= timings[column]) { phase -= timings[column]; column++; }
        index = row * layout.columns + column;
      }
      lastFrame.index = index;
      return api.cell(index, now);
    },
    // Cell index → sprite sheet pixel offset, normalized by layout.
    cell(index, now = Date.now()) {
      const column = index % layout.columns;
      const row = Math.floor(index / layout.columns);
      if (row >= layout.rows) return null;
      lastFrame.index = index;
      return {
        index,
        row, column,
        x: column * layout.cellWidth,
        y: row * layout.cellHeight,
        width: layout.cellWidth,
        height: layout.cellHeight,
        state,
        at: now,
      };
    },
  };
  const lastFrame = { index: 0 };
  return api;
}

module.exports = { createPetRuntime, STATE_ROWS };
