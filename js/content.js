// Mirrors data/content/ContentRepository.kt: the tree reads a 20 KB structure
// index, and a lesson's 50-question bank is fetched from its Lektion file only
// when that lesson is opened. Loading everything up front would mean pulling
// 1.8 MB before the first screen appears.

const BASE = new URL('.', import.meta.url).href.replace(/js\/$/, '');

let indexCache = null;
const lektionCache = new Map();
const nodeCache = new Map();

async function getJson(path) {
  const res = await fetch(BASE + path, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
  return res.json();
}

export async function contentIndex() {
  if (!indexCache) indexCache = await getJson('content/index.json');
  return indexCache;
}

export async function levels() {
  return (await contentIndex()).levels.slice().sort((a, b) => a.order - b.order);
}

/** Flattened lesson list for a level, in the order the path renders them. */
export async function lessonNodes(levelId) {
  if (nodeCache.has(levelId)) return nodeCache.get(levelId);

  const level = (await contentIndex()).levels.find((l) => l.id === levelId);
  if (!level) return [];

  const out = [];
  let position = 0;
  for (const lektion of level.lektionen.slice().sort((a, b) => a.number - b.number)) {
    for (const section of lektion.sections) {
      for (const lesson of section.lessons) {
        out.push({
          meta: lesson,
          sectionId: section.id,
          sectionTitle: section.title,
          sectionCode: section.code,
          lektionId: lektion.id,
          lektionNumber: lektion.number,
          lektionTitle: lektion.title,
          levelId,
          indexInLevel: position++,
        });
      }
    }
  }
  nodeCache.set(levelId, out);
  return out;
}

async function lektion(levelId, lektionId) {
  const level = (await contentIndex()).levels.find((l) => l.id === levelId);
  const ref = level?.lektionen.find((l) => l.id === lektionId);
  if (!ref) return null;
  if (!lektionCache.has(ref.file)) {
    lektionCache.set(ref.file, await getJson(ref.file));
  }
  return lektionCache.get(ref.file);
}

/** Node plus its full question bank, for the session player. */
export async function loadLesson(levelId, lessonId) {
  const nodes = await lessonNodes(levelId);
  const node = nodes.find((n) => n.meta.id === lessonId);
  if (!node) return null;
  const lek = await lektion(levelId, node.lektionId);
  const lesson = lek?.sections.flatMap((s) => s.lessons).find((l) => l.id === lessonId);
  return lesson ? { node, lesson } : null;
}

/** Full section including grammar notes, for the reference screen. */
export async function loadSection(levelId, sectionId) {
  const nodes = await lessonNodes(levelId);
  const node = nodes.find((n) => n.sectionId === sectionId);
  if (!node) return null;
  const lek = await lektion(levelId, node.lektionId);
  return lek?.sections.find((s) => s.id === sectionId) ?? null;
}

let vocabCache = null;

export async function vocabBank() {
  if (!vocabCache) {
    const raw = await getJson('vocab/vocab_de_10k.json');
    vocabCache = raw.map((e) => ({
      id: e.i,
      german: e.w,
      article: e.a || '',
      english: e.e,
      plural: e.p || '',
      pos: e.pos || 'noun',
      topic: e.t || 'allgemein',
      rank: e.i,
      concrete: e.c === 1,
      emoji: e.em || '',
    }));
  }
  return vocabCache;
}
