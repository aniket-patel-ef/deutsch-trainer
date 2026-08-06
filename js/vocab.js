// The 10,000-word vocabulary trainer. Mirrors data/vocab/VocabRepository.kt and
// ui/vocab/: three drills, Leitner-box scheduling, lazy Wikimedia images.

import { el, mount, spinner, umlautRow } from './dom.js';
import { vocabBank } from './content.js';
import { normalize, shuffle } from './engine.js';
import { cacheImage, cachedImage, recordVocabAnswer, vocabStat, vocabTotals } from './storage.js';
import { findImage } from './images.js';
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
  if (mode === 'IMAGE_TO_WORD') return w.concrete && w.pos === 'noun';
  if (mode === 'ARTICLE_ONLY') return w.pos === 'noun' && !!w.article;
  return true;
};

/**
 * Picks the round. Due words first, never-seen last, hardest boxes first — the
 * SQL ORDER BY from VocabDao, expressed in JS.
 */
function pickWords(bank, { nounsOnly, imagesOnly, size }) {
  const now = Date.now();
  const eligible = bank.filter((w) => {
    if (nounsOnly && w.pos !== 'noun') return false;
    if (imagesOnly && !w.concrete) return false;
    const st = vocabStat(w.id);
    return !st || (st.dueAt ?? 0) <= now;
  });

  eligible.sort((a, b) => {
    const sa = vocabStat(a.id), sb = vocabStat(b.id);
    const seenA = sa ? 0 : 1, seenB = sb ? 0 : 1;
    if (seenA !== seenB) return seenA - seenB;              // reviews before new words
    const boxA = sa?.box ?? 0, boxB = sb?.box ?? 0;
    if (boxA !== boxB) return boxA - boxB;                  // weakest boxes first
    const dueA = sa?.dueAt ?? Infinity, dueB = sb?.dueAt ?? Infinity;
    if (dueA !== dueB) return dueA - dueB;
    return a.rank - b.rank;                                // then by frequency
  });

  return shuffle(eligible.slice(0, size * 3)).slice(0, size);
}

function buildPrompt(word, mode, bank) {
  // In the picture round the distractors are concrete too, otherwise an abstract
  // option next to a photograph gives the answer away.
  const concreteOnly = mode === 'IMAGE_TO_WORD';
  const distractorPool = bank.filter((w) =>
    w.pos === word.pos && w.id !== word.id && (!concreteOnly || w.concrete));
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

  if (!words.length) {
    mount(el('div', { class: 'card' },
      el('h2', { text: 'Nothing due right now' }),
      el('p', { class: 'muted', text: 'Every word in this drill is scheduled for later. Try another drill.' }),
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

  async function loadImage() {
    const p = current();
    if (!p || p.mode !== 'IMAGE_TO_WORD') return;
    const cached = cachedImage(p.word.id);
    if (cached !== undefined) { state.imageUrl = cached || null; render(); return; }
    state.imageUrl = undefined;   // undefined = still resolving
    render();
    const url = await findImage(p.word.german, p.word.english);
    cacheImage(p.word.id, url);
    if (current()?.word.id === p.word.id) { state.imageUrl = url; render(); }
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
      const inner = state.imageUrl === undefined
        ? spinner()
        : state.imageUrl
          ? el('img', { src: state.imageUrl, alt: '', loading: 'lazy',
              onerror: (e) => { e.target.replaceWith(fallback(p)); } })
          : fallback(p);
      return el('div', { class: 'image-panel' }, inner);
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
