/**
 * Maps pigateway SSE events other than `transcript` to relay timeline events
 * (plan 7.2 ingest, P8 translation ingest). Pure: no I/O, no clock reads; the
 * caller passes nowMs.
 *
 * - translation -> `translation` event (PiVoice, planned payload, see docs/media-relay-plan.md 7)
 * - rundown     -> `section` event, only when the section title changed since the last rundown
 * - graphic     -> the data is already a relay event (see README "graphic contract")
 * - anything else -> [] and counted as unknown
 *
 * Every produced event goes through validateEvent; invalid ones are counted as rejected.
 * `transcript` is not handled here: gateway-captions.js owns it.
 */

import { validateEvent } from './events.js';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Parse the SSE data of one event: JSON text or an already parsed value. */
function parseData(data) {
  if (typeof data !== 'string') return { ok: true, value: data };
  try {
    return { ok: true, value: JSON.parse(data) };
  } catch {
    return { ok: false };
  }
}

/** Section title of a rundown snapshot: the display's section, else the item's section, else its title. */
function sectionTitleOf(rundown) {
  const current = isObject(rundown.currentItem) ? rundown.currentItem : null;
  const display = isObject(rundown.display) ? rundown.display : null;
  const candidates = [display?.activeSection, current?.section, current?.title];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

/**
 * @returns {{
 *   map: (sse: { event: string, data: unknown }, nowMs: number) => object[],
 *   stats: () => { mapped: number, rejected: number, unknown: number }
 * }}
 */
export function createGatewayMapper() {
  const counts = { mapped: 0, rejected: 0, unknown: 0 };
  let lastSectionTitle = null;

  function accept(candidate, out) {
    const checked = validateEvent(candidate);
    if (checked.ok) {
      counts.mapped++;
      out.push(checked.event);
    } else {
      counts.rejected++;
    }
  }

  function mapTranslation(d, out) {
    if (!isObject(d)) { counts.rejected++; return; }
    const sourceKey = typeof d.sourceKey === 'string' ? d.sourceKey : undefined;
    // Same normalisation as validateEvent (trim, lower case), so the key and the stored lang agree.
    const lang = typeof d.lang === 'string' ? d.lang.trim().toLowerCase() : d.lang;
    accept({
      type: 'translation',
      lang,
      startedAt: d.startMs,
      endedAt: d.endMs,
      sourceKey: sourceKey === undefined ? undefined : `${sourceKey}:${lang}`,
      payload: { text: d.text, sourceKey, model: d.model },
    }, out);
  }

  function mapRundown(d, nowMs, out) {
    if (!isObject(d)) { counts.rejected++; return; }
    const title = sectionTitleOf(d);
    if (!title) return;
    if (title === lastSectionTitle) return;
    lastSectionTitle = title;
    const current = isObject(d.currentItem) ? d.currentItem : null;
    const id = current?.id ?? title;
    accept({
      type: 'section',
      startedAt: nowMs,
      sourceKey: `rundown:${id}:${nowMs}`,
      payload: { title, index: current?.index },
    }, out);
  }

  function mapGraphic(d, nowMs, out) {
    if (!isObject(d) || d.type !== 'graphic') { counts.rejected++; return; }
    accept({ ...d, startedAt: d.startedAt ?? nowMs }, out);
  }

  /**
   * @param {{ event: string, data: unknown }} sse one parsed SSE event
   * @param {number} nowMs
   * @returns {object[]} validated relay events (possibly none)
   */
  function map(sse, nowMs) {
    const out = [];
    const name = sse?.event;
    if (name !== 'translation' && name !== 'rundown' && name !== 'graphic') {
      counts.unknown++;
      return out;
    }
    const parsed = parseData(sse.data);
    if (!parsed.ok) { counts.rejected++; return out; }
    if (name === 'translation') mapTranslation(parsed.value, out);
    else if (name === 'rundown') mapRundown(parsed.value, nowMs, out);
    else mapGraphic(parsed.value, nowMs, out);
    return out;
  }

  return { map, stats: () => ({ ...counts }) };
}
