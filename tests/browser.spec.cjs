const { test, expect } = require('@playwright/test');

const palette = (page, selector) => page.locator(`.components-panel .component${selector}`);
const components = page => page.locator('#work-canvas .canvas-component');
const project = page => page.evaluate(() => document.NucleotideSimulator.model.toJSON());

async function uploadProject(page, data) {
  await page.locator('#import-file').setInputFiles({
    name: 'project.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(data)),
  });
}

function nucleotide() {
  return {
    version: 1,
    components: [
      { id: 'component-0', type: 'phosphate', x: 60, y: 160, rotation: 0 },
      { id: 'component-1', type: 'sugar', sugarType: 'deoxyribose', x: 220, y: 160, rotation: 0 },
      { id: 'component-2', type: 'base', base: 'A', x: 380, y: 160, rotation: 0 },
    ],
    connections: [
      { id: 'connection-0', from: 'component-0', to: 'component-1', bondType: 'strong-bond' },
      { id: 'connection-1', from: 'component-1', to: 'component-2', bondType: 'weak-bond' },
    ],
  };
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page._simulatorErrors = errors;
  await page.goto('/');
});

test.afterEach(async ({ page }) => {
  expect(page._simulatorErrors, 'No browser errors').toEqual([]);
});

test('palette, bonds, rejected pairing, undo and redo work through the UI', async ({ page }) => {
  await palette(page, '[data-type="phosphate"]').click();
  await palette(page, '[data-sugar-type="deoxyribose"]').click();
  await palette(page, '[data-base="A"]').click();
  await palette(page, '[data-base="C"]').click();
  await expect(components(page)).toHaveCount(4);

  await components(page).nth(0).click();
  await components(page).nth(1).click();
  await components(page).nth(1).click();
  await components(page).nth(2).click();
  expect((await project(page)).connections).toHaveLength(2);

  await components(page).nth(2).click();
  await components(page).nth(3).click();
  await expect(page.locator('#validation-result')).toHaveClass(/error/);
  expect((await project(page)).connections).toHaveLength(2);

  await page.locator('#undo').click();
  expect((await project(page)).connections).toHaveLength(1);
  await page.locator('#redo').click();
  expect((await project(page)).connections).toHaveLength(2);
});

test('dragging moves the connected group without starting connection mode', async ({ page }) => {
  await uploadProject(page, nucleotide());
  await expect(components(page)).toHaveCount(3);
  const before = await project(page);
  const target = page.locator('#component-1');
  const box = await target.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  const after = await project(page);
  for (let i = 0; i < 3; i++) {
    expect(after.components[i].x - before.components[i].x).toBeCloseTo(45, 0);
    expect(after.components[i].y - before.components[i].y).toBeCloseTo(30, 0);
  }
  expect(after.connections).toHaveLength(2);
  await expect(page.locator('#work-canvas .selected')).toHaveCount(0);
  await page.locator('#undo').click();
  expect(await project(page)).toEqual(before);
});

test('palette drag and drop places the component at the drop point', async ({ page }) => {
  await palette(page, '[data-type="phosphate"]').dragTo(page.locator('#work-canvas'), {
    targetPosition: { x: 250, y: 200 },
  });
  await expect(components(page)).toHaveCount(1);
  const added = (await project(page)).components[0];
  expect(added.type).toBe('phosphate');
  const border = await page.locator('#work-canvas').evaluate(element => ({ x: element.clientLeft, y: element.clientTop }));
  expect(added.x).toBeCloseTo(250 - border.x - 30, 0);
  expect(added.y).toBeCloseTo(200 - border.y - 30, 0);
});

test('Escape cancels an active drag without selecting or adding history', async ({ page }) => {
  await uploadProject(page, nucleotide());
  await expect(components(page)).toHaveCount(3);
  const original = await project(page);
  const box = await page.locator('#component-1').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30, { steps: 5 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await project(page)).toEqual(original);
  await expect(page.locator('#work-canvas .selected')).toHaveCount(0);
  await page.locator('#undo').click();
  await expect(components(page)).toHaveCount(0);
});

test('disconnecting a bridge updates which components move together', async ({ page }) => {
  await uploadProject(page, nucleotide());
  await expect(components(page)).toHaveCount(3);
  await page.locator('#component-1').click();
  await page.locator('#disconnect-selected').click();
  expect((await project(page)).connections).toHaveLength(0);
  const before = await project(page);
  await page.locator('#component-0').focus();
  await page.keyboard.press('ArrowRight');
  const after = await project(page);
  expect(after.components[0].x).toBe(before.components[0].x + 10);
  expect(after.components[1]).toEqual(before.components[1]);
  expect(after.components[2]).toEqual(before.components[2]);
});

test('keyboard users can create, move, rotate, delete and undo', async ({ page }) => {
  await palette(page, '[data-base="A"]').focus();
  await page.keyboard.press('Enter');
  await expect(components(page)).toHaveCount(1);
  await components(page).first().focus();
  const initial = (await project(page)).components[0];
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press(']');
  const moved = (await project(page)).components[0];
  expect(moved.x).toBe(initial.x + 1);
  expect(moved.rotation).not.toBe(initial.rotation);
  await page.keyboard.press('Delete');
  await expect(components(page)).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(components(page)).toHaveCount(1);
  expect((await project(page)).components[0]).toEqual(moved);
});

test('projects survive reload and invalid imports leave the project intact', async ({ page }) => {
  await page.locator('#load-dna-example').click();
  await expect(components(page)).not.toHaveCount(0);
  const original = await project(page);
  await page.reload();
  await expect(components(page)).toHaveCount(original.components.length);
  expect(await project(page)).toEqual(original);
  await uploadProject(page, { version: 1, components: [{ id: 'bad', type: 'script', x: 0, y: 0 }], connections: [] });
  await expect(page.locator('#validation-result')).toHaveClass(/error/);
  expect(await project(page)).toEqual(original);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-project').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(original);
});

test('blocked storage leaves editing and export available with a visible warning', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Storage.prototype, 'setItem', {
      value() { throw new DOMException('Storage unavailable', 'QuotaExceededError'); },
    });
  });
  await page.reload();
  await palette(page, '[data-base="A"]').click();
  await expect(components(page)).toHaveCount(1);
  await expect(page.locator('#save-status')).toContainText('無法自動儲存');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-project').click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/\.json$/);
});

test('corrupt saved data does not prevent starting a new project', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('nucleotide-simulator-v1', '{not json'));
  await page.reload();
  await expect(page.locator('#validation-result')).toHaveClass(/error/);
  await expect(components(page)).toHaveCount(0);
  await palette(page, '[data-base="G"]').click();
  await expect(components(page)).toHaveCount(1);
  await page.reload();
  await expect(components(page)).toHaveCount(1);
});

test('both examples are valid and clearing is reversible', async ({ page }) => {
  for (const kind of ['dna', 'rna']) {
    await page.locator(`#load-${kind}-example`).click();
    const example = await project(page);
    expect(example.components.length).toBeGreaterThan(0);
    expect(example.connections.length).toBeGreaterThan(0);
    const sugarType = kind === 'dna' ? 'deoxyribose' : 'ribose';
    expect(example.components.filter(c => c.type === 'sugar').every(c => c.sugarType === sugarType)).toBe(true);
    await expect(page.locator(`#work-canvas [data-sugar-type="${sugarType}"]`)).toHaveCount(4);
    await expect(page.locator(`#work-canvas [data-sugar-type="${kind === 'dna' ? 'ribose' : 'deoxyribose'}"]`)).toHaveCount(0);
    await page.locator('#clear-all').click();
    await expect(components(page)).toHaveCount(0);
    await page.locator('#undo').click();
    expect(await project(page)).toEqual(example);
  }
});

test('rotation is relative to the grab angle and Escape restores normal interaction', async ({ page }) => {
  await uploadProject(page, nucleotide());
  await expect(components(page)).toHaveCount(3);
  const sugar = page.locator('#component-1');
  await sugar.click({ button: 'right' });
  const box = await sugar.boundingBox();
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(center.x, center.y + 100);
  await page.mouse.down();
  await page.mouse.move(center.x - 10, center.y + 100, { steps: 3 });
  const rotated = await project(page);
  expect(rotated.components[1].rotation).toBeCloseTo(Math.atan(0.1) * 180 / Math.PI, 1);
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await expect(page.locator('#work-canvas')).not.toHaveClass(/rotation-mode/);
  await page.locator('#undo').click();
  expect(await project(page)).toEqual(nucleotide());
});

test('importing a different type with reused IDs updates the rendered component', async ({ page }) => {
  const original = { version: 1, components: [{ id: 'component-0', type: 'base', base: 'A', x: 100, y: 100, rotation: 0 }], connections: [] };
  await uploadProject(page, original);
  await expect(page.locator('#component-0')).toHaveAttribute('data-base', 'A');
  const replacement = { version: 1, components: [{ id: 'component-0', type: 'sugar', sugarType: 'ribose', x: 100, y: 100, rotation: 0 }], connections: [] };
  await uploadProject(page, replacement);
  await expect(page.locator('#component-0')).toHaveAttribute('data-type', 'sugar');
  await expect(page.locator('#component-0')).toHaveAttribute('data-sugar-type', 'ribose');
  await expect(page.locator('#component-0')).not.toHaveAttribute('data-base');
  await page.locator('#undo').click();
  await expect(page.locator('#component-0')).toHaveAttribute('data-base', 'A');
});

test('touch-sized layouts keep palette controls and the canvas usable', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await palette(page, '[data-type="phosphate"]').tap();
  await expect(components(page)).toHaveCount(1);
  await components(page).first().scrollIntoViewIfNeeded();
  const before = await project(page);
  const box = await components(page).first().boundingBox();
  const touch = await context.newCDPSession(page);
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + 40, y: start.y + 30 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const moved = await project(page);
  expect(moved.components[0].x).toBeCloseTo(before.components[0].x + 40, 0);
  expect(moved.components[0].y).toBeCloseTo(before.components[0].y + 30, 0);
  await expect(page.locator('#work-canvas .selected')).toHaveCount(0);
  const dimensions = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    canvas: document.getElementById('work-canvas').clientWidth,
    scroller: document.getElementById('canvas-viewport').clientWidth,
  }));
  expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.canvas).toBeGreaterThan(dimensions.scroller);
  await page.locator('#canvas-viewport').evaluate(element => { element.scrollLeft = 120; });
  expect(await page.locator('#canvas-viewport').evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  await context.close();
});
