// A whole game in real browsers: the host panel, the big screen and four phones (one on a slow
// mobile connection), with a phone dropping off and coming back, and a phone reloading mid-question.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { PASSWORD } from './playwright.config';

const GUESTS = ['Łukasz Wiśniewski', 'Núria Puigdomènech', 'Jürgen Weiß', 'Lukas Becker'];

async function loggedIn(browser: Browser, path: '/host' | '/screen', width = 1440) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`/login?next=${path}`);
  await page.fill('input[name=password]', PASSWORD);
  await page.press('input[name=password]', 'Enter');
  await page.waitForURL(`**${path}`);
  return page;
}

/** The host's big "next" button, confirming the sheet if one opens. */
async function next(host: Page, label: RegExp) {
  const button = host.locator('.h-next');
  await expect(button).toContainText(label);
  await button.click();
  const confirm = host.locator('.h-sheet .h-card button.h-btn.big:not(.quiet)');
  if (await confirm.isVisible().catch(() => false)) await confirm.first().click();
}

async function phone(browser: Browser, slow = false) {
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 560 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  if (slow) {
    // a weak mobile signal at the venue: 400 ms latency, about 400 kbit/s
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 400,
      downloadThroughput: 50_000,
      uploadThroughput: 50_000,
    });
  }
  return { ctx, page };
}

async function join(page: Page, name: string) {
  await page.goto('/join');
  await page.waitForURL('**/play');
  for (let step = 0; step < 6; step++) {
    if (await page.getByText("You're in!").isVisible()) return;
    const search = page.getByPlaceholder('Start typing your name');
    if (await search.isVisible()) {
      await search.fill(name);
      await page.locator('.names button.name', { hasText: name }).first().click();
      await page.getByRole('button', { name: "Yes, that's me" }).click();
    } else if (await page.getByRole('button', { name: 'Continue' }).isVisible()) {
      await page.getByRole('button', { name: 'Continue' }).click();
    }
    await page.waitForTimeout(500);
  }
  await expect(page.getByText("You're in!")).toBeVisible();
}

/** Nothing on the phone needs scrolling (the rule since Phase 6.9). */
const fits = (page: Page) =>
  page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight + 1);

test.describe.serial('a whole game', () => {
  let host: Page;
  let screen: Page;
  const phones: { ctx: BrowserContext; page: Page }[] = [];

  test.afterAll(async () => {
    for (const p of phones) await p.ctx.close();
    await host?.context().close();
    await screen?.context().close();
  });

  test('the host panel and the big screen need the admin login', async ({ page }) => {
    await page.goto('/host');
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/screen');
    await expect(page).toHaveURL(/\/login/);
    await page.fill('input[name=password]', 'wrong password');
    await page.press('input[name=password]', 'Enter');
    await expect(page.locator('.err')).toBeVisible();
  });

  test('while joining is closed, phones wait and then go on by themselves', async ({ browser }) => {
    host = await loggedIn(browser, '/host');
    screen = await loggedIn(browser, '/screen', 1600);
    await expect(screen.locator('.s-title')).toHaveText('Who knows Anna & Ben best?');
    const first = await phone(browser);
    phones.push(first);
    await first.page.goto('/join');
    await expect(first.page.getByText("You're a bit early!")).toBeVisible();
    await host.getByRole('button', { name: 'Open joining' }).first().click();
    await expect(first.page.getByText("You're a bit early!")).toBeHidden();
    await join(first.page, GUESTS[0]!);
  });

  test('three more phones join, one of them on a slow connection', async ({ browser }) => {
    for (const [i, name] of GUESTS.slice(1).entries()) {
      const p = await phone(browser, i === 0);
      phones.push(p);
      await join(p.page, name);
    }
    await expect(screen.locator('.s-count .num')).toHaveText('4');
  });

  test('a full quiz: every phone answers, sees its result, and the room sees the votes', async () => {
    await next(host, /Start the quiz/);
    for (let n = 1; n <= 3; n++) {
      if (n > 1) await next(host, /question/i);
      // reading time (Phase 9.5): the question first, then the host shows the answers
      await expect(phones[0]!.page.getByText('Read the question')).toBeVisible();
      await next(host, /answers/i);
      for (const [i, p] of phones.entries()) {
        const tiles = p.page.locator('.answers button.ans');
        await expect(tiles.first()).toBeEnabled();
        if (n === 3 && i === 0) expect(await fits(p.page)).toBe(true); // the photo question
        if (n === 2 && i === 1) {
          // a phone loses its signal mid-question and comes back
          await p.ctx.setOffline(true);
          await p.page.waitForTimeout(1_500);
          await p.ctx.setOffline(false);
          await expect(tiles.first()).toBeEnabled({ timeout: 20_000 });
        }
        if (n === 2 && i === 2) {
          // a phone reloads the page: same name, same question
          await p.page.reload();
          await expect(tiles.first()).toBeEnabled({ timeout: 20_000 });
        }
        await tiles.nth(i % 2).click();
        await expect(p.page.getByText('Your answer is saved')).toBeVisible();
      }
      // auto-reveal: everyone answered
      for (const p of phones) {
        await expect(p.page.getByText(/Correct!|Not this time/)).toBeVisible();
      }
      if (n < 3) {
        await next(host, /Top 10/);
        await expect(screen.getByText('Top 10')).toBeVisible();
        for (const name of GUESTS) await expect(screen.getByText(name).first()).toBeVisible();
      }
    }
  });

  test('the podium, then every phone gets its place and the full ranking', async () => {
    await next(host, /podium/i);
    // 3rd, 2nd, 1st (fewer when places are empty or shared)
    for (let i = 0; i < 3; i++) {
      if (/full ranking/i.test(await host.locator('.h-next').innerText())) break;
      await next(host, /./);
      await host.waitForTimeout(600);
    }
    for (const p of phones) await expect(p.page.getByText('Your place')).toBeVisible();
    await next(host, /full ranking/i);
    for (const p of phones) {
      await expect(p.page.getByText('Final ranking')).toBeVisible();
      await expect(p.page.locator('.me').first()).toBeVisible();
    }
  });
});
