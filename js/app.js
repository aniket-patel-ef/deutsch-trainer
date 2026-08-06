// Router and bootstrap. Screens are hash-routed so the back button works and a
// lesson can be linked to directly.

import { toast } from './dom.js';
import { renderTree } from './tree.js';
import { startLesson } from './lesson.js';
import { renderGrammar } from './grammar.js';
import { renderProfile } from './profile.js';
import { renderVocabHub, startVocabDrill } from './vocab.js';
import { stopSpeaking } from './speech.js';

const nav = document.getElementById('nav');
const LEVEL = 'a1';

const go = (hash) => { window.location.hash = hash; };

function setTab(tab) {
  nav.hidden = !tab;
  for (const button of nav.querySelectorAll('button')) {
    if (tab && button.dataset.tab === tab) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  document.getElementById('screen').classList.toggle('screen--immersive', !tab);
}

async function route() {
  stopSpeaking();
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [screen, a, b] = hash.split('/').map(decodeURIComponent);

  try {
    switch (screen) {
      case 'lesson':
        setTab(null);
        await startLesson({ levelId: a || LEVEL, lessonId: b, onExit: () => go('#/learn') });
        return;

      case 'grammar':
        setTab(null);
        await renderGrammar({
          levelId: a || LEVEL,
          sectionId: b,
          onBack: () => go('#/learn'),
          onOpenLesson: (levelId, lessonId) => go(`#/lesson/${levelId}/${lessonId}`),
        });
        return;

      case 'drill':
        setTab(null);
        await startVocabDrill({ drill: a, onExit: () => go('#/words') });
        return;

      case 'words':
        setTab('words');
        await renderVocabHub({ onStartDrill: (drill) => go(`#/drill/${drill}`) });
        return;

      case 'profile':
        setTab('profile');
        renderProfile({ onChanged: () => route() });
        return;

      case 'learn':
      default:
        setTab('learn');
        await renderTree({
          levelId: LEVEL,
          onOpenLesson: (node) => go(`#/lesson/${node.levelId}/${node.meta.id}`),
          onOpenGrammar: (levelId, sectionId) => go(`#/grammar/${levelId}/${sectionId}`),
        });
    }
  } catch (err) {
    console.error(err);
    toast(err.message || 'Something went wrong.');
  }
}

nav.addEventListener('click', (event) => {
  const tab = event.target.closest('button')?.dataset.tab;
  if (tab) go(`#/${tab}`);
});

window.addEventListener('hashchange', route);

if (!window.location.hash) window.location.replace('#/learn');
route();
