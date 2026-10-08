// Run against WALLE_UI_REGISTRATION_MODE=invite node test/ui-server.mjs with:
// playwright-cli run-code --filename=walle-memory-worker/test/ui-invitation-flow.js
// Every credential stays in this function and belongs to the disposable fixture.
async page => {
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  const uiErrors = [];
  page.on('pageerror', error => uiErrors.push(error.message));
  const base = new URL(page.url()).origin;
  const firstEmail = 'invited-browser-test@example.invalid';
  const password = 'temporary-invitation-browser-password';
  let firstCode = '';
  let secondCode = '';
  let credential = '';

  const createInvitation = async label => {
    await page.locator('#admin-key').fill('local-ui-test-admin');
    await page.locator('#invitation-label').fill(label);
    await page.locator('#invitation-max-uses').fill('1');
    const pending = page.waitForResponse(response => response.url().endsWith('/admin/invitations') && response.request().method() === 'POST');
    await page.locator('#invitation-create').click();
    const response = await pending;
    ensure(response.status() === 201, 'Administrator can create a test invitation');
    const result = await response.json();
    let code = result.invitation_code;
    result.invitation_code = '';
    ensure(typeof code === 'string' && /^wmi_[a-f0-9]{64}$/.test(code), 'Invitation has a strong code format');
    await page.locator('#invitation-secret-dialog').waitFor({ state: 'visible' });
    ensure(await page.locator('#invitation-secret-output').inputValue() === code, 'New code is shown once');
    ensure(await page.locator('#admin-key').inputValue() === '', 'Administrator secret is cleared');
    ensure(await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0), 'No credentials enter browser storage');
    await page.locator('#close-invitation-secret').click();
    ensure(await page.locator('#invitation-secret-output').inputValue() === '', 'Closing invitation dialog clears the code');
    const invitation = result.invitation;
    const returned = { code, invitation };
    code = '';
    return returned;
  };

  const submitRegistration = async (email, code, displayName) => {
    if (await page.locator('#registration-invitation-field').isHidden()) await page.locator('#auth-toggle').click();
    await page.locator('#auth-email').fill(email);
    await page.locator('#auth-name').fill(displayName);
    await page.locator('#auth-password').fill(password);
    await page.locator('#auth-invitation-code').fill(code);
    const pending = page.waitForResponse(response => response.url().endsWith('/auth/register') && response.request().method() === 'POST');
    await page.locator('#auth-submit').click();
    const response = await pending;
    ensure(await page.locator('#auth-password').inputValue() === '', 'Registration password is cleared');
    ensure(await page.locator('#auth-invitation-code').inputValue() === '', 'Submitted invitation code is cleared');
    return response;
  };

  try {
    await page.locator('#registration-note').getByText('邀请码', { exact: false }).waitFor();
    ensure(await page.locator('#auth-toggle').isVisible(), 'Invitation registration entry is available');
    await page.locator('#admin-details summary').click();
    const first = await createInvitation('Browser single-use invitation');
    firstCode = first.code;
    first.code = '';
    await page.locator('#admin-details summary').click();

    const signup = await submitRegistration(firstEmail, firstCode, 'Invited Browser Test');
    ensure(signup.status() === 201, 'Valid invitation signs up successfully');
    await page.locator('#account-name').getByText('Invited Browser Test').waitFor();
    await page.locator('#space-list').getByText('还没有空间。', { exact: true }).waitFor();
    const initialSpaces = await page.request.get(base + '/account/spaces');
    ensure(initialSpaces.status() === 200 && (await initialSpaces.json()).spaces.length === 0, 'Invited account begins without spaces');
    ensure((await page.request.get(base + '/admin/accounts')).status() === 401, 'An invited account has no administrator access');

    await page.locator('#space-name').fill('受邀知识');
    await page.locator('#space-type').fill('semantic');
    await page.locator('#space-submit').click();
    await page.locator('#selected-space-name').getByText('受邀知识').waitFor();
    await page.locator('#key-label').fill('Temporary invited browser key');
    const issuance = page.waitForResponse(response => response.url().endsWith('/keys') && response.request().method() === 'POST');
    await page.locator('#key-submit').click();
    const issued = await issuance;
    ensure(issued.status() === 201, 'Invited account can issue a scoped key');
    const issuedBody = await issued.json();
    credential = issuedBody.api_key;
    issuedBody.api_key = '';
    await page.locator('#secret-dialog').waitFor({ state: 'visible' });
    ensure(await page.locator('#secret-output').inputValue() === credential, 'Scoped key is shown once');
    await page.locator('#close-secret').click();
    ensure(await page.locator('#secret-output').inputValue() === '', 'Scoped key dialog clears its value');
    const written = await page.request.post(base + '/memory/invited-browser-note', {
      headers: { 'X-Api-Key': credential }, data: { value: 'disposable invited UI proof', description: 'invitation browser proof' },
    });
    ensure(written.status() === 200, 'Invited scoped key can write its memory space');
    ensure((await page.request.get(base + '/memory/invited-browser-note', { headers: { 'X-Api-Key': credential } })).status() === 200, 'Invited scoped key can read its memory');

    await page.locator('#logout').click();
    await page.locator('#auth-section').waitFor({ state: 'visible' });
    ensure((await page.request.get(base + '/auth/me')).status() === 401, 'Logout invalidates the invitation-created session');
    ensure(await page.locator('#secret-output').inputValue() === '', 'Logout clears scoped-key secrets');
    ensure(await page.locator('#invitation-secret-output').inputValue() === '', 'Logout clears invitation secrets');
    const reused = await submitRegistration('reuse-browser-test@example.invalid', firstCode, 'Rejected Reuse');
    ensure(reused.status() === 400, 'Single-use invitation rejects reuse');
    await page.locator('#auth-status').getByText('无法注册', { exact: false }).waitFor();
    firstCode = '';

    await page.locator('#admin-details summary').click();
    const second = await createInvitation('Browser revoked invitation');
    secondCode = second.code;
    second.code = '';
    await page.locator('#admin-key').fill('local-ui-test-admin');
    await page.locator('#invitation-load').click();
    await page.locator('#invitation-status').getByText('已加载', { exact: false }).waitFor();
    const card = page.locator('#invitation-list .key-card').filter({ hasText: 'Browser revoked invitation' });
    await page.locator('#admin-key').fill('local-ui-test-admin');
    await card.getByRole('button', { name: '撤销邀请码', exact: true }).click();
    await page.locator('#confirm-action').click();
    await card.getByText('已撤销', { exact: true }).waitFor();
    ensure(await page.locator('#admin-key').inputValue() === '', 'Revocation clears administrator credentials');
    await page.locator('#admin-details summary').click();
    const revoked = await submitRegistration('revoked-browser-test@example.invalid', secondCode, 'Rejected Revocation');
    ensure(revoked.status() === 400, 'Revoked invitation rejects registration');
    await page.locator('#auth-status').getByText('无法注册', { exact: false }).waitFor();
    secondCode = '';

    // Invitation revocation does not disable an existing, successfully invited account.
    if (await page.locator('#registration-invitation-field').isVisible()) await page.locator('#auth-toggle').click();
    await page.locator('#auth-email').fill(firstEmail);
    await page.locator('#auth-password').fill(password);
    await page.locator('#auth-submit').click();
    await page.locator('#account-name').getByText('Invited Browser Test').waitFor();
    await page.locator('#selected-space-name').getByText('受邀知识').waitFor();
    ensure(await page.locator('#auth-password').inputValue() === '', 'Login clears its password');
    ensure((await page.request.get(base + '/memory/invited-browser-note', { headers: { 'X-Api-Key': credential } })).status() === 200, 'Existing scoped key remains valid after logout and login');
    credential = '';
    ensure(await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0), 'Registration and login do not persist bearer credentials');
    ensure(uiErrors.length === 0, 'No unhandled JavaScript errors');

    await page.locator('#admin-details summary').click();
    await page.locator('#admin-key').fill('local-ui-test-admin');
    await page.locator('#invitation-load').click();
    await page.locator('#invitation-status').getByText('已加载', { exact: false }).waitFor();
    await page.screenshot({ path: 'validation/invitation-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Invitation page does not overflow mobile viewport');
    await page.locator('#admin-invitation-form').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'validation/invitation-mobile.png' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#logout').click();
    await page.locator('#auth-section').waitFor({ state: 'visible' });
    ensure((await page.request.get(base + '/auth/me')).status() === 401, 'Final logout invalidates the session');
    return {
      passed: true,
      flows: ['administrator invitation creation and clearing', 'invitation signup', 'empty initial spaces', 'space and scoped key creation', 'memory access', 'logout and login', 'single-use reuse rejection', 'invitation revocation rejection'],
      desktop: true, mobile: true, javascriptErrors: uiErrors.length,
    };
  } finally { firstCode = ''; secondCode = ''; credential = ''; }
}
