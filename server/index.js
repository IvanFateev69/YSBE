import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromium } from 'playwright';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(ROOT, '.profile');
const TMP_DIR = path.join(ROOT, 'tmp');
const START_URL = 'https://education.yandex.ru/uchebnik/main';

fs.mkdirSync(TMP_DIR, { recursive: true });

let context = null;
let page = null;
let queue = Promise.resolve();

function srl(fn) {
  return (...args) => {
    const run = queue.then(() => fn(...args));
    queue = run.then(
      () => {},
      () => {}
    );
    return run;
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function getPage() {
  if (page && !page.isClosed()) return page;
  for (let attempt = 0; ; attempt++) {
    try {
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        viewport: { width: 1280, height: 800 },
        args: ['--disable-blink-features=AutomationControlled'],
      });
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
      await sleep(2000);
    }
  }
  page = context.pages()[0] || (await context.newPage());
  if (page.url() === 'about:blank') {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  }
  context.on('close', () => {
    context = null;
    page = null;
  });
  return page;
}

async function firstVisible(p, selectors) {
  for (const sel of selectors) {
    const loc = p.locator(`${sel}:visible`).first();
    try {
      if (await loc.isVisible({ timeout: 1500 })) return loc;
    } catch {}
  }
  return null;
}

const EDITOR_SELECTORS = [
  '.cm-editor [contenteditable]',
  '.monaco-editor textarea',
  '.CodeMirror',
  '[class*="code-editor"]',
  '[class*="editor"] textarea',
  'div[contenteditable="true"]',
];

const TASK_TEXT_SELECTORS = [
  '[class*="--info"]',
  '[class*="statement"]',
  '[class*="task-description"]',
  '[class*="task__text"]',
  '[class*="condition"]',
  '[class*="theory"]',
  '[class*="instruction"]',
  'article',
  'main',
];

const RUN_BUTTON_TEXTS = ['Запустить', 'Проверить', 'Run', 'Check'];
const SUBMIT_BUTTON_TEXTS = ['Ответить', 'Отправить', 'Submit'];
const NEXT_BUTTON_TEXTS = ['Дальше', 'Продолжение', 'Далее', 'Продолжить', 'Начать', 'Следующая', 'Next', 'Continue'];
const FINISH_BUTTON_TEXTS = ['Завершить', 'Закончить', 'Finish'];

function cleanText(t) {
  return t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function detectType(p) {
  if (await firstVisible(p, EDITOR_SELECTORS)) return 'code';
  const radio = await p.locator('input[type="radio"], [role="radio"], [class*="option"], [class*="variant"]').count();
  const checkbox = await p.locator('input[type="checkbox"], [role="checkbox"]').count();
  if (radio + checkbox > 0) return 'test';
  return 'theory';
}

async function clickButtonByText(p, texts) {
  for (const t of texts) {
    const locs = p.locator(`button:has-text("${t}"), [role="button"]:has-text("${t}")`);
    const n = await locs.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = locs.nth(i);
      if (await el.isVisible().catch(() => false)) {
        const inPad = await el
          .evaluate((e) =>
            !!e.closest('[class*="keypad"], [class*="Keyboard"], [class*="numpad"], [class*="virtual-keyboard"], [class*="NumberPad"]')
          )
          .catch(() => false);
        if (inPad) continue;
        try {
          await el.click({ timeout: 3000 });
          return t;
        } catch {}
      }
    }
  }
  return null;
}

const server = new McpServer({
  name: 'ysbe',
  version: '1.0.0',
});

function tool(name, desc, schema, handler) {
  server.tool(name, desc, schema, srl(handler));
}

tool(
  'status',
  'URL и заголовок текущей страницы браузера',
  {},
  async () => {
    const p = await getPage();
    const pages = p.context().pages();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            url: p.url(),
            title: await p.title(),
            tabs: pages.map((x) => x.url()),
            active: pages.indexOf(p),
          }),
        },
      ],
    };
  }
);

tool(
  'debug',
  'Диагностика: список кнопок на странице с признаком видимости',
  {},
  async () => {
    const p = await getPage();
    const btns = await p.locator('button').evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        const s = window.getComputedStyle(e);
        return {
          text: (e.innerText || '').trim().slice(0, 30),
          visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none',
          x: Math.round(r.x),
          y: Math.round(r.y),
          cls: (e.className || '').toString().slice(0, 50),
        };
      })
    );
    const opts = await p
      .locator('label:visible, [role="radio"]:visible, [role="option"]:visible, [class*="option"]:visible, [class*="choice"]:visible, [class*="select__"]:visible, [class*="answer"]:not(button):visible')
      .evaluateAll((els) =>
        els.slice(0, 15).map((e) => ({
          tag: e.tagName,
          cls: (e.className || '').toString().slice(0, 60),
          text: (e.innerText || '').trim().slice(0, 40),
        }))
      )
      .catch(() => []);
    const inputs = await p
      .locator('input, textarea')
      .evaluateAll((els) =>
        els.slice(0, 20).map((e) => {
          const r = e.getBoundingClientRect();
          const cs = window.getComputedStyle(e);
          return {
            type: e.type || e.tagName.toLowerCase(),
            cls: (e.className || '').toString().slice(0, 50),
            val: (e.value || '').slice(0, 20),
            chk: !!e.checked,
            ctx: (() => {
              let n = e;
              for (let k = 0; k < 6 && n; k++) {
                n = n.previousElementSibling;
                if (n && (n.innerText || '').trim().length > 1) {
                  return n.innerText.replace(/\s+/g, ' ').slice(-80);
                }
              }
              let a = e.parentElement;
              for (let k = 0; k < 5 && a; k++) {
                a = a.parentElement;
                if (a && (a.innerText || '').trim().length > 5) {
                  return a.innerText.replace(/\s+/g, ' ').slice(0, 80);
                }
              }
              return '';
            })(),
            vis: !!(e.offsetWidth || e.offsetHeight),
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            color: cs.color,
            fs: cs.fontSize,
            bd: cs.borderColor + ' ' + cs.borderWidth + ' ' + cs.backgroundColor,
            anc: (() => {
              const out = [];
              let a = e.parentElement;
              for (let k = 0; k < 4 && a; k++, a = a.parentElement) {
                const c = window.getComputedStyle(a);
                if (c.backgroundColor !== 'rgba(0, 0, 0, 0)') out.push(c.backgroundColor);
              }
              return out.join(' | ').slice(0, 100);
            })(),
            html: (e.parentElement ? e.parentElement.outerHTML : '').replace(/\s+/g, ' ').slice(0, 260),
            bg: (() => {
              const blk = e.closest('[class*="problem-block"]') || e.parentElement;
              if (!blk) return 'NONE';
              const imgs = [...blk.querySelectorAll('img')].map(
                (x) => Math.round(x.getBoundingClientRect().x) + ':' + x.src
              );
              if (imgs.length) return imgs.join(' | ').slice(0, 400);
              const cvs = [...blk.querySelectorAll('canvas')];
              if (cvs.length) return 'CANVAS' + cvs.length;
              return 'NONE';
            })(),
            before: (() => {
              try {
                const r = document.evaluate('preceding::text()[1]', e, null, 9, null).singleNodeValue;
                return r ? (r.textContent || '').replace(/\s+/g, ' ').slice(-70) : '';
              } catch {
                return '';
              }
            })(),
            after: (() => {
              try {
                const r = document.evaluate('following::text()[1]', e, null, 9, null).singleNodeValue;
                return r ? (r.textContent || '').replace(/\s+/g, ' ').slice(0, 70) : '';
              } catch {
                return '';
              }
            })(),
          };
        })
      )
      .catch(() => []);
    const probe = await p.evaluate(() => {
      const pts = [[400, 260], [265, 375], [600, 745]];
      const hits = pts.map(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el ? `${el.tagName}.${(el.className || '').toString().slice(0, 40)} @${x},${y}` : `null @${x},${y}`;
      });
      return {
        hits,
        frames: window.frames.length,
        iframes: document.querySelectorAll('iframe').length,
        vw: window.innerWidth,
        vh: window.innerHeight,
        sy: window.scrollY,
        h: document.body.innerText.slice(0, 120),
      };
    });
    const markers = await p
      .locator('[class*="marker"], [class*="drag"], [class*="slot"], [class*="answer-item"]')
      .evaluateAll((els) =>
        els.slice(0, 100).map((e) => {
          const r = e.getBoundingClientRect();
          return {
            tag: e.tagName,
            cls: (e.className || '').toString().slice(0, 45),
            text: (e.innerText || '').trim().slice(0, 25),
            alt: (e.getAttribute && e.getAttribute('alt')) || '',
            src: (e.getAttribute && e.getAttribute('src')) || '',
            bi: window.getComputedStyle(e).backgroundImage.includes('url') ? window.getComputedStyle(e).backgroundImage.slice(0, 220) : '',
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
          };
        })
      )
      .catch(() => []);
    return { content: [{ type: 'text', text: JSON.stringify({ btns, opts, inputs, probe, markers }) }] };
  }
);

tool(
  'goto',
  'Перейти по URL в управляемом браузере',
  { url: z.string() },
  async ({ url }) => {
    const p = await getPage();
    await p.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await p
      .locator('button:has-text("Помощь"):visible, button:has-text("Начать"):visible, button:has-text("Дальше"):visible')
      .first()
      .waitFor({ state: 'visible', timeout: 30000 })
      .catch(() => {});
    await sleep(1500);
    return { content: [{ type: 'text', text: p.url() }] };
  }
);

tool(
  'read_task',
  'Прочитать текущую карточку: тип (code/test/theory) и текст условия',
  {},
  async () => {
    const p = await getPage();
    await p
      .locator('.paginator__button:visible, .cm-editor:visible, button:has-text("Помощь"):visible')
      .first()
      .waitFor({ state: 'visible', timeout: 30000 })
      .catch(() => {});
    await sleep(500);
    const type0 = await detectType(p);
    const inputs = await p
      .locator('input[type="text"]:visible, input[type="number"]:visible, input:not([type]):visible, textarea:visible')
      .count()
      .catch(() => 0);
    const type = type0 === 'theory' && inputs > 0 ? 'quiz' : type0;
    let block = null;
    const instr = p.locator('[class*="instruction"]:visible').first();
    if (await instr.isVisible().catch(() => false)) {
      block = instr.locator('xpath=..');
    }
    if (!block) block = await firstVisible(p, TASK_TEXT_SELECTORS);
    let text = '';
    try {
      text = block ? await block.innerText({ timeout: 4000 }) : await p.locator('body').innerText({ timeout: 4000 });
    } catch {
      text = await p.locator('body').innerText().catch(() => '');
    }
    text = cleanText(text);
    if (type === 'theory') {
      text = text.slice(0, 1000);
    } else if (type === 'quiz') {
      text = text.slice(0, 1200);
    } else {
      text = text.slice(0, 3000);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ type, inputs, text }) }],
    };
  }
);

tool(
  'type_code',
  'Напечатать код в редакторе посимвольно, как человек с клавиатуры (не вставка!)',
  { code: z.string().describe('Код без комментариев') },
  async ({ code }) => {
    const p = await getPage();
    const editor = await firstVisible(p, EDITOR_SELECTORS);
    if (!editor) {
      return { content: [{ type: 'text', text: 'error: редактор не найден' }] };
    }
    const lines = code.split('\n');
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(2500);
      await editor.click();
      await sleep(150);
      await p.keyboard.press('Control+a');
      await p.keyboard.press('Delete');
      await sleep(100);
      for (let i = 0; i < lines.length; i++) {
        await p.keyboard.press('Shift+Home');
        await sleep(rand(30, 70));
        for (const ch of lines[i]) {
          await p.keyboard.type(ch);
          await sleep(rand(30, 90));
        }
        if (i < lines.length - 1) {
          await p.keyboard.press('Enter');
          await sleep(rand(80, 220));
        }
      }
      await sleep(300);
      const content = (await p.locator('.cm-editor:visible .cm-content').first().innerText().catch(() => '')).trim();
      const first = lines[0].trim();
      const last = lines[lines.length - 1].trim();
      if (content.includes(first) && content.includes(last)) {
        return { content: [{ type: 'text', text: 'ok' }] };
      }
    }
    return { content: [{ type: 'text', text: 'error: код не появился в редакторе, повторите' }] };
  }
);

tool(
  'run_code',
  'Нажать кнопку запуска/проверки решения',
  {},
  async () => {
    const p = await getPage();
    const clicked = await clickButtonByText(p, RUN_BUTTON_TEXTS);
    if (!clicked) {
      return { content: [{ type: 'text', text: 'error: кнопка проверки не найдена' }] };
    }
    await sleep(1000);
    return { content: [{ type: 'text', text: 'ok: ' + clicked }] };
  }
);

tool(
  'read_result',
  'Прочитать результат проверки: passed, если кнопка «Ответить» активна, иначе текст вывода/ошибки',
  {},
  async () => {
    const p = await getPage();
    const otvet = p.locator('button:has-text("Ответить")').first();
    let canSubmit = false;
    for (let i = 0; i < 20 && !canSubmit; i++) {
      canSubmit = (await otvet.count()) > 0 && (await otvet.isEnabled().catch(() => false));
      if (!canSubmit) await sleep(500);
    }
    if (canSubmit) await sleep(800);
    let details = '';
    const out = await firstVisible(p, [
      '[class*="tests"]',
      '[class*="output"]',
      '[class*="result"]',
      '[role="alert"]',
      '[class*="error"]:not([class*="boundary"])',
    ]);
    if (out) details = cleanText(await out.innerText()).slice(0, 800);
    return {
      content: [{ type: 'text', text: JSON.stringify({ verdict: canSubmit ? 'passed' : 'not_passed', details }) }],
    };
  }
);

tool(
  'submit',
  'Отправить решение (кнопка «Ответить») после успешной проверки',
  {},
  async () => {
    const p = await getPage();
    for (let attempt = 0; attempt < 3; attempt++) {
      await p.keyboard.press('Escape').catch(() => {});
      await sleep(200);
      const title = p.locator('h1:visible, h2:visible, h3:visible, [class*="instruction"]:visible').first();
      await title.click({ timeout: 1500 }).catch(() => {});
      await sleep(400);
      const clicked = await clickButtonByText(p, SUBMIT_BUTTON_TEXTS);
      if (clicked) {
        await sleep(1200);
        return { content: [{ type: 'text', text: 'ok' }] };
      }
      await sleep(600);
    }
    return { content: [{ type: 'text', text: 'error: кнопка «Ответить» не найдена или неактивна' }] };
  }
);

tool(
  'answer',
  'Ответить на тест: выбрать вариант по тексту/номеру или ввести текст в поле',
  {
    option: z.string().optional().describe('Текст варианта ответа или его номер (1-based)'),
    text: z.string().optional().describe('Текст для поля ввода'),
    index: z.number().optional().describe('Номер поля ввода на карточке, начиная с 0'),
  },
  async ({ option, text, index }) => {
    const p = await getPage();
    if (text !== undefined) {
      const inputs = p.locator(
        'input[type="text"]:visible, input[type="number"]:visible, input:not([type]):visible, textarea:visible'
      );
      const count = await inputs.count().catch(() => 0);
      let target = null;
      if (index !== undefined && index < count) {
        target = inputs.nth(index);
      }
      for (let i = 0; target === null && i < count; i++) {
        const el = inputs.nth(i);
        const val = await el.inputValue().catch(() => null);
        if (val !== null && val === '') {
          target = el;
          break;
        }
      }
      if (!target && count > 0) target = inputs.first();
      if (!target) {
        return { content: [{ type: 'text', text: 'error: поле ввода не найдено' }] };
      }
      await target.click().catch(() => {});
      await target.fill(text, { timeout: 3000 }).catch(() => {});
      await sleep(300);
      const val = await target.inputValue().catch(() => '');
      return { content: [{ type: 'text', text: val === text ? 'ok' : 'error: значение не сохранилось (' + val + ')' }] };
    }
    if (option !== undefined) {
      const n = Number(option);
      const candidates = [];
      if (Number.isInteger(n) && n > 0) {
        candidates.push(`input[type="checkbox"]:visible >> nth=${n - 1}`);
        candidates.push(`input[type="radio"]:visible >> nth=${n - 1}`);
        candidates.push(`label.checkbox:visible >> nth=${n - 1}`);
        candidates.push(`label.radio:visible >> nth=${n - 1}`);
        candidates.push(`label.marker:visible >> nth=${n - 1}`);
        candidates.push(`[role="radio"]:visible, [role="checkbox"]:visible >> nth=${n - 1}`);
      } else {
        candidates.push(`label:has-text("${option}"):visible >> nth=0`);
        candidates.push(`[role="radio"]:has-text("${option}"):visible >> nth=0`);
      }
      for (const sel of candidates) {
        try {
          const target = p.locator(sel);
          if ((await target.count().catch(() => 0)) > 0) {
            await target.first().click({ timeout: 2500 });
            return { content: [{ type: 'text', text: 'ok' }] };
          }
        } catch {}
      }
      return { content: [{ type: 'text', text: 'error: вариант не найден' }] };
    }
    return { content: [{ type: 'text', text: 'error: нужен option или text' }] };
  }
);

tool(
  'next_task',
  'Перейти дальше (кнопки «Дальше»/«Продолжение»/«Начать»). Возвращает done, если задание завершено',
  {},
  async () => {
    const p = await getPage();
    await p
      .locator(
        '.paginator__button:visible, button:has-text("Начать"):visible, button:has-text("Дальше"):visible, button:has-text("Продолжение"):visible, button:has-text("Помощь"):visible'
      )
      .first()
      .waitFor({ state: 'visible', timeout: 30000 })
      .catch(() => {});
    await sleep(300);
    const m = p.url().match(/\/run\/(\d+)\/?/);
    if (m) {
      const nextNum = String(Number(m[1]) + 1);
      const nav = p.locator(`.paginator__button:text-is("${nextNum}"):visible`);
      if ((await nav.count().catch(() => 0)) > 0) {
        await nav.first().click({ timeout: 3000 }).catch(() => {});
        await sleep(1200);
        return { content: [{ type: 'text', text: 'ok: card ' + nextNum }] };
      }
    }
    let finish = await firstVisible(p, FINISH_BUTTON_TEXTS.map((t) => `button:has-text("${t}")`));
    let clicked = finish ? null : await clickButtonByText(p, NEXT_BUTTON_TEXTS);
    if (finish) {
      await finish.click().catch(() => {});
      await sleep(1500);
      return { content: [{ type: 'text', text: 'done' }] };
    }
    if (!clicked) {
      await sleep(4000);
      finish = await firstVisible(p, FINISH_BUTTON_TEXTS.map((t) => `button:has-text("${t}")`));
      if (finish) {
        await finish.click().catch(() => {});
        await sleep(1500);
        return { content: [{ type: 'text', text: 'done' }] };
      }
      clicked = await clickButtonByText(p, NEXT_BUTTON_TEXTS);
    }
    if (!clicked) return { content: [{ type: 'text', text: 'done' }] };
    await sleep(1500);
    const url = p.url();
    return { content: [{ type: 'text', text: 'ok: ' + clicked + ' -> ' + url.split('/').slice(-2)[0] }] };
  }
);

tool(
  'click',
  'Нажать на элемент по CSS-селектору',
  { sel: z.string() },
  async ({ sel }) => {
    const p = await getPage();
    try {
      await p.locator(sel).first().click({ timeout: 4000, force: true });
      await sleep(400);
      return { content: [{ type: 'text', text: 'ok' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'error: ' + String(e.message || e).split('\n')[0].slice(0, 200) }] };
    }
  }
);

tool(
  'click_at',
  'Нажать на элемент по координатам (x, y)',
  { x: z.number(), y: z.number() },
  async ({ x, y }) => {
    const p = await getPage();
    await p.mouse.click(x, y);
    await sleep(350);
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

tool(
  'drag',
  'Перетащить элемент (0-based) в слот (0-based) на карточке с перетаскиванием',
  {
    from: z.number().describe('Индекс перетаскиваемого элемента (0-based)'),
    to: z.number().describe('Индекс целевого слота (0-based)'),
  },
  async ({ from, to }) => {
    const p = await getPage();
    const choices = p.locator('.marker-dragimage__choice:visible');
    const fields = p.locator('.marker-dragimage__field');
    const nc = await choices.count().catch(() => 0);
    const nf = await fields.count().catch(() => 0);
    if (from >= nc || to >= nf) {
      return { content: [{ type: 'text', text: `error: from=${nc} to=${nf}` }] };
    }
    const src = await choices.nth(from).boundingBox();
    const dst = await fields.nth(to).boundingBox();
    if (!src || !dst) {
      return { content: [{ type: 'text', text: 'error: элементы не найдены' }] };
    }
    await choices.nth(from).scrollIntoViewIfNeeded().catch(() => {});
    await sleep(300);
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await p.dragAndDrop(
          `.marker-dragimage__choice:visible >> nth=${from}`,
          `.marker-dragimage__field >> nth=${to}`,
          { steps: 15, force: true }
        );
        await sleep(500);
        return { content: [{ type: 'text', text: 'ok' }] };
      } catch (e) {
        lastErr = String(e.message || e).split('\n')[0];
        await sleep(700);
        await choices.nth(from).scrollIntoViewIfNeeded().catch(() => {});
      }
    }
    const box2 = await choices.nth(from).boundingBox();
    const fb2 = await fields.nth(to).boundingBox();
    if (box2 && fb2) {
      const sx = box2.x + box2.width / 2;
      const sy = box2.y + box2.height / 2;
      await p.mouse.move(sx, sy);
      await sleep(100);
      await p.mouse.down();
      await sleep(250);
      await p.mouse.move(sx + 5, sy + 3, { steps: 3 });
      await sleep(300);
      await p.mouse.move(fb2.x, fb2.y, { steps: 25 });
      await sleep(400);
      await p.mouse.up();
      await sleep(600);
      return { content: [{ type: 'text', text: 'ok(fallback)' }] };
    }
    return { content: [{ type: 'text', text: 'error: ' + lastErr.slice(0, 250) }] };
  }
);

tool(
  'screenshot',
  'Сделать снимок текущей карточки в server/tmp/ и вернуть путь к файлу',
  {},
  async () => {
    const p = await getPage();
    const file = path.join(TMP_DIR, `shot-${Date.now()}.png`);
    await p.screenshot({ path: file });
    return { content: [{ type: 'text', text: file + ' | ' + p.url() }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
