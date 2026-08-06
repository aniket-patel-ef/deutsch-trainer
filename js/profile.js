// Stats, daily goal, and progress import/export. The browser build keeps progress
// in localStorage, so the export file is the portable equivalent of Drive sync.

import { el, mount, toast } from './dom.js';
import { exportJson, importJson, resetAll, setDailyGoal, snapshot, userStats, vocabTotals } from './storage.js';
import { MAX_CROWNS } from './engine.js';
import { germanVoiceAvailable, recognitionAvailable } from './speech.js';

export function renderProfile({ onChanged }) {
  const stats = userStats();
  const totals = vocabTotals();
  const state = snapshot();
  const lessonsWithCrowns = Object.values(state.lessons).filter((l) => l.crownLevel > 0).length;
  const totalCrowns = Object.values(state.lessons).reduce((s, l) => s + l.crownLevel, 0);
  const goalPct = stats.dailyGoalXp ? Math.min(100, (stats.todayXp / stats.dailyGoalXp) * 100) : 0;

  const bigStat = (value, label, colour, icon) =>
    el('div', { class: 'card', style: 'display:flex;gap:10px;align-items:center;margin:0' },
      el('div', { style: `font-size:24px;color:${colour}` }, icon),
      el('div', {},
        el('div', { style: 'font-size:19px;font-weight:800', text: value }),
        el('div', { class: 'small muted', text: label })));

  mount(
    el('h1', { class: 'page-title', text: 'Profile' }),
    el('p', { class: 'muted', style: 'margin:0 0 20px',
      text: 'Progress is saved in this browser.' }),

    el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('div', { class: 'grow', style: 'font-weight:800', text: 'Daily goal' }),
        el('div', { style: 'color:var(--bee);font-weight:800',
          text: `${stats.todayXp} / ${stats.dailyGoalXp} XP` })),
      el('div', { class: 'progress progress--gold', style: 'margin-top:10px' },
        el('div', { style: `width:${goalPct}%` })),
      el('div', { class: 'row', style: 'margin-top:14px;gap:8px' },
        [20, 50, 100, 200].map((goal) =>
          el('button', {
            class: 'btn btn--ghost',
            style: `flex:1;padding:9px 0;${goal === stats.dailyGoalXp
              ? 'background:var(--bee);color:#fff;border-color:var(--bee-shadow)' : ''}`,
            onclick: () => { setDailyGoal(goal); onChanged(); },
          }, String(goal))))),

    el('h2', { style: 'font-size:19px;margin:24px 0 12px', text: 'Statistics' }),
    el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px' },
      bigStat(String(stats.streakDays), 'day streak', 'var(--fox)', '🔥'),
      bigStat(String(stats.xp), 'total XP', 'var(--bee)', '⚡'),
      bigStat(String(stats.lessonsCompleted), 'runs completed', 'var(--feather-green)', '✅'),
      bigStat(`${totalCrowns}`, 'crowns earned', 'var(--bee)', '👑'),
      bigStat(String(lessonsWithCrowns), 'lessons started', 'var(--macaw)', '🎓'),
      bigStat(String(totals.practiced), 'words practised', 'var(--beetle)', '🗂️')),

    el('h2', { style: 'font-size:19px;margin:24px 0 12px', text: 'Backup' }),
    el('div', { class: 'card' },
      el('p', { class: 'small muted', style: 'margin:0 0 12px',
        text: 'Progress lives in this browser only. Export a file to move it to another '
          + 'device, or to keep a copy before clearing site data.' }),
      el('div', { class: 'row row--wrap' },
        el('button', { class: 'btn btn--inline btn--blue', onclick: doExport }, 'Export progress'),
        el('button', { class: 'btn btn--inline btn--ghost', onclick: doImport }, 'Import progress'))),

    el('h2', { style: 'font-size:19px;margin:24px 0 12px', text: 'This browser' }),
    el('div', { class: 'card' },
      el('p', { class: 'small', style: 'margin:0 0 6px',
        text: `German voice for listening: ${germanVoiceAvailable() ? 'available ✓' : 'not found ✗'}` }),
      el('p', { class: 'small', style: 'margin:0',
        text: `Speech recognition for speaking: ${recognitionAvailable() ? 'available ✓' : 'not available ✗ (Chrome or Edge)'}` })),

    el('button', {
      class: 'btn btn--ghost', style: 'margin-top:24px;color:var(--cardinal)',
      onclick: () => {
        if (!confirm('Erase all progress in this browser? This cannot be undone.')) return;
        resetAll();
        toast('Progress cleared.');
        onChanged();
      },
    }, 'Reset all progress'),

    state.sessions.length
      ? el('div', {},
          el('h2', { style: 'font-size:19px;margin:24px 0 12px', text: 'Recent sessions' }),
          state.sessions.slice(0, 15).map((s) => {
            const pct = s.total ? Math.round((s.correct / s.total) * 100) : 0;
            return el('div', { class: 'row', style: 'padding:10px 0;border-bottom:1px solid var(--border)' },
              el('div', { class: 'grow' },
                el('div', { text: s.lessonTitle }),
                el('div', { class: 'small muted', text: `${s.correct}/${s.total} correct · +${s.xpEarned} XP` })),
              el('div', { style: `font-weight:800;color:${pct >= 80 ? 'var(--feather-green)' : 'var(--fox)'}`,
                text: `${pct}%` }));
          }))
      : null);

  function doExport() {
    const blob = new Blob([exportJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    const a = el('a', { href: url, download: `deutsch-trainer-progress-${stamp}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Progress exported.');
  }

  function doImport() {
    const input = el('input', { type: 'file', accept: 'application/json,.json' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        importJson(await file.text());
        toast('Progress imported.');
        onChanged();
      } catch (err) {
        toast(err.message || 'Could not read that file.');
      }
    });
    input.click();
  }
}
