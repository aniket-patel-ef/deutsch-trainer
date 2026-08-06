// The learning path. Mirrors ui/tree/TreeScreen.kt: nodes snake left and right
// down the page, grouped under a coloured banner per Abschnitt, with a segmented
// crown ring and a count badge so progress is countable rather than inferred.

import { el, mount, spinner } from './dom.js';
import { lessonNodes, levels } from './content.js';
import { MAX_CROWNS, crownsFor, lessonProgress } from './storage.js';

const KIND_ICON = { GRAMMAR: '✓', LISTENING: '🎧', SPEAKING: '🎤', WRITING: '✍️' };
const KIND_CLASS = { LISTENING: 'node--listening', SPEAKING: 'node--speaking', WRITING: 'node--writing' };

const SECTION_COLOURS = [
  'var(--feather-green)', 'var(--macaw)', 'var(--beetle)',
  'var(--fox)', 'var(--humpback)', 'var(--green-shadow)',
];
const sectionColour = (lektionNumber) => SECTION_COLOURS[lektionNumber % SECTION_COLOURS.length];

/**
 * A lesson opens once the one before it has at least one crown. The first lesson
 * of a level is always open, and every lesson stays replayable forever.
 */
function computeStates(nodes) {
  const states = new Map();
  let previousUnlocksNext = true;
  for (const node of nodes) {
    const crowns = crownsFor(node.meta.id);
    const state = crowns >= MAX_CROWNS ? 'mastered'
      : crowns > 0 ? 'inProgress'
      : previousUnlocksNext ? 'available'
      : 'locked';
    states.set(node.meta.id, state);
    previousUnlocksNext = crowns > 0;
  }
  return states;
}

/** Five separate arcs rather than one sweeping arc, so each crown is countable. */
function crownRing(crowns, locked) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 92 92');
  svg.setAttribute('aria-hidden', 'true');
  if (locked) return svg;

  const r = 42, cx = 46, cy = 46;
  const segment = 360 / MAX_CROWNS;
  const gap = 7;

  for (let i = 0; i < MAX_CROWNS; i++) {
    const start = -90 + i * segment + gap / 2;
    const end = -90 + (i + 1) * segment - gap / 2;
    const toXY = (deg) => {
      const rad = (deg * Math.PI) / 180;
      return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
    };
    const [x1, y1] = toXY(start);
    const [x2, y2] = toXY(end);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-width', '8');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke', i < crowns ? 'var(--bee)' : 'color-mix(in srgb, var(--bee) 18%, transparent)');
    svg.append(path);
  }
  return svg;
}

function pathNode(node, state, index, onOpen) {
  const crowns = crownsFor(node.meta.id);
  const locked = state === 'locked';
  const mastered = state === 'mastered';

  // Four nodes complete one full S-curve, same as the Android tree.
  const offset = Math.sin(index * (Math.PI / 2)) * 62;

  const classes = ['node'];
  if (mastered) classes.push('node--mastered');
  else if (KIND_CLASS[node.meta.kind]) classes.push(KIND_CLASS[node.meta.kind]);

  const icon = locked ? '🔒' : mastered ? '★' : (KIND_ICON[node.meta.kind] ?? '✓');
  const p = lessonProgress(node.meta.id);
  const label = `${node.meta.title}${locked ? ' (locked)' : ''}`;

  return el('div', { class: 'node-wrap' },
    el('div', { class: 'node-ring', style: `transform: translateX(${offset}px)` },
      crownRing(crowns, locked),
      el('button', {
        class: classes.join(' '),
        disabled: locked,
        title: locked ? 'Earn a crown on the previous lesson to unlock this' : label,
        'aria-label': `${label}. ${crowns} of ${MAX_CROWNS} crowns.`,
        onclick: () => onOpen(node),
      }, icon),
      crowns > 0 && !locked ? el('span', { class: 'crown-badge', 'aria-hidden': 'true', text: String(crowns) }) : null),
    el('div', {
      class: `node-label${locked ? ' node-label--locked' : ''}`,
      style: `transform: translateX(${offset}px)`,
      text: node.meta.title,
    }),
    p.completions > 0
      ? el('div', {
          class: 'small muted',
          style: `transform: translateX(${offset}px)`,
          text: `${p.completions} run${p.completions === 1 ? '' : 's'} · best ${p.bestScorePct}%`,
        })
      : null);
}

export async function renderTree({ levelId = 'a1', onOpenLesson, onOpenGrammar }) {
  mount(spinner());

  let nodes, levelList;
  try {
    [nodes, levelList] = await Promise.all([lessonNodes(levelId), levels()]);
  } catch (err) {
    mount(el('div', { class: 'card' },
      el('h2', { text: 'Could not load the course content.' }),
      el('p', { class: 'muted', text: err.message })));
    return;
  }

  const states = computeStates(nodes);

  // Group into sections, preserving the order the path renders them in.
  const sections = [];
  for (const node of nodes) {
    let last = sections[sections.length - 1];
    if (!last || last.sectionId !== node.sectionId) {
      last = {
        sectionId: node.sectionId,
        code: node.sectionCode,
        title: node.sectionTitle,
        lektionNumber: node.lektionNumber,
        lektionTitle: node.lektionTitle,
        nodes: [],
      };
      sections.push(last);
    }
    last.nodes.push(node);
  }

  const totalCrowns = nodes.reduce((sum, n) => sum + crownsFor(n.meta.id), 0);
  const possible = nodes.length * MAX_CROWNS;

  const blocks = [];
  const level = levelList.find((l) => l.id === levelId);

  blocks.push(el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('div', { class: 'grow' },
        el('div', { class: 'small muted', text: `Level ${level?.title ?? levelId} · ${nodes.length} lessons` }),
        el('div', { style: 'font-size:19px;font-weight:800', text: `${totalCrowns} / ${possible} crowns` })),
      el('div', { style: 'font-size:26px' }, '👑')),
    el('div', { class: 'progress progress--gold', style: 'margin-top:12px' },
      el('div', { style: `width:${possible ? (totalCrowns / possible) * 100 : 0}%` }))));

  let lastLektion = -1;
  for (const section of sections) {
    if (section.lektionNumber !== lastLektion) {
      blocks.push(el('div', { class: 'lektion-divider', text: section.lektionTitle }));
      lastLektion = section.lektionNumber;
    }

    const earned = section.nodes.reduce((s, n) => s + crownsFor(n.meta.id), 0);

    blocks.push(el('div', { class: 'section-banner', style: `background:${sectionColour(section.lektionNumber)}` },
      el('div', { class: 'grow' },
        el('div', { class: 'label', text: `${section.lektionTitle} · Section ${section.code.replace(/\.$/, '')}` }),
        el('h2', { text: section.title })),
      el('button', {
        title: 'View grammar notes',
        'aria-label': `Grammar notes for ${section.title}`,
        onclick: () => onOpenGrammar(levelId, section.sectionId),
      }, '🎓')));

    blocks.push(el('div', { class: 'small muted', style: 'margin:6px 0 0 4px',
      text: `${earned} / ${section.nodes.length * MAX_CROWNS} crowns` }));

    blocks.push(el('div', { class: 'path' },
      section.nodes.map((node, i) => pathNode(node, states.get(node.meta.id), i, onOpenLesson))));
  }

  mount(blocks);
}
