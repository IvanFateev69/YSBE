import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(ROOT, '.profile');

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: ['--disable-blink-features=AutomationControlled'],
});

const page = context.pages()[0] || (await context.newPage());
await page.goto('https://education.yandex.ru/uchebnik/main', {
  waitUntil: 'domcontentloaded',
});

console.log('Войдите в свой аккаунт Яндекса в открывшемся окне.');
console.log('После успешного входа просто закройте окно браузера — сессия сохранится.');

await new Promise((resolve) => context.on('close', resolve));
console.log('Сессия сохранена в server/.profile/');
