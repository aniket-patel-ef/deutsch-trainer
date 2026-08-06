// Resolves a German noun to a Creative-Commons image on Wikimedia. Same chain as
// data/image/ImageLookupService.kt. `origin=*` is required for anonymous CORS.

const cache = new Map();

async function pageImage(host, title) {
  if (!title) return null;
  const url = `https://${host}/w/api.php?action=query&format=json&formatversion=2`
    + `&prop=pageimages&piprop=thumbnail&pithumbsize=480&redirects=1`
    + `&titles=${encodeURIComponent(title)}&origin=*`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  for (const page of data?.query?.pages ?? []) {
    if (page?.thumbnail?.source) return page.thumbnail.source;
  }
  return null;
}

async function commonsSearch(term) {
  if (!term) return null;
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2'
    + `&generator=search&gsrnamespace=6&gsrlimit=1&gsrsearch=${encodeURIComponent(term)}`
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

/** Returns a thumbnail URL, or null when nothing suitable exists. */
export async function findImage(german, english) {
  const key = german;
  if (cache.has(key)) return cache.get(key);
  let found = null;
  try {
    found = await pageImage('de.wikipedia.org', german)
      ?? await pageImage('en.wikipedia.org', english)
      ?? await commonsSearch(german);
  } catch {
    found = null;   // offline or blocked: the caller falls back to emoji/gloss
  }
  cache.set(key, found);
  return found;
}
