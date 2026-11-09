/**
 * Auto-escaping HTML templates for the review screen (T14). Everything interpolated into `html`
 * is escaped unless it is already `SafeHtml`, so transcript, recap and GM text cannot become markup
 * by accident. Escaped text is safe inside element bodies and inside double- or single-quoted
 * attributes, which are the only places a template may put it.
 */

export class SafeHtml {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return this.value;
  }
}

export type HtmlValue =
  SafeHtml | string | number | boolean | null | undefined | readonly HtmlValue[];

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);
}

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (value instanceof SafeHtml) return value.value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return escapeHtml(value);
  return value.map(render).join('');
}

export function html(strings: TemplateStringsArray, ...values: readonly HtmlValue[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((value, index) => {
    out += render(value) + (strings[index + 1] ?? '');
  });
  return new SafeHtml(out);
}
