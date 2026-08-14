// The 10,000-word vocabulary trainer. Mirrors data/vocab/VocabRepository.kt and
// ui/vocab/: three drills, Leitner-box scheduling, and a picture drill whose
// pictures are the curated emoji in the bank rather than a live image search.

import { el, mount, spinner, umlautRow } from './dom.js';
import { vocabBank } from './content.js';
import { normalize, shuffle } from './engine.js';
import { recordVocabAnswer, vocabStat, vocabTotals } from './storage.js';
import { speak, SLOW_RATE } from './speech.js';

const ROUND_SIZE = 10;
const TOTAL_WORDS = 10000;

const DRILLS = {
  MIXED: { title: 'Mixed', subtitle: 'Pictures, articles and translation', icon: '🔤', colour: 'var(--feather-green)' },
  ARTICLES: { title: 'Der / Die / Das', subtitle: 'Article drill only', icon: '🔠', colour: 'var(--macaw)' },
  IMAGES: { title: 'Pictures', subtitle: 'What is this? Answer with the article', icon: '🖼️', colour: 'var(--beetle)' },
};

const MODES = { IMAGE_TO_WORD: 1, ARTICLE_ONLY: 1, DE_TO_EN: 1, EN_TO_DE: 1, LISTEN_TYPE: 1 };

const withArticle = (w) => (w.article ? `${w.article} ${w.german}` : w.german);

const QUESTION = {
  IMAGE_TO_WORD: 'What is this?',
  ARTICLE_ONLY: 'der, die or das?',
  DE_TO_EN: 'What does this mean?',
  EN_TO_DE: 'How do you say this in German?',
  LISTEN_TYPE: 'Type what you hear',
};

function modesFor(drill) {
  if (drill === 'ARTICLES') return ['ARTICLE_ONLY'];
  if (drill === 'IMAGES') return ['IMAGE_TO_WORD'];
  return Object.keys(MODES);
}

const validFor = (mode, w) => {
  if (mode === 'IMAGE_TO_WORD') return w.picturable;
  if (mode === 'ARTICLE_ONLY') return w.pos === 'noun' && !!w.article;
  return true;
};

/** At most this share of a round may be words you have already met. */
const MAX_REVIEW_SHARE = 0.5;

/** How many rounds' worth of not-yet-due words the never-empty fallback draws from. */
const FALLBACK_SPREAD = 12;

/**
 * Picks the round: due reviews first, then never-seen words, hardest boxes first
 * — the SQL ORDER BY from VocabDao, expressed in JS.
 *
 * Reviews are capped at half the round. Sorting reviews ahead of new words is
 * right, but on its own it meant a handful of words you had missed filled every
 * round and the other 1,100-odd never appeared.
 */
export function pickWords(bank, { nounsOnly, imagesOnly, size }) {
  const now = Date.now();
  const inDrill = (w) => {
    if (nounsOnly && w.pos !== 'noun') return false;
    if (imagesOnly && !w.picturable) return false;
    return true;
  };
  const candidates = bank.filter(inDrill);
  const eligible = candidates.filter((w) => {
    const st = vocabStat(w.id);
    return !st || (st.dueAt ?? 0) <= now;
  });

  const byUrgency = (a, b) => {
    const sa = vocabStat(a.id), sb = vocabStat(b.id);
    const boxA = sa?.box ?? 0, boxB = sb?.box ?? 0;
    if (boxA !== boxB) return boxA - boxB;                  // weakest boxes first
    const dueA = sa?.dueAt ?? Infinity, dueB = sb?.dueAt ?? Infinity;
    if (dueA !== dueB) return dueA - dueB;
    return a.rank - b.rank;                                // then by frequency
  };

  const reviews = eligible.filter((w) => vocabStat(w.id)).sort(byUrgency);
  const fresh = eligible.filter((w) => !vocabStat(w.id)).sort(byUrgency);

  const reviewQuota = Math.min(reviews.length, Math.floor(size * MAX_REVIEW_SHARE));
  // Widen each side before shuffling so the same urgent words are not simply the
  // round every time; take from the fresh side whatever reviews leave unfilled.
  const picked = [
    ...shuffle(reviews.slice(0, Math.max(reviewQuota * 3, reviewQuota))).slice(0, reviewQuota),
    ...shuffle(fresh.slice(0, size * 3)).slice(0, size - reviewQuota),
  ];

  // Nothing due is not a reason to refuse to practise. The scheduler decides what
  // is *best* to review, not whether the learner is allowed a round at all: with
  // everything scheduled for later the drill used to dead-end on "Nothing due
  // right now", which is what it did after 29 words. Fall back to the words
  // closest to due, so a drill only ever ends when its pool is genuinely empty.
  if (picked.length < size) {
    const used = new Set(picked.map((w) => w.id));
    const nextBest = candidates
      .filter((w) => !used.has(w.id))
      .sort((a, b) => (vocabStat(a.id)?.dueAt ?? 0) - (vocabStat(b.id)?.dueAt ?? 0));
    // Shuffle a wide slice rather than taking the head. Answering a round schedules
    // every word in it at almost the same moment, so a straight take by dueAt
    // returned very nearly the same ten words each time — the repetition the
    // picture drill had before, reintroduced through the back door.
    picked.push(...shuffle(nextBest.slice(0, size * FALLBACK_SPREAD)).slice(0, size - picked.length));
  }
  return shuffle(picked);
}

function buildPrompt(word, mode, bank) {
  // In the picture round the distractors are picturable too, otherwise an abstract
  // option next to a picture gives the answer away.
  const pictureRound = mode === 'IMAGE_TO_WORD';
  const distractorPool = bank.filter((w) =>
    w.pos === word.pos && w.id !== word.id && (!pictureRound || w.picturable));
  const pick3 = () => shuffle(distractorPool).slice(0, 3);

  let options = [], answerIndex = -1;
  if (mode === 'ARTICLE_ONLY') {
    options = ['der', 'die', 'das'];
    answerIndex = options.indexOf(word.article);
  } else if (mode === 'IMAGE_TO_WORD' || mode === 'EN_TO_DE') {
    const correct = withArticle(word);
    options = shuffle([correct, ...pick3().map(withArticle).filter((o) => o !== correct)]);
    answerIndex = options.indexOf(correct);
  } else if (mode === 'DE_TO_EN') {
    options = shuffle([word.english, ...pick3().map((w) => w.english).filter((o) => o !== word.english)]);
    answerIndex = options.indexOf(word.english);
  }
  const st = vocabStat(word.id);
  return { word, mode, options, answerIndex, timesSeen: st?.timesSeen ?? 0, box: st?.box ?? 0 };
}

export async function renderVocabHub({ onStartDrill }) {
  const totals = vocabTotals();
  mount(
    el('h1', { class: 'page-title', text: 'Vocabulary' }),
    el('p', { class: 'muted', style: 'margin:0 0 20px',
      text: `${TOTAL_WORDS.toLocaleString('en')} German words with their articles` }),
    el('div', { class: 'tiles' },
      tile(totals.practiced, 'practised', 'var(--macaw)'),
      tile(totals.mastered, 'mastered', 'var(--feather-green)'),
      tile(totals.exposures, 'reviews', 'var(--fox)')),
    el('div', { class: 'progress', style: 'margin:14px 0 6px' },
      el('div', { style: `width:${(totals.practiced / TOTAL_WORDS) * 100}%` })),
    el('p', { class: 'small muted', style: 'margin:0 0 24px',
      text: `${totals.practiced} of ${TOTAL_WORDS.toLocaleString('en')} words seen so far` }),
    el('h2', { style: 'font-size:19px;margin:0 0 12px', text: 'Choose a drill' }),
    Object.entries(DRILLS).map(([key, d]) =>
      el('button', { class: 'card-btn', style: 'margin-bottom:12px', onclick: () => onStartDrill(key) },
        el('div', { class: 'card-icon', style: `background:color-mix(in srgb, ${d.colour} 16%, transparent);color:${d.colour}` }, d.icon),
        el('div', {},
          el('div', { style: 'font-size:17px', text: d.title }),
          el('div', { class: 'small muted', text: d.subtitle })))));
}

const tile = (n, label, colour) =>
  el('div', { class: 'tile' },
    el('div', { class: 'n', style: `color:${colour}`, text: n.toLocaleString('en') }),
    el('div', { class: 'l', text: label }));

export async function startVocabDrill({ drill, onExit }) {
  mount(spinner());
  const bank = await vocabBank();

  const words = pickWords(bank, {
    nounsOnly: drill === 'ARTICLES',
    imagesOnly: drill === 'IMAGES',
    size: ROUND_SIZE,
  });

  // pickWords always returns a round when the drill's pool is non-empty, so this
  // only fires when the bank itself has no word matching the filter.
  if (!words.length) {
    mount(el('div', { class: 'card' },
      el('h2', { text: 'This drill has no words yet' }),
      el('p', { class: 'muted', text: 'Reload the page to pick up the latest word list, then try again.' }),
      el('button', { class: 'btn', style: 'margin-top:16px', onclick: onExit }, 'Back')));
    return;
  }

  const allowed = modesFor(drill);
  const prompts = words.map((w) => {
    const usable = allowed.filter((m) => validFor(m, w));
    const mode = (usable.length ? usable : ['DE_TO_EN'])[Math.floor(Math.random() * (usable.length || 1))];
    return buildPrompt(w, mode, bank);
  });

  const state = { index: 0, selected: -1, typed: '', answered: null, expected: '', correct: 0, imageUrl: undefined };
  const current = () => prompts[state.index];

  /**
   * Nothing to load: every picture-drill word carries its own emoji, so the
   * picture is already in the bank. This used to fetch a photo from Wikimedia and
   * that is what produced the pictures that made no sense — a geology diagram for
   * "der Zug", an 1886 three-wheeler for "das Auto", an iguana for "der Kopf".
   * Any image cached by that old lookup is dropped here so it cannot be shown.
   */
  function loadImage() {
    const p = current();
    if (!p || p.mode !== 'IMAGE_TO_WORD') return;
    state.imageUrl = null;
  }

  function check() {
    const p = current();
    if (!p || state.answered !== null) return;
    let ok;
    if (p.mode === 'LISTEN_TYPE') {
      const expected = withArticle(p.word);
      ok = normalize(state.typed) === normalize(expected)
        || normalize(state.typed) === normalize(p.word.german);
      state.expected = expected;
    } else {
      ok = state.selected === p.answerIndex;
      state.expected = p.options[p.answerIndex] ?? '';
    }
    state.answered = ok;
    if (ok) state.correct += 1;
    recordVocabAnswer(p.word.id, ok);
    render();
  }

  function next() {
    if (state.answered === null) return;
    if (state.index >= prompts.length - 1) { renderSummary(); return; }
    state.index += 1;
    Object.assign(state, { selected: -1, typed: '', answered: null, expected: '', imageUrl: undefined });
    render();
    loadImage();
    if (current().mode === 'LISTEN_TYPE') speak(withArticle(current().word));
  }

  function panel(p) {
    if (p.mode === 'IMAGE_TO_WORD') {
      // The emoji is the picture. pickWords only offers words that have one, so
      // there is nothing to fetch, nothing to wait for and nothing to get wrong.
      return el('div', { class: 'image-panel' }, fallback(p));
    }
    if (p.mode === 'LISTEN_TYPE') {
      return el('div', { class: 'audio-controls' },
        el('button', { class: 'audio-big', 'aria-label': 'Play', onclick: () => speak(withArticle(p.word)) }, '🔊'),
        el('button', { class: 'audio-slow', 'aria-label': 'Play slowly',
          onclick: () => speak(withArticle(p.word), { rate: SLOW_RATE }) }, '🐢'));
    }
    const shown = p.mode === 'EN_TO_DE' ? p.word.english
      : p.mode === 'ARTICLE_ONLY' ? p.word.german
      : withArticle(p.word);
    const sub = p.mode === 'ARTICLE_ONLY' ? p.word.english : '';
    return el('div', { class: 'card', style: 'display:flex;align-items:center;gap:12px' },
      el('div', { class: 'grow' },
        el('div', { style: 'font-size:26px;font-weight:800', text: shown }),
        sub ? el('div', { class: 'small muted', text: sub }) : null),
      p.mode !== 'EN_TO_DE'
        ? el('button', { class: 'speak-btn', 'aria-label': 'Play audio',
            onclick: () => speak(withArticle(p.word)) }, '🔊')
        : null);
  }

  const fallback = (p) => el('div', {},
    p.word.emoji
      ? el('div', { class: 'emoji', text: p.word.emoji })
      : el('div', {},
          el('div', { style: 'font-size:26px;font-weight:800', text: p.word.english }),
          el('div', { class: 'small muted', style: 'margin-top:6px', text: 'no picture available' })));

  function render() {
    const p = current();
    if (!p) return;
    const locked = state.answered !== null;

    const input = el('input', {
      class: 'text-input', type: 'text', placeholder: 'Word with its article',
      autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false',
      value: state.typed, disabled: locked,
      oninput: (e) => { state.typed = e.target.value; const b = document.getElementById('v-check'); if (b) b.disabled = !state.typed.trim(); },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); locked ? next() : check(); } },
    });

    mount(
      el('div', { class: 'lesson-top' },
        el('button', { class: 'quit', 'aria-label': 'Quit drill', onclick: onExit }, '✕'),
        el('div', { class: 'progress grow' },
          el('div', { style: `width:${(state.index / prompts.length) * 100}%` })),
        el('div', { class: 'small muted', text: `${state.index + 1}/${prompts.length}` })),
      el('h1', { class: 'instruction', text: QUESTION[p.mode] }),
      el('div', { class: 'small muted', style: 'margin:-8px 0 16px',
        text: `Seen ${p.timesSeen}× · level ${p.box}/5` }),
      panel(p),
      el('div', { style: 'height:22px' }),
      p.mode === 'LISTEN_TYPE'
        ? el('div', {}, input, umlautRow(() => input))
        : el('div', { class: 'choices' },
            p.options.map((option, i) => {
              const classes = ['choice'];
              if (locked && i === p.answerIndex) classes.push('choice--correct');
              else if (locked && i === state.selected) classes.push('choice--wrong');
              else if (!locked && i === state.selected) classes.push('choice--selected');
              return el('button', {
                class: classes.join(' '), disabled: locked,
                onclick: () => { state.selected = i; render(); },
              }, option);
            })),
      locked
        ? el('div', { class: `footer footer--${state.answered ? 'correct' : 'wrong'}` },
            el('p', { class: 'feedback-title', text: state.answered ? 'Correct!' : `Correct answer: ${state.expected}` }),
            el('button', { class: `btn ${state.answered ? '' : 'btn--red'}`, onclick: next }, 'Continue'))
        : el('div', { class: 'footer' },
            el('button', {
              class: 'btn', id: 'v-check',
              disabled: p.mode === 'LISTEN_TYPE' ? !state.typed.trim() : state.selected < 0,
              onclick: check,
            }, 'Check')));
  }

  function renderSummary() {
    mount(el('div', { class: 'result' },
      el('h1', { text: 'Round complete!' }),
      el('p', { class: 'muted', text: `${state.correct} of ${prompts.length} correct` }),
      el('div', { style: 'width:100%;display:grid;gap:12px' },
        el('button', { class: 'btn', onclick: () => startVocabDrill({ drill, onExit }) }, 'Another round'),
        el('button', { class: 'btn btn--ghost', onclick: onExit }, 'Done'))));
  }

  render();
  loadImage();
  if (current().mode === 'LISTEN_TYPE') speak(withArticle(current().word));
}
