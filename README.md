# Deutsch Trainer — web

A playable browser version of my [Deutsch Trainer](https://github.com/aniket-patel-ef/DeutschTrainer)
Android app: Duolingo-style practice for German A1 grammar.

**▶ [aniket-patel-ef.github.io/deutsch-trainer](https://aniket-patel-ef.github.io/deutsch-trainer/)**

Same content, same rules, same design as the app — 157 lessons, 7,850 questions and
a 10,000-word vocabulary trainer. The interface is in English; only the material you
practise is German.

## What works in the browser

| | |
| --- | --- |
| Learning path | Winding node tree, five crowns per lesson, next lesson unlocks on your first crown |
| Grammar exercises | Multiple choice, fill-in-the-blank, word bank, `der/die/das` picker, free translation |
| Listening | Web Speech synthesis in `de-DE`, normal and slow playback |
| Speaking | Web Speech recognition in `de-DE`, scored on word overlap — **Chrome or Edge only** |
| Writing | Open prompts graded on required elements, one-tap `ä ö ü ß` |
| Vocabulary | 10,000 words, three drills, Leitner scheduling, pictures from Wikimedia |
| Progress | XP, streak, daily goal, crowns — saved in the browser, exportable as JSON |

Firefox and Safari run everything except speaking; the Profile tab reports what your
browser supports.

## How it relates to the app

The content files under `content/` and `vocab/` are copied verbatim from the Android
app's assets, and `js/engine.js` is a direct port of its `engine/` package — question
selection, answer grading and crown scoring behave identically. Progress is the one
difference: the app uses Room plus optional Google Drive backup, the web build uses
`localStorage` plus JSON export/import.

## Running it locally

No build step and no dependencies — it is plain ES modules, so any static server works:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. It has to be served over HTTP rather than opened
as a `file://` path, because ES modules and `fetch` both require an origin.

## Layout

```
index.html          shell: one <main> plus the tab bar
css/styles.css      Duolingo palette and the chunky button treatment
js/app.js           hash router
js/content.js       loads the 20 KB structure index; question banks per Lektion, on demand
js/engine.js        selection, grading and crown scoring, ported from Kotlin
js/storage.js       progress in localStorage, same shape as the app's sync snapshot
js/tree.js          the learning path
js/lesson.js        session player and every question type
js/vocab.js         vocabulary trainer
js/grammar.js       grammar reference
js/profile.js       stats, daily goal, export/import
js/speech.js        Web Speech wrappers
js/images.js        Wikimedia image lookup
```

## Licence and sources

Personal project. Vocabulary is built from the
[TU Chemnitz Ding dictionary](https://ftp.tu-chemnitz.de/pub/Local/urz/ding/de-en/) (GPL)
ranked by [hermitdave/FrequencyWords](https://github.com/hermitdave/FrequencyWords) (MIT).
Images are fetched at runtime from [Wikimedia Commons](https://commons.wikimedia.org/).
Grammar material follows *Deutsch – Aber Hallo! A1* (Hans Witzlinger).
