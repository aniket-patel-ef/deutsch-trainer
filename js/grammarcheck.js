// German grammar checking for the writing exercises, via the public
// LanguageTool API. Mirrors data/grammar/GrammarCheckService.kt.
//
// Writing used to pass whenever the required words appeared somewhere in the
// answer, so "Berlin wohne ich in nicht" cleared a task about living in Berlin.
// LanguageTool judges agreement, case, spelling and word order properly.
//
// It is a grammar checker, not a comprehension one: it cannot tell whether a
// well-formed sentence answers the question. The required-element and length
// checks in engine.js still carry that half of the judgement.

const ENDPOINT = 'https://api.languagetool.org/v2/check';
const TIMEOUT_MS = 6000;

/**
 * Rule categories that make an answer wrong.
 *
 * Whitespace and typography are deliberately absent: a missing final full stop
 * is worth mentioning, not worth failing a beginner's sentence over.
 */
const FAILING_CATEGORIES = new Set([
  'GRAMMAR', 'TYPOS', 'CASING', 'AGREEMENT', 'IDIOMS', 'CONFUSED_WORDS',
  'COLLOCATIONS', 'SEMANTICS', 'COMPOUNDING',
]);

/** LanguageTool answers in German; the rest of the app is in English. */
const CATEGORY_LABEL = {
  GRAMMAR: 'Grammar',
  TYPOS: 'Spelling',
  CASING: 'Capitalisation',
  AGREEMENT: 'Agreement',
  IDIOMS: 'Word choice',
  CONFUSED_WORDS: 'Word choice',
  COLLOCATIONS: 'Word choice',
  SEMANTICS: 'Meaning',
  COMPOUNDING: 'Compound spelling',
  PUNCTUATION: 'Punctuation',
  TYPOGRAPHY: 'Typography',
  WHITESPACE: 'Spacing',
};

/** True when this browser session has seen the API fail — stops retry stalls. */
let apiReachable = true;

export const grammarCheckAvailable = () => apiReachable;

/**
 * Checks one German sentence or short paragraph.
 *
 * Resolves `{checked: false}` rather than throwing when the API cannot be
 * reached, so the caller can fall back to the offline rules instead of blocking
 * the learner on a network they may not have.
 */
export async function checkGerman(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return { checked: false, issues: [] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const body = new URLSearchParams({
      text: trimmed,
      language: 'de-DE',
      level: 'default',
    });
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      // 429 means the shared endpoint is rate-limiting us, not that the German
      // is fine — the caller must not read this as a pass.
      apiReachable = res.status !== 429;
      return { checked: false, issues: [] };
    }
    const data = await res.json();
    apiReachable = true;
    return { checked: true, issues: (data.matches ?? []).map(toIssue).filter(Boolean) };
  } catch {
    apiReachable = false;
    return { checked: false, issues: [] };
  } finally {
    clearTimeout(timer);
  }
}

function toIssue(match) {
  const categoryId = match.rule?.category?.id ?? '';
  const context = match.context?.text ?? '';
  const snippet = context.slice(match.context?.offset ?? 0,
    (match.context?.offset ?? 0) + (match.context?.length ?? 0));
  const suggestion = match.replacements?.[0]?.value ?? '';
  return {
    label: CATEGORY_LABEL[categoryId] ?? 'Grammar',
    fails: FAILING_CATEGORIES.has(categoryId),
    snippet,
    suggestion,
  };
}

/** One line per issue, e.g. `Spelling: "gross" → "groß"`. */
export function describeIssues(issues, limit = 2) {
  return issues.slice(0, limit).map((i) => {
    const quoted = i.snippet ? `“${i.snippet}”` : '';
    const fix = i.suggestion ? ` → “${i.suggestion}”` : '';
    return `${i.label}: ${quoted}${fix}`.trim();
  }).join('  ·  ');
}
