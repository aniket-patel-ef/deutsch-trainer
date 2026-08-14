// Progress lives in localStorage — the browser equivalent of the app's Room
// database. Same shape as the Drive snapshot so the two can be reconciled later.

import { MAX_CROWNS, earnsCrown, nextCrownLevel, percent, xpFor } from './engine.js';

const KEY = 'deutschtrainer.progress.v1';
const DAY_MS = 86400000;

const EMPTY = {
  schema: 1,
  lessons: {},        // lessonId -> { crownLevel, completions, bestScorePct, lastScorePct, lastPracticedAt }
  questionStats: {},  // questionId -> { timesSeen, timesCorrect, lastSeenAt, lessonId }
  vocabStats: {},     // wordId -> { timesSeen, timesCorrect, timesWrong, box, lastSeenAt, dueAt }
  vocabImages: {},    // wordId -> resolved url ('' means checked and none found)
  sessions: [],
  stats: { xp: 0, streakDays: 0, lastActiveEpochDay: 0, lessonsCompleted: 0,
           dailyGoalXp: 50, todayXp: 0, todayEpochDay: 0, revision: 0 },
};

let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(EMPTY);
    return { ...structuredClone(EMPTY), ...JSON.parse(raw) };
  } catch {
    return structuredClone(EMPTY);
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    // Quota or private-browsing refusal: keep playing in memory rather than crash.
    console.warn('Could not save progress', e);
  }
  listeners.forEach((fn) => fn(state));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const snapshot = () => state;
export const lessonProgress = (id) => state.lessons[id] ?? { crownLevel: 0, completions: 0, bestScorePct: 0, lastScorePct: 0 };
export const crownsFor = (id) => lessonProgress(id).crownLevel;
export const userStats = () => state.stats;

export function questionStatsFor(lessonId) {
  const out = {};
  for (const [qid, st] of Object.entries(state.questionStats)) {
    if (st.lessonId === lessonId) out[qid] = st;
  }
  return out;
}

/**
 * Commits one finished run. `attempts` is every submission (per-question history);
 * `firstAttempts` is one boolean per distinct question and is what the score uses.
 */
export function recordSession({ lessonId, lessonTitle, kind, attempts, firstAttempts, durationMs }) {
  const now = Date.now();

  // Fold attempts per question: a question can appear twice in one run (missed,
  // then retried) and both submissions must count towards its history.
  const byQuestion = new Map();
  for (const [qid, ok] of attempts) {
    const acc = byQuestion.get(qid) ?? { seen: 0, correct: 0 };
    acc.seen += 1;
    if (ok) acc.correct += 1;
    byQuestion.set(qid, acc);
  }
  for (const [qid, acc] of byQuestion) {
    const prev = state.questionStats[qid] ?? { timesSeen: 0, timesCorrect: 0, lessonId };
    state.questionStats[qid] = {
      lessonId,
      timesSeen: prev.timesSeen + acc.seen,
      timesCorrect: prev.timesCorrect + acc.correct,
      lastSeenAt: now,
    };
  }

  const prev = state.lessons[lessonId] ?? { crownLevel: 0, completions: 0, bestScorePct: 0 };
  const pct = percent(firstAttempts);
  const crownEarned = earnsCrown(firstAttempts, prev.crownLevel);
  const newCrown = nextCrownLevel(firstAttempts, prev.crownLevel);

  state.lessons[lessonId] = {
    crownLevel: newCrown,
    completions: prev.completions + 1,
    bestScorePct: Math.max(prev.bestScorePct, pct),
    lastScorePct: pct,
    lastPracticedAt: now,
  };

  const correct = firstAttempts.filter(Boolean).length;
  const xp = xpFor(correct, firstAttempts.length, crownEarned);
  const today = Math.floor(now / DAY_MS);
  const s = state.stats;
  const newStreak = s.lastActiveEpochDay === today ? Math.max(1, s.streakDays)
    : s.lastActiveEpochDay === today - 1 ? s.streakDays + 1
    : 1;

  state.stats = {
    ...s,
    xp: s.xp + xp,
    streakDays: newStreak,
    lastActiveEpochDay: today,
    lessonsCompleted: s.lessonsCompleted + 1,
    todayXp: s.todayEpochDay === today ? s.todayXp + xp : xp,
    todayEpochDay: today,
    revision: s.revision + 1,
  };

  state.sessions.unshift({
    lessonId, lessonTitle, kind, correct, total: firstAttempts.length,
    xpEarned: xp, durationMs, finishedAt: now,
  });
  state.sessions = state.sessions.slice(0, 100);

  persist();
  return {
    correct, total: firstAttempts.length, pct, xpEarned: xp,
    crownEarned, newCrownLevel: newCrown,
    streakDays: newStreak,
    dailyGoalMet: state.stats.todayXp >= state.stats.dailyGoalXp,
  };
}

export function setDailyGoal(xp) {
  state.stats = { ...state.stats, dailyGoalXp: xp, revision: state.stats.revision + 1 };
  persist();
}

// --- vocabulary ---------------------------------------------------------

/**
 * Leitner intervals. Box 0 is twenty minutes rather than zero: at zero a missed
 * word is due again the instant you answer it, and since reviews are picked ahead
 * of new words it came back in the very next round and every round after, which
 * made the drill feel like it only knew a handful of words.
 */
const BOX_INTERVALS_MS = [
  20 * 60 * 1000,
  1 * DAY_MS,
  2 * DAY_MS,
  4 * DAY_MS,
  8 * DAY_MS,
  16 * DAY_MS,
];

export const vocabStat = (wordId) => state.vocabStats[wordId] ?? null;

export function recordVocabAnswer(wordId, correct) {
  const now = Date.now();
  const prev = state.vocabStats[wordId] ?? { timesSeen: 0, timesCorrect: 0, timesWrong: 0, box: 0 };
  const box = correct ? Math.min(5, prev.box + 1) : Math.max(0, prev.box - 2);
  state.vocabStats[wordId] = {
    timesSeen: prev.timesSeen + 1,
    timesCorrect: prev.timesCorrect + (correct ? 1 : 0),
    timesWrong: prev.timesWrong + (correct ? 0 : 1),
    box,
    lastSeenAt: now,
    dueAt: now + BOX_INTERVALS_MS[box],
  };
  persist();
}

export function vocabTotals() {
  const all = Object.values(state.vocabStats);
  return {
    practiced: all.filter((s) => s.timesSeen > 0).length,
    mastered: all.filter((s) => s.box >= 4).length,
    exposures: all.reduce((sum, s) => sum + s.timesSeen, 0),
  };
}

export const cachedImage = (wordId) => state.vocabImages[wordId];

export function cacheImage(wordId, url) {
  state.vocabImages[wordId] = url || '';
  persist();
}

// --- import / export ----------------------------------------------------

export const exportJson = () => JSON.stringify(state, null, 2);

export function importJson(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || !('lessons' in parsed)) {
    throw new Error('That does not look like a Deutsch Trainer backup.');
  }
  state = { ...structuredClone(EMPTY), ...parsed };
  persist();
}

export function resetAll() {
  state = structuredClone(EMPTY);
  persist();
}

export { MAX_CROWNS };
