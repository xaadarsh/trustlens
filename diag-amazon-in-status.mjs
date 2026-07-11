import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-profile-diag2');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';

const URLS = [
  'https://www.amazon.in/dp/B08KTZ8249',
  'https://www.amazon.in/dp/B08MQZXN1X',
  'https://www.amazon.com/dp/B08KTZ8249',
];

async function main() {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: BRAVE_PATH,
    headless: false,
  });
  const page = await context.newPage();
  for (const url of URLS) {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(url, '->', resp.status(), resp.statusText());
  }
  await page.close();
  await context.close();
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
