// Ports of the Android app's engine/ package. Kept free of DOM access so the
// rules stay identical across both clients and can be reasoned about on their own.

// --- scoring (engine/SessionScoring.kt) --------------------------------

export const CROWN_THRESHOLD_PCT = 80;
export const MAX_CROWNS = 5;

/**
 * Scores a run on **first attempts only**. A lesson re-queues the questions you
 * miss, and counting those extra attempts would mean correcting your mistakes
 * lowered your score: 3 misses out of 10, all fixed, would read 10/13 = 76%.
 */
export function percent(firstAttempts) {
  if (!firstAttempts.length) return 0;
  return Math.floor((firstAttempts.filter(Boolean).length * 100) / firstAttempts.length);
}

export function earnsCrown(firstAttempts, currentCrowns) {
  return currentCrowns < MAX_CROWNS && percent(firstAttempts) >= CROWN_THRESHOLD_PCT;
}

export function nextCrownLevel(firstAttempts, currentCrowns) {
  return earnsCrown(firstAttempts, currentCrowns) ? currentCrowns + 1 : currentCrowns;
}

// --- question selection (engine/QuestionSelector.kt) -------------------

const RECENCY_WINDOW_MS = 1000 * 60 * 60 * 24 * 3;

/**
 * Weight for one question: novelty x difficulty x recency. Never-seen questions
 * score highest, weight decays with exposure, rises with the error rate, and is
 * damped for three days after you last saw it. This is what stops a redo from
 * feeling like a replay.
 */
function weightOf(stat, now) {
  if (!stat || !stat.timesSeen) return 10;
  const accuracy = stat.timesCorrect / stat.timesSeen;
  const difficulty = 1 + (1 - accuracy) * 2;          // 1 when always right, 3 when always wrong
  const novelty = 1 / Math.pow(1 + stat.timesSeen, 0.7);
  const since = Math.max(0, now - (stat.lastSeenAt || 0));
  const recency = since >= RECENCY_WINDOW_MS ? 1 : 0.25 + 0.75 * (since / RECENCY_WINDOW_MS);
  return Math.max(0.05, 10 * novelty * difficulty * recency);
}

function weightedSample(items, count) {
  const remaining = items.slice();
  const out = [];
  for (let n = 0; n < count && remaining.length; n++) {
    const total = remaining.reduce((s, it) => s + it.weight, 0);
    if (total <= 0) {
      out.push(remaining.splice(Math.floor(Math.random() * remaining.length), 1)[0].value);
      continue;
    }
    let roll = Math.random() * total;
    let idx = remaining.length - 1;
    for (let i = 0; i < remaining.length; i++) {
      roll -= remaining[i].weight;
      if (roll <= 0) { idx = i; break; }
    }
    out.push(remaining.splice(idx, 1)[0].value);
  }
  return out;
}

export function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Keeps answerIndex pointing at the right option after shuffling. */
function shuffleOptions(q) {
  if (!q.options || q.options.length < 2) return q;
  if (q.answerIndex == null || q.answerIndex < 0 || q.answerIndex >= q.options.length) return q;
  const correct = q.options[q.answerIndex];
  const options = shuffle(q.options);
  return { ...q, options, answerIndex: options.indexOf(correct) };
}

export function selectQuestions(pool, stats, count, now = Date.now()) {
  if (!pool.length) return [];
  const target = Math.min(count, pool.length);
  const weighted = pool.map((q) => ({ value: q, weight: weightOf(stats[q.id], now) }));
  return shuffle(weightedSample(weighted, target)).map(shuffleOptions);
}

// --- grading (engine/AnswerGrader.kt) ----------------------------------

const TYPO_BUDGET_RATIO = 0.12;

/**
 * Folds case, punctuation and umlauts so "Ich heiße Müller." matches
 * "ich heisse mueller". Deliberately lenient — this is practice, not an exam.
 */
export function normalize(input) {
  let out = '';
  for (const ch of (input || '').toLowerCase()) {
    if (ch === 'ä') out += 'ae';
    else if (ch === 'ö') out += 'oe';
    else if (ch === 'ü') out += 'ue';
    else if (ch === 'ß') out += 'ss';
    else if (ch === '’' || ch === '‘') out += "'";
    else if (/[\p{L}\p{N}]/u.test(ch) || ch === ' ' || ch === "'" || ch === '-') out += ch;
    else out += ' ';
  }
  return out.split(' ').filter(Boolean).join(' ');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

const grade = (correct, expected, note = '', score = correct ? 1 : 0) =>
  ({ correct, expected, note, score });

function gradeChoice(q, answer) {
  const expected = q.options?.[q.answerIndex] ?? '';
  return grade(answer === q.answerIndex && answer >= 0, expected);
}

function gradeText(q, answer, allowTypos) {
  const expectedList = q.accepted?.length ? q.accepted : [q.options?.[q.answerIndex] ?? ''];
  const display = expectedList[0] ?? '';
  if (!answer || !answer.trim()) return grade(false, display);

  const got = normalize(answer);
  if (expectedList.some((e) => normalize(e) === got)) return grade(true, display);

  if (allowTypos) {
    const near = expectedList.some((candidate) => {
      const exp = normalize(candidate);
      if (exp.length < 5) return false;
      return levenshtein(got, exp) <= Math.max(1, Math.floor(exp.length * TYPO_BUDGET_RATIO));
    });
    if (near) return grade(true, display, 'Watch the spelling.');
  }
  return grade(false, display);
}

function gradeTokens(q, tokens) {
  const expected = (q.solution || []).join(' ');
  const got = tokens || [];
  const ok = got.length === (q.solution || []).length &&
    got.every((t, i) => normalize(t) === normalize(q.solution[i]));
  return grade(ok, expected);
}

function gradeMatch(q, mapping) {
  const pairs = (q.left || []).map((l, i) => [l, (q.right || [])[i] ?? '']);
  const hits = pairs.filter(([l, r]) => normalize((mapping || {})[l] || '') === normalize(r)).length;
  const ok = pairs.length > 0 && hits === pairs.length;
  return {
    correct: ok,
    score: pairs.length ? hits / pairs.length : 0,
    expected: pairs.map(([l, r]) => `${l} → ${r}`).join(', '),
    note: '',
  };
}

/**
 * Speaking is scored on word overlap, not exact match: recognizers reliably drop
 * short function words and never return punctuation. 70% clears it.
 */
function gradeSpoken(q, transcript) {
  const target = q.targetText || q.prompt || '';
  if (!transcript || !transcript.trim()) {
    return grade(false, target, "Didn't hear anything — try again.");
  }
  const targetWords = normalize(target).split(' ').filter(Boolean);
  const said = normalize(transcript).split(' ').filter(Boolean);
  if (!targetWords.length) return grade(false, target);

  const remaining = said.slice();
  let hits = 0;
  for (const w of targetWords) {
    let idx = remaining.indexOf(w);
    if (idx < 0) idx = remaining.findIndex((s) => s.length > 3 && levenshtein(s, w) <= 1);
    if (idx >= 0) { remaining.splice(idx, 1); hits++; }
  }
  const score = hits / targetWords.length;
  const ok = score >= 0.7;
  const note = ok && score < 1 ? `Good! Heard: “${transcript}”`
    : ok ? 'Perfectly pronounced!'
    : `Heard: “${transcript}”`;
  return { correct: ok, score, expected: target, note };
}

/** Writing is graded on required elements plus length, not string equality. */
function gradeWriting(q, text) {
  const display = q.accepted?.[0] ?? '';
  if (!text || !text.trim()) return grade(false, display);
  const normalized = normalize(text);
  if ((q.accepted || []).some((a) => normalize(a) === normalized)) return grade(true, display);

  const required = q.mustInclude || [];
  if (!required.length) {
    const words = normalized.split(' ').filter(Boolean).length;
    const ok = words >= 3;
    return grade(ok, display, ok ? '' : 'Write a full sentence.');
  }
  const missing = required.filter((r) => !normalized.includes(normalize(r)));
  const score = (required.length - missing.length) / required.length;
  const ok = score >= 0.8;
  return {
    correct: ok,
    score,
    expected: display,
    note: ok ? '' : `Still missing: ${missing.join(', ')}`,
  };
}

/** `answer` shape depends on the question type; see the callers in lesson.js. */
export function gradeAnswer(q, answer) {
  switch (q.type) {
    case 'MULTIPLE_CHOICE':
    case 'LISTEN_CHOICE':
    case 'ARTICLE':
      return gradeChoice(q, answer);
    case 'FILL_BLANK':
      return gradeText(q, answer, false);
    case 'TRANSLATE':
    case 'LISTEN_TYPE':
      return gradeText(q, answer, true);
    case 'WORD_BANK':
      return gradeTokens(q, answer);
    case 'SPEAK':
      return gradeSpoken(q, answer);
    case 'WRITE':
      return gradeWriting(q, answer);
    case 'MATCH':
      return gradeMatch(q, answer);
    default:
      return grade(false, '');
  }
}

export function expectedFor(q) {
  if (q.accepted?.length) return q.accepted[0];
  if (q.solution?.length) return q.solution.join(' ');
  if (q.options?.length && q.answerIndex >= 0) return q.options[q.answerIndex];
  if (q.targetText) return q.targetText;
  return '';
}

// --- XP (data/progress/ProgressRepository.kt) --------------------------

const XP_PER_CORRECT = 2;
const PERFECT_BONUS = 5;
const CROWN_BONUS = 10;

export function xpFor(correct, total, crownEarned) {
  if (!total) return 0;
  return correct * XP_PER_CORRECT
    + (correct === total ? PERFECT_BONUS : 0)
    + (crownEarned ? CROWN_BONUS : 0);
}
