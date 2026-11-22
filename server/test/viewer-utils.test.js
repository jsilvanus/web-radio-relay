// Viewer page helpers (server/public/viewer/viewer-utils.js). Cases ported from LCYT
// packages/lcyt-web/test/viewer.test.js (resolveViewerText, collectLangTexts), plus the relay's own helpers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveViewerText,
  collectLangTexts,
  splitBreaks,
  languagesOf,
  assetUrl,
  hymnLines,
  parseLang,
  parseFontSize,
  parseTheme,
  isViewerKey,
} from '../public/viewer/viewer-utils.js';

describe('resolveViewerText', () => {
  const data = {
    text: 'Hello original',
    composedText: 'Hello original<br>Hei alkuperäinen',
    translations: {
      'fi-FI': 'Hei alkuperäinen',
      'sv-SE': 'Hej original',
    },
  };

  test('returns composedText when lang is empty string, undefined, or null', () => {
    assert.equal(resolveViewerText(data, ''), data.composedText);
    assert.equal(resolveViewerText(data, undefined), data.composedText);
    assert.equal(resolveViewerText(data, null), data.composedText);
  });

  test('returns original text when lang is "original"', () => {
    assert.equal(resolveViewerText(data, 'original'), data.text);
  });

  test('returns composedText when lang is "all" (caller handles column layout separately)', () => {
    assert.equal(resolveViewerText(data, 'all'), data.composedText);
  });

  test('returns requested translation when it exists', () => {
    assert.equal(resolveViewerText(data, 'fi-FI'), 'Hei alkuperäinen');
    assert.equal(resolveViewerText(data, 'sv-SE'), 'Hej original');
  });

  test('falls back to composedText when translation does not exist', () => {
    assert.equal(resolveViewerText(data, 'de-DE'), data.composedText);
  });

  test('falls back to text when translation and composedText are absent', () => {
    assert.equal(resolveViewerText({ text: 'Raw text only' }, 'fi-FI'), 'Raw text only');
  });

  test('falls back to empty string when all text fields are absent', () => {
    assert.equal(resolveViewerText({}, 'fi-FI'), '');
    assert.equal(resolveViewerText({}, ''), '');
    assert.equal(resolveViewerText({}, 'original'), '');
  });

  test('handles data with no translations object but lang specified', () => {
    const noTrans = { text: 'No trans', composedText: 'No trans' };
    assert.equal(resolveViewerText(noTrans, 'fi-FI'), 'No trans');
  });

  test('returns composedText over text when lang is empty and composedText differs', () => {
    assert.equal(resolveViewerText({ text: 'orig', composedText: 'orig + trans' }, ''), 'orig + trans');
  });
});

describe('collectLangTexts', () => {
  test('returns original text under "original" key', () => {
    const result = collectLangTexts({ text: 'Hello', translations: {} });
    assert.equal(result.original, 'Hello');
  });

  test('includes all translations in the returned map', () => {
    const result = collectLangTexts({
      text: 'Hello',
      translations: { 'fi-FI': 'Hei', 'sv-SE': 'Hej' },
    });
    assert.equal(result.original, 'Hello');
    assert.equal(result['fi-FI'], 'Hei');
    assert.equal(result['sv-SE'], 'Hej');
  });

  test('omits empty/falsy translation values', () => {
    const result = collectLangTexts({
      text: 'Hello',
      translations: { 'fi-FI': '', 'sv-SE': 'Hej' },
    });
    assert.ok(!('fi-FI' in result), 'should not include empty translation');
    assert.equal(result['sv-SE'], 'Hej');
  });

  test('returns just original when translations is missing', () => {
    const result = collectLangTexts({ text: 'Just original' });
    assert.deepEqual(Object.keys(result), ['original']);
    assert.equal(result.original, 'Just original');
  });

  test('returns empty original when text is missing', () => {
    assert.equal(collectLangTexts({}).original, '');
  });

  test('does not include composedText in the language map', () => {
    const result = collectLangTexts({ text: 'orig', composedText: 'orig<br>trans', translations: { 'fi-FI': 'trans' } });
    assert.ok(!('composedText' in result));
  });
});

describe('splitBreaks', () => {
  test('splits on <br>, <br/> and <BR /> alike', () => {
    assert.deepEqual(splitBreaks('a<br>b'), ['a', 'b']);
    assert.deepEqual(splitBreaks('a<br/>b'), ['a', 'b']);
    assert.deepEqual(splitBreaks('a<BR />b'), ['a', 'b']);
    assert.deepEqual(splitBreaks('a<br>b<br>c'), ['a', 'b', 'c']);
  });

  test('text without a break is one part', () => {
    assert.deepEqual(splitBreaks('plain text'), ['plain text']);
    assert.deepEqual(splitBreaks(''), ['']);
  });

  test('other markup is left as literal text, never parsed', () => {
    assert.deepEqual(splitBreaks('<script>x</script><b>y</b>'), ['<script>x</script><b>y</b>']);
  });

  test('non-string input gives one empty part', () => {
    assert.deepEqual(splitBreaks(undefined), ['']);
    assert.deepEqual(splitBreaks(42), ['']);
  });
});

describe('languagesOf', () => {
  test('lists the languages with a non-empty translation', () => {
    assert.deepEqual(languagesOf({ translations: { 'fi-FI': 'Hei', 'sv-SE': '' } }), ['fi-FI']);
  });

  test('empty when there are no translations', () => {
    assert.deepEqual(languagesOf({ text: 'x' }), []);
    assert.deepEqual(languagesOf({ translations: 'nope' }), []);
    assert.deepEqual(languagesOf(null), []);
  });
});

describe('assetUrl', () => {
  const hash = 'a'.repeat(64);

  test('builds the public asset URL for a valid id', () => {
    assert.equal(assetUrl(`${hash}.png`), `/api/assets/${hash}.png`);
    assert.equal(assetUrl(`${hash}.jpg`), `/api/assets/${hash}.jpg`);
    assert.equal(assetUrl(`${hash}.jpeg`), `/api/assets/${hash}.jpeg`);
    assert.equal(assetUrl(`${hash}.webp`), `/api/assets/${hash}.webp`);
  });

  test('refuses anything else', () => {
    assert.equal(assetUrl(`${hash}.gif`), null);
    assert.equal(assetUrl(`${'A'.repeat(64)}.png`), null);
    assert.equal(assetUrl('../../etc/passwd'), null);
    assert.equal(assetUrl(`${hash}.png?x=1`), null);
    assert.equal(assetUrl(undefined), null);
  });
});

describe('hymnLines', () => {
  test('uses lines[] as given, dropping non-strings', () => {
    assert.deepEqual(hymnLines({ lines: ['Yksi', 2, 'Kaksi'] }), ['Yksi', 'Kaksi']);
  });

  test('splits verse or text on newlines when there are no lines', () => {
    assert.deepEqual(hymnLines({ verse: 'a\r\nb\nc' }), ['a', 'b', 'c']);
    assert.deepEqual(hymnLines({ text: 'only' }), ['only']);
  });

  test('empty when there is nothing to show', () => {
    assert.deepEqual(hymnLines({}), []);
  });
});

describe('parseLang, parseFontSize, parseTheme, isViewerKey', () => {
  test('parseLang keeps codes, original, all and the composed default', () => {
    assert.equal(parseLang('fi-FI'), 'fi-FI');
    assert.equal(parseLang('original'), 'original');
    assert.equal(parseLang('all'), 'all');
    assert.equal(parseLang(''), '');
    assert.equal(parseLang(null), '');
    assert.equal(parseLang('<img src=x>'), '');
    assert.equal(parseLang('x'.repeat(17)), '');
  });

  test('parseFontSize reads a number and clamps it; falls back otherwise', () => {
    assert.equal(parseFontSize('3', 2), 3);
    assert.equal(parseFontSize('0.1', 2), 0.5);
    assert.equal(parseFontSize('99', 2), 10);
    assert.equal(parseFontSize('big', 2), 2);
    assert.equal(parseFontSize(null, 2.5), 2.5);
    assert.equal(parseFontSize('  ', 1.1), 1.1);
  });

  test('parseTheme defaults to dark', () => {
    assert.equal(parseTheme('light'), 'light');
    assert.equal(parseTheme('dark'), 'dark');
    assert.equal(parseTheme(undefined), 'dark');
    assert.equal(parseTheme('blue'), 'dark');
  });

  test('isViewerKey follows the stream-name rule', () => {
    assert.equal(isViewerKey('stream'), true);
    assert.equal(isViewerKey('a_b-9'), true);
    assert.equal(isViewerKey(''), false);
    assert.equal(isViewerKey('BAD!'), false);
    assert.equal(isViewerKey('x'.repeat(33)), false);
    assert.equal(isViewerKey(undefined), false);
  });
});
