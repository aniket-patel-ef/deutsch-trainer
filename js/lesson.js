// The session player. Mirrors ui/lesson/: one question at a time, a feedback
// banner, missed questions re-queued once, and a result screen.

import { el, mount, spinner, toast, umlautRow } from './dom.js';
import { loadLesson } from './content.js';
import { expectedFor, gradeAnswer, selectQuestions, shuffle } from './engine.js';
import { questionStatsFor, recordSession, MAX_CROWNS } from './storage.js';
import { germanVoiceAvailable, recognitionAvailable, speak, startListening, stopSpeaking, SLOW_RATE } from './speech.js';
import { checkGerman, describeIssues } from './grammarcheck.js';

const INSTRUCTION = {
  ARTICLE: 'Which article?',
  LISTEN_TYPE: 'Type what you hear',
  LISTEN_CHOICE: 'What do you hear?',
  SPEAK: 'Say this sentence',
  WRITE: 'Write in German',
  WORD_BANK: 'Build the sentence',
  TRANSLATE: 'Translate',
  MATCH: 'Match the pairs',
  FILL_BLANK: 'Fill in the blank',
  MULTIPLE_CHOICE: 'Choose the correct answer',
};

const speechTextOf = (q) => q.audioText || q.targetText || q.prompt || '';

export async function startLesson({ levelId, lessonId, onExit }) {
  mount(spinner());

  const loaded = await loadLesson(levelId, lessonId);
  if (!loaded) {
    mount(el('div', { class: 'card' },
      el('h2', { text: 'Lesson not found.' }),
      el('button', { class: 'btn', style: 'margin-top:16px', onclick: onExit }, 'Back')));
    return;
  }

  const { node, lesson } = loaded;
  const stats = questionStatsFor(lessonId);
  const sessionSize = Math.min(10, lesson.questions.length);

  const session = {
    questions: selectQuestions(lesson.questions, stats, sessionSize),
    index: 0,
    grade: null,
    pending: undefined,        // the answer the learner has staged, shape varies by type
    attempts: [],              // every submission — per-question history
    firstAttempts: new Map(),  // questionId -> first outcome; this is what scores the run
    retryQueue: [],
    alreadyRetried: new Set(),
    checking: false,           // a writing answer is out at the grammar checker
    startedAt: Date.now(),
  };

  const current = () => session.questions[session.index];

  function queueRetry(q) {
    // One retry per question. Without the cap, missing the same item again on its
    // retry pass re-queues it and the run can never reach the end.
    if (session.alreadyRetried.has(q.id)) return;
    if (session.retryQueue.some((x) => x.id === q.id)) return;
    session.retryQueue.push(q);
  }

  async function submit() {
    const q = current();
    if (!q || session.grade || session.checking) return;

    let grade = gradeAnswer(q, session.pending);

    // Writing is the one type whose correctness needs more than string matching.
    // The local grade has already confirmed the task's required words are there;
    // LanguageTool decides whether what surrounds them is actual German.
    if (q.type === 'WRITE' && grade.correct) {
      session.checking = true;
      render();
      grade = await gradeWritingGrammar(q, String(session.pending ?? ''), grade);
      session.checking = false;
    }

    session.attempts.push([q.id, grade.correct]);
    if (!session.firstAttempts.has(q.id)) session.firstAttempts.set(q.id, grade.correct);
    if (!grade.correct) queueRetry(q);
    session.grade = grade;
    render();
  }

  async function gradeWritingGrammar(q, text, localGrade) {
    const { checked, issues } = await checkGerman(text);
    if (!checked) {
      return { ...localGrade, note: 'Grammar check unavailable — marked on the required words only.' };
    }
    const failing = issues.filter((i) => i.fails);
    if (failing.length) {
      return {
        correct: false,
        score: 0,
        expected: localGrade.expected,
        note: `${describeIssues(failing)}`,
      };
    }
    const advisory = issues.length ? `  Also worth a look — ${describeIssues(issues)}` : '';
    return { ...localGrade, note: `Grammar checks out.${advisory}` };
  }

  function skip() {
    const q = current();
    if (!q || session.grade) return;
    session.attempts.push([q.id, false]);
    if (!session.firstAttempts.has(q.id)) session.firstAttempts.set(q.id, false);
    queueRetry(q);
    session.grade = { correct: false, expected: expectedFor(q), note: 'Skipped.', score: 0 };
    render();
  }

  function advance() {
    if (!session.grade) return;
    stopSpeaking();
    const atEnd = session.index >= session.questions.length - 1;
    if (atEnd && session.retryQueue.length) {
      for (const q of session.retryQueue) session.alreadyRetried.add(q.id);
      session.questions = session.questions.concat(session.retryQueue);
      session.retryQueue = [];
    } else if (atEnd) {
      finish();
      return;
    }
    session.index += 1;
    session.grade = null;
    session.pending = undefined;
    render();
    autoPlay();
  }

  function finish() {
    const result = recordSession({
      lessonId: lesson.id,
      lessonTitle: lesson.title,
      kind: lesson.kind,
      attempts: session.attempts,
      firstAttempts: [...session.firstAttempts.values()],
      durationMs: Date.now() - session.startedAt,
    });
    renderResult(result);
  }

  function autoPlay() {
    const q = current();
    if (q && (q.type === 'LISTEN_TYPE' || q.type === 'LISTEN_CHOICE')) speak(speechTextOf(q));
  }

  // --- question bodies ---------------------------------------------------

  function promptBubble(q, { speakable = true } = {}) {
    if (!q.prompt) return null;
    return el('div', { class: 'prompt-row' },
      speakable
        ? el('button', {
            class: 'speak-btn', title: 'Play audio', 'aria-label': 'Play audio',
            onclick: () => speak(q.prompt.replace('___', '…')),
          }, '🔊')
        : null,
      el('div', { class: 'grow' },
        el('div', { class: 'prompt-bubble', text: q.prompt }),
        q.hint ? el('div', { class: 'hint', text: q.hint }) : null));
  }

  function choiceBody(q, { showPrompt = true } = {}) {
    const locked = !!session.grade;
    return el('div', {},
      showPrompt ? promptBubble(q) : null,
      el('div', { class: 'choices' },
        (q.options ?? []).map((option, i) => {
          const classes = ['choice'];
          if (locked && i === q.answerIndex) classes.push('choice--correct');
          else if (locked && i === session.pending) classes.push('choice--wrong');
          else if (!locked && i === session.pending) classes.push('choice--selected');
          return el('button', {
            class: classes.join(' '),
            disabled: locked,
            onclick: () => { session.pending = i; render(); },
          }, option);
        })),
      q.type === 'ARTICLE' && q.hint ? el('div', { class: 'hint', text: q.hint }) : null);
  }

  function audioControls(q) {
    return el('div', { class: 'audio-controls' },
      el('button', { class: 'audio-big', title: 'Play', 'aria-label': 'Play audio',
        onclick: () => speak(speechTextOf(q)) }, '🔊'),
      el('button', { class: 'audio-slow', title: 'Play slowly', 'aria-label': 'Play slowly',
        onclick: () => speak(speechTextOf(q), { rate: SLOW_RATE }) }, '🐢'));
  }

  function textBody(q, { placeholder, withPrompt = true, audio = false }) {
    const input = el('input', {
      class: 'text-input', type: 'text', placeholder,
      autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false',
      value: typeof session.pending === 'string' ? session.pending : '',
      disabled: !!session.grade,
      oninput: (e) => { session.pending = e.target.value; syncFooter(); },
      onkeydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (session.grade) advance(); else if (canSubmit()) submit();
      },
    });
    return el('div', {},
      audio ? audioControls(q) : null,
      audio ? el('div', { style: 'height:24px' }) : null,
      withPrompt ? promptBubble(q, { speakable: q.type === 'FILL_BLANK' }) : null,
      input,
      umlautRow(() => input));
  }

  function wordBankBody(q) {
    const locked = !!session.grade;
    const chosen = Array.isArray(session.pending) ? session.pending : [];
    // Track indices, not strings: a sentence can legitimately repeat a token.
    if (!q._shuffledBank) {
      q._shuffledBank = shuffle((q.tokens ?? []).map((t, i) => ({ i, t })));
    }
    const setChosen = (next) => { session.pending = next.length ? next : undefined; render(); };

    return el('div', {},
      promptBubble(q, { speakable: false }),
      el('div', { class: 'answer-area' },
        chosen.map((tokenIndex, position) =>
          el('button', {
            class: 'chip', disabled: locked,
            onclick: () => setChosen(chosen.filter((_, p) => p !== position)),
          }, q.tokens[tokenIndex]))),
      el('div', { class: 'bank' },
        q._shuffledBank.map(({ i, t }) => {
          const used = chosen.includes(i);
          return el('button', {
            class: `chip${used ? ' chip--used' : ''}`,
            disabled: locked || used,
            'aria-hidden': used ? 'true' : null,
            onclick: () => setChosen(chosen.concat(i)),
          }, t);
        })));
  }

  function writeBody(q) {
    const area = el('textarea', {
      class: 'text-area', placeholder: 'Write in German here…',
      autocapitalize: 'sentences', spellcheck: 'false',
      disabled: !!session.grade,
      oninput: (e) => { session.pending = e.target.value; syncFooter(); },
    });
    if (typeof session.pending === 'string') area.value = session.pending;
    return el('div', {},
      promptBubble(q, { speakable: false }),
      q.mustInclude?.length
        ? el('div', { class: 'hint', style: 'color:var(--macaw)', text: `Use: ${q.mustInclude.join(', ')}` })
        : null,
      el('div', { style: 'height:12px' }),
      area,
      umlautRow(() => area));
  }

  /**
   * Speaking is the one type whose answer the learner cannot type, so the only
   * thing that may stage an answer here is a transcript from the recognizer.
   * There used to be a "Mark as spoken" button that staged `target` itself —
   * which the grader then compared against `target` and always passed, so the
   * exercise could be cleared without saying a word. Use Skip instead: it is
   * honest about not having answered.
   */
  function speakBody(q) {
    const target = q.targetText || q.prompt || '';
    const available = recognitionAvailable();
    const status = el('div', { class: 'muted small center', text: available
      ? 'Tap the mic and say it'
      : 'Speech recognition needs Chrome or Edge. Skip this one, or open the site there.' });
    const mic = el('button', {
      class: 'mic', title: 'Start recording', 'aria-label': 'Start recording',
      disabled: !available,
    }, '🎤');

    let recognizer = null;
    mic.addEventListener('click', () => {
      if (session.grade) return;
      if (recognizer) { recognizer.stop(); recognizer = null; return; }

      // A fresh attempt invalidates the previous transcript — otherwise a failed
      // retry silently submits whatever the recognizer heard last time.
      session.pending = undefined;
      syncFooter();

      mic.classList.add('mic--listening');
      status.textContent = 'Listening…';
      recognizer = startListening({
        onResult: (transcript) => {
          session.pending = transcript;
          status.textContent = `“${transcript}” — tap Check, or the mic to try again`;
          syncFooter();
        },
        onError: (err) => { status.textContent = err.message; syncFooter(); },
        onEnd: () => { mic.classList.remove('mic--listening'); recognizer = null; },
      });
      if (!recognizer) mic.classList.remove('mic--listening');
    });

    return el('div', {},
      promptBubble({ ...q, prompt: target, hint: q.hint }),
      el('div', { class: 'mic-wrap' }, mic, status));
  }

  function matchBody(q) {
    const locked = !!session.grade;
    const mapping = (session.pending && typeof session.pending === 'object' && !Array.isArray(session.pending))
      ? session.pending : {};
    if (!q._shuffledRight) q._shuffledRight = shuffle(q.right ?? []);
    let activeLeft = q._activeLeft ?? null;

    const matchedRight = new Set(Object.values(mapping));

    return el('div', {},
      el('div', { class: 'match-cols' },
        el('div', { class: 'choices' },
          (q.left ?? []).map((item) => {
            const done = item in mapping;
            const classes = ['choice'];
            if (done) classes.push('choice--correct');
            else if (activeLeft === item) classes.push('choice--selected');
            return el('button', {
              class: classes.join(' '), disabled: locked || done,
              onclick: () => { q._activeLeft = item; render(); },
            }, item);
          })),
        el('div', { class: 'choices' },
          q._shuffledRight.map((item) => {
            const done = matchedRight.has(item);
            return el('button', {
              class: `choice${done ? ' choice--correct' : ''}`,
              disabled: locked || done,
              onclick: () => {
                if (!activeLeft) { toast('Pick an item on the left first.'); return; }
                session.pending = { ...mapping, [activeLeft]: item };
                q._activeLeft = null;
                render();
              },
            }, item);
          }))),
      Object.keys(mapping).length && !locked
        ? el('button', {
            class: 'btn btn--ghost', style: 'margin-top:12px',
            onclick: () => { session.pending = undefined; q._activeLeft = null; render(); },
          }, 'Reset')
        : null,
      el('div', { class: 'small muted', style: 'margin-top:8px', text: 'Tap left, then right.' }));
  }

  function body(q) {
    switch (q.type) {
      case 'MULTIPLE_CHOICE':
      case 'ARTICLE': return choiceBody(q);
      case 'LISTEN_CHOICE': return el('div', {}, audioControls(q),
        el('div', { style: 'height:24px' }), choiceBody(q, { showPrompt: false }));
      case 'FILL_BLANK': return textBody(q, { placeholder: 'Missing word' });
      case 'TRANSLATE': return textBody(q, { placeholder: 'Your answer' });
      case 'LISTEN_TYPE': return textBody(q, { placeholder: 'Type what you hear', withPrompt: false, audio: true });
      case 'WORD_BANK': return wordBankBody(q);
      case 'WRITE': return writeBody(q);
      case 'SPEAK': return speakBody(q);
      case 'MATCH': return matchBody(q);
      default: return el('div', { text: `Unsupported question type: ${q.type}` });
    }
  }

  // --- footer ------------------------------------------------------------

  function canSubmit() {
    const q = current();
    if (!q) return false;
    const p = session.pending;
    if (p === undefined || p === null) return false;
    if (typeof p === 'string') return p.trim().length > 0;
    if (Array.isArray(p)) return p.length > 0;
    if (typeof p === 'object') return Object.keys(p).length > 0;
    if (typeof p === 'number') return p >= 0;
    return true;
  }

  /** Cheap update so typing does not re-render the whole question. */
  function syncFooter() {
    const check = document.getElementById('check-btn');
    if (check) check.disabled = !canSubmit();
  }

  function footer() {
    if (session.grade) {
      const g = session.grade;
      const q = current();
      return el('div', { class: `footer footer--${g.correct ? 'correct' : 'wrong'}` },
        el('p', { class: 'feedback-title', text: g.correct ? 'Correct!' : 'Not quite' }),
        !g.correct && g.expected
          ? el('p', { class: 'feedback-body', text: `Correct answer: ${g.expected}` })
          : null,
        g.note ? el('p', { class: 'feedback-body', text: g.note }) : null,
        q?.explanation ? el('p', { class: 'feedback-body', text: q.explanation }) : null,
        el('button', {
          class: `btn ${g.correct ? '' : 'btn--red'}`, id: 'continue-btn', onclick: advance,
        }, 'Continue'));
    }
    return el('div', { class: 'footer' },
      el('div', { class: 'row' },
        el('button', {
          class: 'btn btn--ghost', style: 'flex:1',
          disabled: session.checking, onclick: skip,
        }, 'Skip'),
        el('button', {
          class: 'btn', style: 'flex:1.4', id: 'check-btn',
          disabled: !canSubmit() || session.checking, onclick: submit,
        }, session.checking ? 'Checking your German…' : 'Check')));
  }

  // --- render ------------------------------------------------------------

  function render() {
    const q = current();
    if (!q) { finish(); return; }
    const done = session.index;
    const total = session.questions.length;

    mount(
      el('div', { class: 'lesson-top' },
        el('button', { class: 'quit', title: 'Quit lesson', 'aria-label': 'Quit lesson',
          onclick: () => { stopSpeaking(); onExit(); } }, '✕'),
        el('div', { class: 'progress grow' },
          el('div', { style: `width:${total ? (done / total) * 100 : 0}%` })),
        el('div', { class: 'small muted', text: `${done + 1}/${total}` })),
      el('h1', { class: 'instruction', text: INSTRUCTION[q.type] ?? 'Answer' }),
      body(q),
      footer());

    if (session.grade) document.getElementById('continue-btn')?.focus();
  }

  function renderResult(result) {
    const pct = result.total ? Math.round((result.correct / result.total) * 100) : 0;
    mount(el('div', { class: 'result' },
      el('h1', { text: pct >= 80 ? 'Great job!' : 'Keep practising!' }),
      el('p', { class: 'muted', text: lesson.title }),
      el('div', { class: 'stat-row' },
        statCard('XP', `+${result.xpEarned}`, 'var(--bee)'),
        statCard('Accuracy', `${pct}%`, 'var(--feather-green)'),
        statCard('Streak', String(result.streakDays), 'var(--fox)')),
      result.crownEarned
        ? el('p', { style: 'color:var(--bee);font-weight:800',
            text: `👑 Crown ${result.newCrownLevel} of ${MAX_CROWNS}!` })
        : el('p', { class: 'muted small',
            text: `${result.pct}% on first attempts — 80% or better earns a crown.` }),
      result.dailyGoalMet ? el('p', { style: 'color:var(--feather-green)', text: 'Daily goal reached 🎉' }) : null,
      el('div', { style: 'width:100%;display:grid;gap:12px' },
        el('button', { class: 'btn', onclick: onExit }, 'Continue'),
        el('button', { class: 'btn btn--ghost', onclick: () => startLesson({ levelId, lessonId, onExit }) },
          'Practise again'))));
  }

  const statCard = (cap, val, colour) =>
    el('div', { class: 'stat-card' },
      el('div', { class: 'cap', style: `background:${colour}`, text: cap }),
      el('div', { class: 'val', style: `color:${colour}`, text: val }));

  if ((lesson.kind === 'LISTENING' || lesson.questions.some((q) => q.type?.startsWith('LISTEN')))
      && !germanVoiceAvailable()) {
    toast('No German voice found in this browser — listening audio may sound off.');
  }

  render();
  autoPlay();
}
