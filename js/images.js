// Resolves a German noun to a Creative-Commons image on Wikimedia. Same chain as
// data/image/ImageLookupService.kt. `origin=*` is required for anonymous CORS.

const cache = new Map();

async function pageImage(host, title) {
  if (!title) return null;
  const url = `https://${host}/w/api.php?action=query&format=json&formatversion=2`
    + `&prop=pageimages%7Cpageprops&piprop=thumbnail&pithumbsize=480&redirects=1`
    + `&ppprop=disambiguation&titles=${encodeURIComponent(title)}&origin=*`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  for (const page of data?.query?.pages ?? []) {
    // A disambiguation page's lead image illustrates whichever sense is listed
    // first, which is rarely the one being drilled.
    if (page?.pageprops && 'disambiguation' in page.pageprops) continue;
    if (page?.thumbnail?.source) return page.thumbnail.source;
  }
  return null;
}

async function commonsSearch(term) {
  if (!term) return null;
  // intitle + bitmap keeps out diagrams and files that merely mention the word.
  const query = `intitle:${term} filetype:bitmap`;
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2'
    + `&generator=search&gsrnamespace=6&gsrlimit=1&gsrsearch=${encodeURIComponent(query)}`
    + '&prop=imageinfo&iiprop=url&iiurlwidth=480&origin=*';
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  for (const page of data?.query?.pages ?? []) {
    const info = page?.imageinfo?.[0];
    if (info?.thumburl) return info.thumburl;
  }
  return null;
}

/**
 * "brake" out of "to brake, retard (vehicle)" — a Wikipedia title match needs the
 * bare noun, not the whole gloss.
 */
function searchTerm(english) {
  return (english || '')
    .split(/[,;(]/)[0]
    .replace(/^\s*to\s+/i, '')
    .trim();
}

/**
 * Returns a thumbnail URL, or null when nothing suitable exists.
 *
 * The English gloss leads. German article titles are the wrong key: an ambiguous
 * noun resolves to whichever sense German picked first ("Bank" gives a bank
 * building, not a bench) and the many disambiguation pages carry no lead image
 * at all, so two thirds of lookups either missed or illustrated another word.
 */
export async function findImage(german, english) {
  const key = german;
  if (cache.has(key)) return cache.get(key);
  const term = searchTerm(english);
  let found = null;
  try {
    // German comes before Commons: when the English title is ambiguous the
    // German article knows which sense the word has, whereas a Commons search
    // for "trunk" happily returns the Elephant's Trunk Nebula.
    found = await pageImage('en.wikipedia.org', term)
      ?? await pageImage('de.wikipedia.org', german)
      ?? await commonsSearch(term);
  } catch {
    found = null;   // offline or blocked: the caller falls back to emoji/gloss
  }
  cache.set(key, found);
  return found;
}
