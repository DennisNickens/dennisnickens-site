/* ============================================================
   T-PAC scoring math: ten-pin game scoring, handicap, payouts.
   ------------------------------------------------------------
   Pure functions, shared by the match endpoints. A browser
   mirror lives at tpac/js/scoring.js — keep the two in sync.

   Frame format: frames is an array of up to 10 entries, each an
   array of rolls (pinfall counts). Frames 1-9 hold 1-2 rolls
   (1 roll when it is a strike); frame 10 holds 2-3 rolls.
   ============================================================ */

'use strict';

/**
 * Validates one frame entry. Returns null when valid, else a
 * short error code string.
 */
function validateFrame(rolls, frameIndex) {
  if (!Array.isArray(rolls) || rolls.length === 0) return 'empty_frame';
  for (const r of rolls) {
    if (typeof r !== 'number' || !Number.isInteger(r) || r < 0 || r > 10) return 'bad_roll';
  }
  if (frameIndex < 9) {
    if (rolls[0] === 10) return rolls.length === 1 ? null : 'strike_extra_roll';
    if (rolls.length !== 2) return 'need_two_rolls';
    if (rolls[0] + rolls[1] > 10) return 'frame_over_ten';
    return null;
  }
  // Tenth frame: 2 rolls normally, 3 when the first two earn a fill ball.
  if (rolls.length < 2 || rolls.length > 3) return 'tenth_roll_count';
  const r0 = rolls[0], r1 = rolls[1], r2 = rolls[2];
  if (r0 < 10 && r0 + r1 > 10) return 'frame_over_ten';
  const earnedFill = r0 === 10 || r0 + r1 === 10;
  if (earnedFill && rolls.length !== 3) return 'tenth_missing_fill';
  if (!earnedFill && rolls.length !== 2) return 'tenth_no_fill_earned';
  // After a strike, rolls 2-3 share a fresh rack unless roll 2 strikes too.
  if (r0 === 10 && rolls.length === 3 && r1 < 10 && r1 + r2 > 10) return 'tenth_over_ten';
  return null;
}

/**
 * Scores a (possibly partial) game. Returns
 * { total, frameScores, complete } where frameScores[i] is the
 * cumulative score through frame i (null while a mark's bonus
 * rolls have not happened yet).
 */
function scoreGame(frames) {
  const rolls = [];
  const frameStarts = [];
  const n = Math.min(Array.isArray(frames) ? frames.length : 0, 10);
  for (let i = 0; i < n; i++) {
    frameStarts.push(rolls.length);
    for (const r of frames[i]) rolls.push(r);
  }

  const frameScores = [];
  let total = 0;
  let complete = n === 10;

  for (let i = 0; i < n; i++) {
    const s = frameStarts[i];
    if (i === 9) {
      const f = frames[9];
      const needed = (f[0] === 10 || f[0] + (f[1] || 0) === 10) ? 3 : 2;
      if (f.length < needed) { frameScores.push(null); complete = false; break; }
      total += f.reduce((a, b) => a + b, 0);
      frameScores.push(total);
      continue;
    }
    if (frames[i][0] === 10) {
      // Strike: 10 + next two rolls
      if (rolls.length < s + 3) { frameScores.push(null); complete = false; break; }
      total += 10 + rolls[s + 1] + rolls[s + 2];
    } else if (frames[i][0] + frames[i][1] === 10) {
      // Spare: 10 + next roll
      if (rolls.length < s + 3) { frameScores.push(null); complete = false; break; }
      total += 10 + rolls[s + 2];
    } else {
      total += frames[i][0] + frames[i][1];
    }
    frameScores.push(total);
  }

  return { total, frameScores, complete: complete && frameScores.length === 10 && frameScores[9] !== null };
}

/**
 * Handicap per the bracket's settings: ROUND((base - average) *
 * percent), floored at zero so a high average never goes negative.
 * percent is expressed 0-100.
 */
function computeHandicap(average, base, percent) {
  const b = Number(base) || 220;
  const p = (Number(percent) || 90) / 100;
  const avg = Number(average) || 0;
  return Math.max(0, Math.round((b - avg) * p));
}

/**
 * Payouts from percentage splits. splitPercents is an array of
 * percentages by place (1st first); rakePercent is the organizer
 * cut. All must sum to 100. Amounts are rounded to cents with
 * the remainder folded into first place so the pool always
 * balances exactly.
 */
function computePayouts(pool, splitPercents, rakePercent) {
  const places = (splitPercents || []).map(p => Math.round(pool * (Number(p) / 100) * 100) / 100);
  const rake = Math.round(pool * ((Number(rakePercent) || 0) / 100) * 100) / 100;
  const allocated = places.reduce((a, b) => a + b, 0) + rake;
  const remainder = Math.round((pool - allocated) * 100) / 100;
  if (places.length > 0) places[0] = Math.round((places[0] + remainder) * 100) / 100;
  return { places, rake };
}

/**
 * Validates that split percentages + rake account for the whole
 * pool. Returns null when valid, else an error code.
 */
function validateSplit(splitPercents, rakePercent) {
  if (!Array.isArray(splitPercents) || splitPercents.length === 0) return 'split_required';
  const nums = splitPercents.map(Number).concat(Number(rakePercent) || 0);
  if (nums.some(v => isNaN(v) || v < 0)) return 'split_negative';
  const sum = nums.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.001) return 'split_must_total_100';
  return null;
}

/**
 * Standard single-elimination seeding order for a bracket of
 * size n (4, 8, or 16): returns seed numbers (1-based) in first
 * round pairing order, e.g. size 8 -> [1,8,4,5,2,7,3,6].
 * Missing entrants at the tail seeds become byes for the tops.
 */
function seedOrder(n) {
  let order = [1, 2];
  while (order.length < n) {
    const next = [];
    const size = order.length * 2;
    for (const s of order) { next.push(s); next.push(size + 1 - s); }
    order = next;
  }
  return order;
}

module.exports = { validateFrame, scoreGame, computeHandicap, computePayouts, validateSplit, seedOrder };
