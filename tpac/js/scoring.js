/* T-PAC browser scoring: mirror of lib/tpac-scoring.js (keep in sync).
   Exposes window.TPACScore = { validateFrame, scoreGame, computeHandicap }. */
(function () {
  'use strict';

  function validateFrame(rolls, frameIndex) {
    if (!Array.isArray(rolls) || rolls.length === 0) return 'empty_frame';
    for (var i = 0; i < rolls.length; i++) {
      var r = rolls[i];
      if (typeof r !== 'number' || r % 1 !== 0 || r < 0 || r > 10) return 'bad_roll';
    }
    if (frameIndex < 9) {
      if (rolls[0] === 10) return rolls.length === 1 ? null : 'strike_extra_roll';
      if (rolls.length !== 2) return 'need_two_rolls';
      if (rolls[0] + rolls[1] > 10) return 'frame_over_ten';
      return null;
    }
    if (rolls.length < 2 || rolls.length > 3) return 'tenth_roll_count';
    var r0 = rolls[0], r1 = rolls[1], r2 = rolls[2];
    if (r0 < 10 && r0 + r1 > 10) return 'frame_over_ten';
    var earnedFill = r0 === 10 || r0 + r1 === 10;
    if (earnedFill && rolls.length !== 3) return 'tenth_missing_fill';
    if (!earnedFill && rolls.length !== 2) return 'tenth_no_fill_earned';
    if (r0 === 10 && rolls.length === 3 && r1 < 10 && r1 + r2 > 10) return 'tenth_over_ten';
    return null;
  }

  function scoreGame(frames) {
    var rolls = [], frameStarts = [];
    var n = Math.min(Array.isArray(frames) ? frames.length : 0, 10);
    for (var i = 0; i < n; i++) {
      frameStarts.push(rolls.length);
      for (var j = 0; j < frames[i].length; j++) rolls.push(frames[i][j]);
    }
    var frameScores = [], total = 0, complete = n === 10;
    for (var f = 0; f < n; f++) {
      var s = frameStarts[f];
      if (f === 9) {
        var tenth = frames[9];
        var needed = (tenth[0] === 10 || tenth[0] + (tenth[1] || 0) === 10) ? 3 : 2;
        if (tenth.length < needed) { frameScores.push(null); complete = false; break; }
        for (var t = 0; t < tenth.length; t++) total += tenth[t];
        frameScores.push(total);
        continue;
      }
      if (frames[f][0] === 10) {
        if (rolls.length < s + 3) { frameScores.push(null); complete = false; break; }
        total += 10 + rolls[s + 1] + rolls[s + 2];
      } else if (frames[f][0] + frames[f][1] === 10) {
        if (rolls.length < s + 3) { frameScores.push(null); complete = false; break; }
        total += 10 + rolls[s + 2];
      } else {
        total += frames[f][0] + frames[f][1];
      }
      frameScores.push(total);
    }
    return { total: total, frameScores: frameScores, complete: complete && frameScores.length === 10 && frameScores[9] !== null };
  }

  function computeHandicap(average, base, percent) {
    var b = Number(base) || 220, p = (Number(percent) || 90) / 100, avg = Number(average) || 0;
    return Math.max(0, Math.round((b - avg) * p));
  }

  window.TPACScore = { validateFrame: validateFrame, scoreGame: scoreGame, computeHandicap: computeHandicap };
})();
