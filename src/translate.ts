export const indianLocales = [
  "as",
  "bn",
  "brx",
  "doi",
  "gu",
  "hi",
  "kn",
  "kok",
  "ks",
  "mai",
  "ml",
  "mni",
  "mr",
  "ne",
  "or",
  "pa",
  "sa",
  "sat",
  "sd",
  "ta",
  "te",
  "ur",
] as const;

export interface Message {
  source: string;
  context: string;
  translation?: string;
  provider?: string;
  requestId?: string;
}

const placeholders =
  /\{\{[^{}]+\}\}|\$\{[^{}]+\}|\{[A-Za-z_][\w.]*\}|%(?:\d+\$)?[sdif]/gu;
const tokens = (text: string) =>
  [...text.matchAll(placeholders)].map(([token]) => token).sort();

export function checkTranslation(
  source: string,
  translated: string,
  sourceLocale: string,
  locale: string,
) {
  if (!translated.trim() || !translated.isWellFormed())
    throw new Error("translation is empty or invalid Unicode");
  if (JSON.stringify(tokens(source)) !== JSON.stringify(tokens(translated))) {
    throw new Error("translation changed or dropped a placeholder");
  }
  const input = source.replace(placeholders, "").trim();
  const output = translated.replace(placeholders, "").trim();
  const from = new Intl.Locale(sourceLocale).maximize();
  const to = new Intl.Locale(locale).maximize();
  if (from.language !== to.language && /\p{L}/u.test(input)) {
    if (input === output)
      throw new Error("translation still contains the unchanged source text");
    if (
      to.script !== from.script &&
      !new RegExp(`\\p{Script_Extensions=${to.script}}`, "u").test(output)
    ) {
      throw new Error(
        `translation contains no ${to.script} script for ${locale}`,
      );
    }
  }
}

export function sarvamLanguage(locale: string) {
  const parsed = new Intl.Locale(locale);
  if (
    parsed.language !== "en" &&
    !indianLocales.includes(parsed.language as (typeof indianLocales)[number])
  ) {
    throw new Error(
      `Sarvam does not support ${locale}; supply translations in the locale catalog instead`,
    );
  }
  return `${parsed.language === "or" ? "od" : parsed.language}-IN`;
}

function chunks(text: string, locale: string, limit: number) {
  const parts: string[] = [];
  let current = "";
  for (const sentence of new Intl.Segmenter(locale, {
    granularity: "sentence",
  }).segment(text)) {
    let segment = sentence.segment;
    while (segment.length > limit) {
      if (current) {
        parts.push(current);
        current = "";
      }
      let cut = 0;
      for (const word of new Intl.Segmenter(locale, {
        granularity: "word",
      }).segment(segment)) {
        const end = word.index + word.segment.length;
        if (end > limit) break;
        cut = end;
      }
      for (const marker of segment.matchAll(placeholders)) {
        if (marker.index! < cut && marker.index! + marker[0].length > cut)
          cut = marker.index!;
      }
      if (!cut)
        throw new Error(
          `a single word or placeholder exceeds the ${limit}-character translation limit`,
        );
      parts.push(segment.slice(0, cut));
      segment = segment.slice(cut);
    }
    if (current.length + segment.length > limit) {
      parts.push(current);
      current = "";
    }
    current += segment;
  }
  if (current) parts.push(current);
  return parts;
}

export async function translateMessages(
  messages: Record<string, Message>,
  sourceLocale: string,
  locale: string,
  options: { key: string; fetch?: typeof fetch; save: () => Promise<void> },
) {
  if (!options.key)
    throw new Error(
      "set SARVAM_API_KEY to generate translations, or supply the locale catalogs directly",
    );
  const sourceCode = sarvamLanguage(sourceLocale);
  const targetCode = sarvamLanguage(locale);
  const request = options.fetch ?? fetch;
  const pending = Object.entries(messages).filter(
    ([, message]) => message.translation === undefined,
  );
  let calls = 0;
  async function translate(input: string) {
    const response = await request("https://api.sarvam.ai/translate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": options.key,
      },
      body: JSON.stringify({
        input,
        source_language_code: sourceCode,
        target_language_code: targetCode,
        model: "sarvam-translate:v1",
        mode: "formal",
      }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    calls += 1;
    if (!response.ok)
      throw new Error(
        `Sarvam returned HTTP ${response.status}; saved translations can be reused on the next run`,
      );
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (response.body)
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 100_000)
          throw new Error("Sarvam returned an oversized response");
        chunks.push(chunk);
      }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const value = JSON.parse(body) as {
      translated_text?: unknown;
      request_id?: unknown;
    };
    if (
      !value ||
      typeof value.translated_text !== "string" ||
      typeof value.request_id !== "string"
    ) {
      throw new Error("Sarvam returned an invalid translation response");
    }
    return { text: value.translated_text, requestId: value.request_id };
  }
  for (let index = 0; index < pending.length;) {
    const first = pending[index]!;
    if (first[1].source.length > 1_850) {
      const translated: string[] = [];
      const ids: string[] = [];
      for (const part of chunks(first[1].source, sourceLocale, 2_000)) {
        const result = await translate(part);
        translated.push(result.text);
        ids.push(result.requestId);
      }
      const value = translated.join(" ");
      checkTranslation(first[1].source, value, sourceLocale, locale);
      Object.assign(first[1], {
        translation: value,
        provider: "sarvam-translate:v1",
        requestId: ids.join(","),
      });
      await options.save();
      index += 1;
      continue;
    }
    const batch: Array<[string, Message]> = [];
    let input = "";
    while (index < pending.length) {
      const entry = pending[index]!;
      const part = `{{SEER_MESSAGE_${batch.length}}}\n${entry[1].source}\n`;
      if (input.length + part.length > 2_000) break;
      input += part;
      batch.push(entry);
      index += 1;
    }
    const result = await translate(input);
    const markers = [...result.text.matchAll(/\{\{SEER_MESSAGE_(\d+)\}\}/gu)];
    if (
      markers.length !== batch.length ||
      markers.some((match, position) => Number(match[1]) !== position) ||
      result.text.slice(0, markers[0]?.index).trim()
    ) {
      throw new Error(
        "Sarvam changed the message separators; no translations from this batch were saved",
      );
    }
    const values = batch.map(([, message], position) => {
      const marker = markers[position]!;
      const value = result.text
        .slice(marker.index! + marker[0].length, markers[position + 1]?.index)
        .trim();
      checkTranslation(message.source, value, sourceLocale, locale);
      return value;
    });
    batch.forEach(([, message], position) =>
      Object.assign(message, {
        translation: values[position]!,
        provider: "sarvam-translate:v1",
        requestId: result.requestId,
      }),
    );
    await options.save();
  }
  return calls;
}
