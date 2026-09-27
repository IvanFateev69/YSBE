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
        await el.click({ timeout: 3000 }).catch(() => {});
        return t;
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
    return {
      content: [{ type: 'text', text: JSON.stringify({ url: p.url(), title: await p.title() }) }],
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
      .locator('label:visible, [role="radio"]:visible, [class*="option"]:visible, [class*="choice"]:visible, [class*="answer"]:not(button):visible')
      .evaluateAll((els) =>
        els.slice(0, 15).map((e) => ({
          tag: e.tagName,
          cls: (e.className || '').toString().slice(0, 60),
          text: (e.innerText || '').trim().slice(0, 40),
        }))
      )
      .catch(() => []);
    return { content: [{ type: 'text', text: JSON.stringify({ btns, opts }) }] };
  }
);

tool(
  'goto',
  'Перейти по URL в управляемом браузере',
  { url: z.string() },
  async ({ url }) => {
    const p = await getPage();
    await p.goto(url, { waitUntil: 'commit', timeout: 60000 });
    await p
      .locator('button:has-text("Помощь"):visible, button:has-text("Начать"):visible, button:has-text("Дальше"):visible')
      .first()
      .waitFor({ state: 'visible', timeout: 30000 })
      .catch(() => {});
    await sleep(400);
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
      text = text.slice(0, 180);
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
    const clicked = await clickButtonByText(p, SUBMIT_BUTTON_TEXTS);
    if (!clicked) {
      return { content: [{ type: 'text', text: 'error: кнопка «Ответить» не найдена или неактивна' }] };
    }
    await sleep(1200);
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

tool(
  'answer',
  'Ответить на тест: выбрать вариант по тексту/номеру или ввести текст в поле',
  {
    option: z.string().optional().describe('Текст варианта ответа или его номер (1-based)'),
    text: z.string().optional().describe('Текст для поля ввода'),
  },
  async ({ option, text }) => {
    const p = await getPage();
    if (text !== undefined) {
      const inputs = p.locator(
        'input[type="text"]:visible, input[type="number"]:visible, input:not([type]):visible, textarea:visible'
      );
      const count = await inputs.count().catch(() => 0);
      let target = null;
      for (let i = 0; i < count; i++) {
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
      await target.click();
      await p.keyboard.press('Control+a');
      await p.keyboard.press('Delete');
      for (const ch of text) {
        await p.keyboard.type(ch);
        await sleep(rand(40, 110));
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    }
    if (option !== undefined) {
      const n = Number(option);
      const candidates = [];
      if (Number.isInteger(n) && n > 0) {
        candidates.push(`label.radio:visible >> nth=${n - 1}`);
        candidates.push(`label.marker:visible >> nth=${n - 1}`);
        candidates.push(`[role="radio"]:visible, input[type="radio"]:visible >> nth=${n - 1}`);
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
  'screenshot',
  'Сделать снимок текущей карточки в server/tmp/ и вернуть путь к файлу',
  {},
  async () => {
    const p = await getPage();
    const file = path.join(TMP_DIR, `shot-${Date.now()}.png`);
    await p.screenshot({ path: file });
    return { content: [{ type: 'text', text: file }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
