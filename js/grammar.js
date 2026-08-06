// The grammar reference for one Abschnitt, lifted from the same notes the Android
// app renders. Minimal markdown: ## headings, | tables, - bullets, `code`.

import { el, mount, spinner } from './dom.js';
import { loadSection } from './content.js';

function renderNotes(text) {
  const out = [];
  const lines = text.split('\n');
  let table = null;
  let list = null;

  const flushTable = () => {
    if (!table) return;
    const wrap = el('div', { class: 'table-scroll' }, table);
    out.push(wrap);
    table = null;
  };
  const flushList = () => { if (list) { out.push(list); list = null; } };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.startsWith('| ')) {
      flushList();
      const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      // Skip the |---|---| separator row.
      if (cells.every((c) => !c || /^[-:]+$/.test(c))) continue;
      if (!table) {
        table = el('table');
        table.append(el('tr', {}, cells.map((c) => el('th', { text: c }))));
      } else {
        table.append(el('tr', {}, cells.map((c) => el('td', { text: c }))));
      }
      continue;
    }
    flushTable();

    if (!line.trim()) { flushList(); continue; }

    if (line.startsWith('## ')) {
      flushList();
      out.push(el('h3', { text: line.slice(3) }));
      continue;
    }
    if (line.startsWith('- ')) {
      if (!list) list = el('ul');
      list.append(el('li', { html: inline(line.slice(2)) }));
      continue;
    }
    flushList();
    out.push(el('p', { html: inline(line) }));
  }
  flushTable();
  flushList();
  return out;
}

/** **bold** and `code`, escaped first so content can never inject markup. */
function inline(text) {
  const escaped = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

export async function renderGrammar({ levelId, sectionId, onBack, onOpenLesson }) {
  mount(spinner());
  const section = await loadSection(levelId, sectionId);
  if (!section) {
    mount(el('div', { class: 'card' },
      el('p', { text: 'No grammar notes found.' }),
      el('button', { class: 'btn', style: 'margin-top:12px', onclick: onBack }, 'Back')));
    return;
  }

  mount(
    el('div', { class: 'row', style: 'margin-bottom:8px' },
      el('button', { class: 'quit', style: 'border:0;background:none;font-size:22px;color:var(--muted)',
        'aria-label': 'Back', onclick: onBack }, '←'),
      el('h1', { style: 'font-size:20px;margin:0', text: `${section.code} ${section.title}` })),
    el('div', { class: 'grammar' }, renderNotes(section.grammarNotes || '')),
    el('h3', { style: 'color:var(--text);font-size:17px;margin-top:24px', text: 'Lessons in this section' }),
    el('div', { style: 'display:grid;gap:8px' },
      section.lessons.map((lesson) =>
        el('button', {
          class: 'card-btn', style: 'padding:12px 14px',
          onclick: () => onOpenLesson(levelId, lesson.id),
        },
        el('div', { class: 'grow' },
          el('div', { text: lesson.title }),
          el('div', { class: 'small muted', text: `${lesson.questions.length} questions in the pool` })),
        el('div', { class: 'muted' }, '›')))),
    el('button', { class: 'btn btn--ghost', style: 'margin-top:20px', onclick: onBack }, 'Back to the path'));
}
