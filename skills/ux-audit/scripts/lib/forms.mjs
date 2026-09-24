import { withAuditPage } from './runtime.mjs';

const SPECIALIZED_FIELD = /(?:email|e-mail|phone|tel|mobile|number|amount|quantity|count|age|price)/i;

export async function runForms({ browser, config }) {
  const rows = [];
  for (const route of config.routes) {
    for (const width of [390, 1440]) {
      const fields = await withAuditPage(browser, config, route, { width, scheme: 'light' }, (page) => page.evaluate(() => {
        const selector = (element) => {
          if (element.id) return `#${CSS.escape(element.id)}`;
          if (element.getAttribute('name')) return `${element.localName}[name="${CSS.escape(element.getAttribute('name'))}"]`;
          const peers = [...element.parentElement.children].filter((peer) => peer.localName === element.localName);
          return `${element.localName}:nth-of-type(${peers.indexOf(element) + 1})`;
        };
        return [...document.querySelectorAll('input,select,textarea')].flatMap((element) => {
          if (element.matches('input[type="hidden"],input[type="button"],input[type="submit"],input[type="reset"],input[type="image"]')) return [];
          let nameSource = 'none';
          if (element.labels?.length) nameSource = 'label';
          else if (element.hasAttribute('aria-labelledby')) nameSource = 'aria-labelledby';
          else if (element.hasAttribute('aria-label')) nameSource = 'aria-label';
          else if (element.hasAttribute('title')) nameSource = 'title';
          else if (element.hasAttribute('placeholder')) nameSource = 'placeholder';
          return [{
            selector: selector(element),
            type: element.localName === 'input' ? (element.getAttribute('type') || 'text').toLowerCase() : element.localName,
            inputmode: element.getAttribute('inputmode'),
            autocomplete: element.getAttribute('autocomplete'),
            nameSource,
            placeholderOnly: nameSource === 'placeholder',
            identity: [element.id, element.getAttribute('name'), element.getAttribute('placeholder'), element.getAttribute('aria-label')].filter(Boolean).join(' '),
          }];
        });
      }));
      for (const field of fields) {
        const row = {
          route: route.id,
          width,
          selector: field.selector,
          type: field.type,
          inputmode: field.inputmode,
          autocomplete: field.autocomplete,
          nameSource: field.nameSource,
          placeholderOnly: field.placeholderOnly,
        };
        if (field.type === 'text' && !field.inputmode && SPECIALIZED_FIELD.test(field.identity)) {
          row.typeMismatch = 'specialized field uses type=text without inputmode';
        }
        rows.push(row);
      }
    }
  }
  return rows;
}
