// src/nuxtExtract.ts
// Extracts and resolves MovieBox's __NUXT_DATA__ payload from H5 detail pages.
//
// MovieBox's H5 site (h5.aoneroom.com) is a Nuxt.js app. Server-rendered pages
// embed their full reactive state as a flat, deduplicated reference array in:
//   <script type="application/json" id="__NUXT_DATA__">[...]</script>
//
// This is Nuxt's "devalue"-style serialization: instead of nesting objects
// directly, the array stores every value once, and dicts/lists reference
// other values by their *index* in that same array. A dict like
//   {"title": 12}
// means "the value at this key is whatever lives at data[12]", which might
// itself be another dict full of indices, recursively.
//
// Special list markers like ["Reactive", 5] or ["ShallowReactive", 5] are
// Nuxt's reactivity wrappers — they just mean "the real value is at index 5",
// the wrapper tag itself carries no data we need.
//
// This structure was confirmed by hand against a real MovieBox movie page
// (Avatar, 2009) before writing this extractor — see the resolved shape below
// for what we expect to find once everything is walked:
//   {
//     subject: { title, description, genre, releaseDate, imdbRatingValue,
//                cover, stills, detailPath, subtitles, duration, ... },
//     resource: { seasons: [...], source, uploadBy },
//     stars: [ { name, character, avatarUrl, staffId, detailPath }, ... ],
//     metadata: { title, description, image, keyWords, url },
//   }

const REACTIVITY_WRAPPER_TAGS = new Set([
  'Reactive',
  'ShallowReactive',
  'Ref',
  'ShallowRef',
]);

export class NuxtExtractionError extends Error {}

/**
 * Pulls the raw JSON text out of the __NUXT_DATA__ script tag in an HTML
 * page and parses it into the flat reference array.
 */
export function parseNuxtData(html: string): unknown[] {
  // Match by id="__NUXT_DATA__" specifically rather than relying on a fixed
  // attribute order — MovieBox's actual tag is
  // `<script type="application/json" data-nuxt-data="nuxt-app" data-ssr="true" id="__NUXT_DATA__">`
  // but attribute order on script tags is not something to depend on.
  const match = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) {
    throw new NuxtExtractionError(
      '__NUXT_DATA__ script tag not found in page HTML — MovieBox may have ' +
      'changed their page structure.'
    );
  }

  try {
    const data = JSON.parse(match[1]) as unknown[];
    if (!Array.isArray(data)) {
      throw new NuxtExtractionError('__NUXT_DATA__ content is not an array');
    }
    return data;
  } catch (e) {
    if (e instanceof NuxtExtractionError) throw e;
    throw new NuxtExtractionError(
      `Failed to parse __NUXT_DATA__ JSON: ${(e as Error).message}`
    );
  }
}

/**
 * Recursively resolves a value at a given index in the flat Nuxt data array,
 * following dict/list/reactivity-wrapper references until only plain data
 * (strings, numbers, booleans, null, or fully-resolved objects/arrays) remains.
 *
 * `seen` guards against circular references (Nuxt payloads can legitimately
 * contain cycles — e.g. a parent referencing a child that references the
 * parent back). `maxDepth` is a hard backstop in case of unexpectedly deep
 * or pathological structures.
 */
export function resolveNuxtRef(
  data: unknown[],
  index: number,
  depth = 0,
  seen: Set<number> = new Set(),
  maxDepth = 12
): unknown {
  if (depth > maxDepth) return null;
  if (seen.has(index)) return null; // break cycles silently
  if (index < 0 || index >= data.length) return null;

  const nextSeen = new Set(seen);
  nextSeen.add(index);

  const value = data[index];

  if (Array.isArray(value)) {
    // Reactivity wrapper: ["Reactive", 5] etc. — unwrap to the real index.
    if (
      value.length === 2 &&
      typeof value[0] === 'string' &&
      REACTIVITY_WRAPPER_TAGS.has(value[0]) &&
      typeof value[1] === 'number'
    ) {
      return resolveNuxtRef(data, value[1], depth + 1, nextSeen, maxDepth);
    }

    // Plain array — resolve each element if it's an index (number),
    // otherwise keep it as-is (Nuxt stores some arrays with literal values).
    return value.map((item) =>
      typeof item === 'number'
        ? resolveNuxtRef(data, item, depth + 1, nextSeen, maxDepth)
        : item
    );
  }

  if (value !== null && typeof value === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, ref] of Object.entries(value as Record<string, unknown>)) {
      resolved[key] =
        typeof ref === 'number'
          ? resolveNuxtRef(data, ref, depth + 1, nextSeen, maxDepth)
          : ref;
    }
    return resolved;
  }

  // Primitive — string, number, boolean, null. Nothing further to resolve.
  return value;
}

// ─── Shape of what we expect after resolving the page's root state ─────────

export interface MBNuxtCover {
  url: string;
  width?: number;
  height?: number;
  thumbnail?: string;
}

export interface MBNuxtStar {
  name: string;
  character?: string;
  avatarUrl?: string;
  staffId?: string;
  detailPath?: string;
}

export interface MBNuxtSeason {
  se: number;
  maxEp: number;
  allEp?: string;
  resolutions?: Array<{ resolution: number; epNum: number }>;
}

export interface MBNuxtSubject {
  subjectId: string;
  subjectType: number;
  title: string;
  description?: string;
  releaseDate?: string;
  duration?: number;
  genre?: string;
  cover?: MBNuxtCover;
  stills?: MBNuxtCover;
  countryName?: string;
  imdbRatingValue?: string;
  imdbRatingCount?: number;
  hasResource?: boolean;
  detailPath?: string;
  subtitles?: string;
  corner?: string;
}

export interface MBNuxtPageData {
  subject: MBNuxtSubject;
  resource?: { seasons?: MBNuxtSeason[]; source?: string; uploadBy?: string };
  stars?: MBNuxtStar[];
}

/**
 * Top-level entry point: given a detail page's raw HTML, returns the fully
 * resolved subject/resource/stars data.
 *
 * Walk path (confirmed against a real MovieBox page during testing):
 *   data[1]            -> { data, state, once, _errors, serverRendered, path }
 *   data[1].state (4)  -> ["Reactive", 5]
 *   data[5]            -> { ..., "$sresData": 7, ... }
 *   data[7]            -> { subject, resource, stars, metadata, ... }   <-- target
 *
 * Nuxt prefixes some state keys with "$s" (string-keyed reactive state) —
 * we search for any key matching /resData$/ rather than assuming the exact
 * "$sresData" spelling, since that prefix convention is Nuxt-internal and
 * could shift between Nuxt versions.
 */
export function getInfoFromHtml(html: string): MBNuxtPageData {
  const data = parseNuxtData(html);

  // data[1] is consistently the top-level SSR context object in every page
  // we've inspected — { data, state, once, _errors, serverRendered, path }.
  const topLevel = data[1];
  if (
    !topLevel ||
    typeof topLevel !== 'object' ||
    Array.isArray(topLevel) ||
    !('state' in (topLevel as Record<string, unknown>))
  ) {
    throw new NuxtExtractionError(
      'Unexpected __NUXT_DATA__ shape — data[1] is not the expected SSR context object'
    );
  }

  const stateIndex = (topLevel as Record<string, unknown>).state;
  if (typeof stateIndex !== 'number') {
    throw new NuxtExtractionError('data[1].state is not an index reference');
  }

  const resolvedState = resolveNuxtRef(data, stateIndex) as
    | Record<string, unknown>
    | null;

  if (!resolvedState || typeof resolvedState !== 'object') {
    throw new NuxtExtractionError('Failed to resolve state object');
  }

  // Find the resData-equivalent key. Observed as "$sresData" but we match
  // loosely on a case-insensitive "resdata" suffix to tolerate minor naming
  // drift across Nuxt/MovieBox versions without silently returning nothing.
  const resDataKey = Object.keys(resolvedState).find((k) =>
    k.toLowerCase().endsWith('resdata')
  );

  if (!resDataKey) {
    throw new NuxtExtractionError(
      'Could not find a resData-equivalent key in resolved state. ' +
      `Available keys: ${Object.keys(resolvedState).join(', ')}`
    );
  }

  const pageData = resolvedState[resDataKey] as Partial<MBNuxtPageData> | null;

  if (!pageData || !pageData.subject) {
    throw new NuxtExtractionError(
      'Resolved resData is missing a "subject" field — page may not be a ' +
      'movie/TV detail page, or MovieBox changed their payload structure.'
    );
  }

  return pageData as MBNuxtPageData;
}
